import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLANS } from '../src/plans';
import { canonicalForm, type Version, type VersionMeta } from '../src/versions';
import { call, resetDatabase, signedInUser } from './helpers';

/** Immutable diagram versions: /api/me/documents/<id>/versions and /api/me/versions/resolve. */

const put = (token: string, id: string, body: Record<string, unknown>) => call(`/api/me/documents/${id}`, { method: 'PUT', token, body });
const tag = (token: string, id: string, body: Record<string, unknown>) => call(`/api/me/documents/${id}/versions`, { method: 'POST', token, body });

async function hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A saved document; returns its version. */
async function save(token: string, id: string, source: string, baseVersion = 0, name = `${id}.proschi`, imports?: Record<string, string>): Promise<number> {
  const response = await put(token, id, { name, source, baseVersion, ...(imports ? { imports } : {}) });
  expect(response.status).toBe(200);
  return ((await response.json()) as { document: { version: number } }).document.version;
}

async function created(response: Response): Promise<VersionMeta> {
  expect(response.status).toBe(201);
  return ((await response.json()) as { version: VersionMeta }).version;
}

async function get(token: string, id: string, t: string): Promise<Response> {
  return call(`/api/me/documents/${id}/versions/${t}`, { token });
}

async function body(response: Response): Promise<Version> {
  expect(response.status).toBe(200);
  return ((await response.json()) as { version: Version }).version;
}

describe('diagram versions', () => {
  beforeEach(resetDatabase);
  afterEach(() => {
    delete PLANS.team;
  });

  it('need a session, and refuse changes from another site', async () => {
    expect((await tag('', 'd', { tag: 'v1', documentVersion: 1 })).status).toBe(401);
    expect((await call('/api/me/documents/d/versions')).status).toBe(401);
    expect((await call('/api/me/versions/resolve?name=d&tag=latest')).status).toBe(401);
    const { token } = await signedInUser();
    await save(token, 'd', 'a');
    const evil = await call('/api/me/documents/d/versions', { method: 'POST', token, body: { tag: 'v1', documentVersion: 1 }, headers: { Origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
  });

  it('snapshot the stored document, with a canonical sha256', async () => {
    const { token } = await signedInUser();
    const imports = { 'z.proschi': 'service Z', 'a.proschi': 'service A ✓' };
    const v = await save(token, 'd', 'title "Ü"\n', 0, 'shop.proschi', imports);
    const meta = await created(await tag(token, 'd', { tag: '2026-11-01', note: 'Before the rewrite', documentVersion: v }));
    const canonical = JSON.stringify(['title "Ü"\n', [['a.proschi', 'service A ✓'], ['z.proschi', 'service Z']]]);
    expect(canonicalForm('title "Ü"\n', imports)).toBe(canonical);
    expect(meta).toEqual({
      tag: '2026-11-01',
      seq: 1,
      note: 'Before the rewrite',
      createdAt: expect.any(Number),
      size: new TextEncoder().encode('title "Ü"\nservice Zservice A ✓').length,
      sha256: await hex(canonical),
    });
    expect(canonicalForm('x', null)).toBe('["x",[]]');

    // The draft moves on; the version does not.
    await save(token, 'd', 'changed', v, 'renamed.proschi');
    const got = await body(await get(token, 'd', '2026-11-01'));
    expect(got).toEqual({ ...meta, documentId: 'd', name: 'shop.proschi', source: 'title "Ü"\n', imports });
    expect(await body(await get(token, 'd', 'latest'))).toEqual(got);
  });

  it('cannot be changed: there is no route to', async () => {
    const { token } = await signedInUser();
    const v = await save(token, 'd', 'a');
    await created(await tag(token, 'd', { tag: 'v1', documentVersion: v }));
    for (const method of ['PUT', 'PATCH', 'POST']) {
      const response = await call('/api/me/documents/d/versions/v1', { method, token, body: { source: 'evil' } });
      expect(response.status).toBe(404);
    }
    expect((await body(await get(token, 'd', 'v1'))).source).toBe('a');
  });

  it('check the tag and note', async () => {
    const { token } = await signedInUser();
    const v = await save(token, 'd', 'a');
    for (const bad of ['', 'latest', '-x', '.x', 'a b', 'a/b', 'x'.repeat(65), 'é', 3]) {
      const response = await tag(token, 'd', { tag: bad, documentVersion: v });
      expect(response.status, String(bad)).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'bad_tag' });
    }
    expect((await tag(token, 'd', { tag: 'v1', note: 'x'.repeat(281), documentVersion: v })).status).toBe(400);
    expect((await tag(token, 'd', { tag: 'v1', note: 1, documentVersion: v })).status).toBe(400);
    expect((await tag(token, 'd', { tag: 'v1' })).status).toBe(400);
    expect((await tag(token, 'd', { tag: 'v1', documentVersion: 0 })).status).toBe(400);
    expect((await tag(token, 'bad id!', { tag: 'v1', documentVersion: 1 })).status).toBe(400);
    expect((await created(await tag(token, 'd', { tag: 'x'.repeat(64), note: 'x'.repeat(280), documentVersion: v }))).seq).toBe(1);
    expect((await created(await tag(token, 'd', { tag: 'Latest', note: '  ', documentVersion: v }))).note).toBeNull();
    expect((await created(await tag(token, 'd', { tag: 'v1.0_rc-2', documentVersion: v }))).seq).toBe(3);
  });

  it('keep tags unique per document and case-sensitive, never reused after a delete', async () => {
    const { token } = await signedInUser();
    const v = await save(token, 'd', 'a');
    await save(token, 'e', 'b');
    await created(await tag(token, 'd', { tag: 'v1', documentVersion: v }));
    const taken = await tag(token, 'd', { tag: 'v1', documentVersion: v });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: 'tag_taken' });
    // Another case, or another document, is another tag.
    await created(await tag(token, 'd', { tag: 'V1', documentVersion: v }));
    await created(await tag(token, 'e', { tag: 'v1', documentVersion: 1 }));

    expect((await call('/api/me/documents/d/versions/v1', { method: 'DELETE', token })).status).toBe(204);
    expect((await get(token, 'd', 'v1')).status).toBe(404);
    expect(await (await tag(token, 'd', { tag: 'v1', documentVersion: v })).json()).toMatchObject({ error: 'tag_taken' });
    // Its content is gone, not just hidden.
    const row = await env.DB.prepare("SELECT source, sha256, deleted_at FROM document_versions WHERE document_id = 'd' AND tag = 'v1'").first<{ source: string; sha256: string; deleted_at: number }>();
    expect(row).toMatchObject({ source: '', sha256: '', deleted_at: expect.any(Number) });
    // Deleting again, or a tag never there, is fine; `latest` is not a version's own tag.
    expect((await call('/api/me/documents/d/versions/v1', { method: 'DELETE', token })).status).toBe(204);
    expect((await call('/api/me/documents/d/versions/nope', { method: 'DELETE', token })).status).toBe(204);
    expect((await call('/api/me/documents/d/versions/latest', { method: 'DELETE', token })).status).toBe(400);
    expect((await call('/api/me/documents/missing/versions/v1', { method: 'DELETE', token })).status).toBe(404);
  });

  it('list newest first, with `latest` the highest live seq', async () => {
    const { token } = await signedInUser();
    let v = await save(token, 'd', 'one');
    expect((await get(token, 'd', 'latest')).status).toBe(404);
    await created(await tag(token, 'd', { tag: 'a', documentVersion: v }));
    v = await save(token, 'd', 'two', v);
    await created(await tag(token, 'd', { tag: 'b', documentVersion: v }));
    v = await save(token, 'd', 'three', v);
    await created(await tag(token, 'd', { tag: 'c', documentVersion: v }));
    // The draft is never `latest`.
    await save(token, 'd', 'draft', v);

    const listed = await call('/api/me/documents/d/versions', { token });
    expect(listed.status).toBe(200);
    const { versions, limit } = (await listed.json()) as { versions: VersionMeta[]; limit: number };
    expect(versions.map((x) => [x.tag, x.seq])).toEqual([['c', 3], ['b', 2], ['a', 1]]);
    expect(limit).toBe(20);
    expect((await body(await get(token, 'd', 'latest'))).source).toBe('three');

    // Deleting the latest makes the one before it latest; a new one never reuses a seq.
    await call('/api/me/documents/d/versions/c', { method: 'DELETE', token });
    expect(await body(await get(token, 'd', 'latest'))).toMatchObject({ tag: 'b', seq: 2, source: 'two' });
    const next = await created(await tag(token, 'd', { tag: 'd', documentVersion: v + 1 }));
    expect(next.seq).toBe(4);
    expect(await body(await get(token, 'd', 'latest'))).toMatchObject({ tag: 'd', source: 'draft' });
    expect((await get(token, 'd', 'bad tag')).status).toBe(404);
    expect((await call('/api/me/documents/nope/versions', { token })).status).toBe(404);
  });

  it('refuse a stale snapshot, so the client syncs first', async () => {
    const { token } = await signedInUser();
    const v1 = await save(token, 'd', 'one');
    await save(token, 'd', 'two', v1);
    const stale = await tag(token, 'd', { tag: 'v1', documentVersion: v1 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'stale', documentVersion: 2 });
    expect((await tag(token, 'd', { tag: 'v1', documentVersion: 9 })).status).toBe(409);
    expect((await created(await tag(token, 'd', { tag: 'v1', documentVersion: 2 }))).seq).toBe(1);
    expect((await tag(token, 'missing', { tag: 'v1', documentVersion: 1 })).status).toBe(404);
  });

  it("are limited per document by the account's plan, deleted ones not counted", async () => {
    PLANS.team = { documents: 5, versionsPerDocument: 2, documentBytes: 64 * 1024 };
    const { id, token } = await signedInUser();
    await env.DB.prepare("UPDATE users SET plan = 'team' WHERE id = ?").bind(id).run();
    const v = await save(token, 'd', 'a');
    await save(token, 'e', 'b');
    await created(await tag(token, 'd', { tag: 'a', documentVersion: v }));
    await created(await tag(token, 'd', { tag: 'b', documentVersion: v }));
    const full = await tag(token, 'd', { tag: 'c', documentVersion: v });
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ error: 'version_limit', limit: 2, used: 2 });
    // Per document.
    await created(await tag(token, 'e', { tag: 'a', documentVersion: 1 }));
    expect(await (await call('/api/me/documents/d/versions', { token })).json()).toMatchObject({ limit: 2 });
    await call('/api/me/documents/d/versions/a', { method: 'DELETE', token });
    expect((await created(await tag(token, 'd', { tag: 'c', documentVersion: v }))).seq).toBe(3);
  });

  it('are kept apart per user', async () => {
    const a = await signedInUser();
    const b = await signedInUser();
    await save(a.token, 'd', 'secret');
    await created(await tag(a.token, 'd', { tag: 'v1', documentVersion: 1 }));
    expect((await get(b.token, 'd', 'v1')).status).toBe(404);
    expect((await call('/api/me/documents/d/versions', { token: b.token })).status).toBe(404);
    expect((await call('/api/me/versions/resolve?name=d.proschi&tag=v1', { token: b.token })).status).toBe(404);
    expect((await call('/api/me/documents/d/versions/v1', { method: 'DELETE', token: b.token })).status).toBe(404);
    expect((await body(await get(a.token, 'd', 'v1'))).source).toBe('secret');
  });

  it('resolve by document name and tag, in the account only', async () => {
    const { token } = await signedInUser();
    const v = await save(token, 'd1', 'payments v1', 0, 'payments.proschi', { 'lib.proschi': 'x' });
    const meta = await created(await tag(token, 'd1', { tag: '2026-11-01', documentVersion: v }));
    await save(token, 'd1', 'payments draft', v, 'payments.proschi');
    const resolve = (name: string, t: string) => call(`/api/me/versions/resolve?name=${encodeURIComponent(name)}&tag=${encodeURIComponent(t)}`, { token });

    const expected = { documentId: 'd1', name: 'payments.proschi', tag: '2026-11-01', seq: 1, sha256: meta.sha256, source: 'payments v1', imports: { 'lib.proschi': 'x' } };
    const exact = await resolve('payments.proschi', '2026-11-01');
    expect(exact.status).toBe(200);
    expect(exact.headers.get('Cache-Control')).toBe('no-store');
    expect(await exact.json()).toEqual(expected);
    // Without the extension, and as latest.
    expect(await (await resolve('payments', 'latest')).json()).toEqual(expected);

    expect((await resolve('payments', 'nope')).status).toBe(404);
    expect((await resolve('Payments', 'latest')).status).toBe(404);
    expect((await resolve('other', 'latest')).status).toBe(404);
    expect((await resolve('payments', 'bad tag')).status).toBe(400);
    expect((await call('/api/me/versions/resolve?tag=latest', { token })).status).toBe(400);

    // Two live diagrams of that name: ambiguous. A deleted one does not count.
    await save(token, 'd2', 'other', 0, 'payments.proschi');
    const ambiguous = await resolve('payments.proschi', 'latest');
    expect(ambiguous.status).toBe(409);
    expect(await ambiguous.json()).toMatchObject({ error: 'ambiguous_name', documentIds: ['d1', 'd2'] });
    expect((await resolve('payments', 'latest')).status).toBe(409);
    await call('/api/me/documents/d2', { method: 'DELETE', token });
    expect(await (await resolve('payments', 'latest')).json()).toEqual(expected);
  });

  it('resolve x and x.proschi to a diagram stored as either, and call both at once ambiguous', async () => {
    const { token } = await signedInUser();
    const resolve = async (name: string) => {
      const r = await call(`/api/me/versions/resolve?name=${encodeURIComponent(name)}&tag=latest`, { token });
      return { status: r.status, body: (await r.json()) as { documentId?: string; error?: string; documentIds?: string[] } };
    };
    // Only `x`.
    await created(await tag(token, 'a', { tag: 'v1', documentVersion: await save(token, 'a', 'plain', 0, 'x') }));
    expect(await resolve('x')).toMatchObject({ status: 200, body: { documentId: 'a' } });
    expect(await resolve('x.proschi')).toMatchObject({ status: 200, body: { documentId: 'a' } });
    // Only `y.proschi`.
    await created(await tag(token, 'b', { tag: 'v1', documentVersion: await save(token, 'b', 'ext', 0, 'y.proschi') }));
    expect(await resolve('y')).toMatchObject({ status: 200, body: { documentId: 'b' } });
    expect(await resolve('y.proschi')).toMatchObject({ status: 200, body: { documentId: 'b' } });
    // `x` next to `x.proschi`: ambiguous, whichever form is asked for.
    await save(token, 'c', 'ext', 0, 'x.proschi');
    for (const name of ['x', 'x.proschi']) expect(await resolve(name)).toMatchObject({ status: 409, body: { error: 'ambiguous_name', documentIds: ['a', 'c'] } });
    // One `.proschi` comes off, no more; nothing left is a bad name.
    expect((await resolve('x.proschi.proschi')).status).toBe(404);
    expect((await resolve('.proschi')).status).toBe(400);
  });

  it('go with their document, its tombstone and the account', async () => {
    const { id, token } = await signedInUser();
    const count = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM document_versions WHERE user_id = ?').bind(id).first<{ n: number }>())?.n;
    await save(token, 'd', 'a');
    await save(token, 'e', 'b');
    await created(await tag(token, 'd', { tag: 'v1', documentVersion: 1 }));
    await created(await tag(token, 'd', { tag: 'v2', documentVersion: 1 }));
    await call('/api/me/documents/d/versions/v2', { method: 'DELETE', token });
    await created(await tag(token, 'e', { tag: 'v1', documentVersion: 1 }));
    expect(await count()).toBe(3);

    // In "Download my data", tombstones included.
    const exported = (await (await call('/api/me/export', { token })).json()) as { documentVersions: { documentId: string; tag: string; deletedAt: number | null; source: string }[]; user: { plan: string } };
    expect(exported.user.plan).toBe('free');
    expect(exported.documentVersions.map((x) => [x.documentId, x.tag, x.deletedAt === null, x.source])).toEqual([
      ['d', 'v1', true, 'a'],
      ['d', 'v2', false, ''],
      ['e', 'v1', true, 'b'],
    ]);

    // A document's delete (a tombstone) deletes its versions, tags too; restoring it starts over.
    expect((await call('/api/me/documents/d', { method: 'DELETE', token })).status).toBe(200);
    expect(await count()).toBe(1);
    await save(token, 'd', 'again', 2);
    expect((await created(await tag(token, 'd', { tag: 'v2', documentVersion: 3 }))).seq).toBe(1);
    // "Delete my cloud copies".
    expect((await call('/api/me/documents', { method: 'DELETE', token })).status).toBe(200);
    expect(await count()).toBe(0);

    await save(token, 'f', 'c');
    await created(await tag(token, 'f', { tag: 'v1', documentVersion: 1 }));
    expect((await call('/api/me', { method: 'DELETE', token })).status).toBe(204);
    expect(await count()).toBe(0);
  });

  it('work with an app bearer token', async () => {
    const { id, token } = await signedInUser();
    await save(token, 'd', 'a');
    const bearer = 'bearer-token-for-versions';
    const { sha256 } = await import('../src/crypto');
    await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at, kind, family_id) VALUES (?, ?, 4000000000, 0, 'app_access', 'f')")
      .bind(await sha256(bearer), id)
      .run();
    expect((await call('/api/me/documents/d/versions', { method: 'POST', bearer, body: { tag: 'v1', documentVersion: 1 } })).status).toBe(201);
    expect((await call('/api/me/versions/resolve?name=d&tag=v1', { bearer })).status).toBe(200);
    expect((await call('/api/me/limits', { bearer })).status).toBe(200);
  });
});
