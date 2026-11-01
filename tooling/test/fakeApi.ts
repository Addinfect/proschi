/**
 * A stand-in for proschi.app's API in tests: the token, versions and
 * documents routes, over a `fetch` function, so no test touches the network.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiClient } from '../src/api';
import { canonicalSha256 } from '../src/cloud';
import { CredentialStore } from '../src/credentials';

export const BASE = 'https://proschi.test';

export interface FakeVersion {
  tag: string;
  source: string;
  imports?: Record<string, string>;
  note?: string;
  /** Overrides the sha256 the API reports (to test a mismatch). */
  sha256?: string;
}

export interface FakeDocument {
  id: string;
  name: string;
  /** Oldest first; seq is the position + 1. */
  versions: FakeVersion[];
  deletedAt?: number;
}

export class FakeApi {
  documents: FakeDocument[] = [];
  /** Valid access tokens, and the refresh token each pair came with. */
  access = new Set<string>(['access-1']);
  refreshTokens = new Set<string>(['refresh-1']);
  calls: string[] = [];
  private issued = 1;

  readonly fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    if (u.origin !== BASE) throw new Error(`unexpected host ${u.origin}`);
    this.calls.push(`${init.method ?? 'GET'} ${u.pathname}${u.search}`);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === '/auth/token') {
      const body = JSON.parse(String(init.body));
      if (body.grant_type === 'refresh_token') {
        if (!this.refreshTokens.delete(body.refresh_token)) return json({ error: 'invalid_grant' }, 400);
        return json(this.issue());
      }
      if (body.grant_type === 'authorization_code') {
        if (body.code !== 'the-code' || typeof body.code_verifier !== 'string') return json({ error: 'invalid_grant' }, 400);
        return json(this.issue());
      }
      return json({ error: 'invalid_request' }, 400);
    }
    if (u.pathname === '/auth/revoke') {
      this.refreshTokens.delete(JSON.parse(String(init.body)).token);
      return json({});
    }
    const token = new Headers(init.headers).get('authorization')?.replace(/^Bearer /, '');
    if (!token || !this.access.has(token)) return new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer error="invalid_token"' } });
    if (u.pathname === '/api/me') return json({ user: { id: 'u1', displayName: 'Ada' } });
    if (u.pathname === '/api/me/documents') {
      return json({ documents: this.documents.map((d) => ({ id: d.id, name: d.name, source: '', imports: null, version: 1, updatedAt: 0, deletedAt: d.deletedAt ?? null })) });
    }
    if (u.pathname === '/api/me/versions/resolve') {
      const name = u.searchParams.get('name')!;
      const tag = u.searchParams.get('tag')!;
      const base = name.replace(/\.proschi$/, '');
      const docs = this.documents.filter((d) => !d.deletedAt && (d.name === base || d.name === `${base}.proschi`));
      if (docs.length > 1) return json({ error: 'ambiguous_name', message: 'ambiguous', documentIds: docs.map((d) => d.id) }, 409);
      const doc = docs[0];
      const seq = doc ? (tag === 'latest' ? doc.versions.length : doc.versions.findIndex((v) => v.tag === tag) + 1) : 0;
      if (!doc || seq < 1) return json({ error: 'not_found' }, 404);
      return json(this.version(doc, seq));
    }
    const list = /^\/api\/me\/documents\/([^/]+)\/versions$/.exec(u.pathname);
    if (list) {
      const doc = this.documents.find((d) => d.id === decodeURIComponent(list[1]));
      if (!doc) return json({ error: 'not_found' }, 404);
      const versions = doc.versions.map((_, i) => {
        const { documentId: _d, name: _n, source: _s, imports: _i, ...info } = this.version(doc, i + 1);
        return info;
      });
      return json({ versions: versions.reverse(), limit: 20 });
    }
    return json({ error: 'not_found' }, 404);
  };

  private issue() {
    this.issued++;
    const pair = { access_token: `access-${this.issued}`, token_type: 'Bearer', expires_in: 3600, refresh_token: `refresh-${this.issued}` };
    this.access.add(pair.access_token);
    this.refreshTokens.add(pair.refresh_token);
    return pair;
  }

  private version(doc: FakeDocument, seq: number) {
    const v = doc.versions[seq - 1];
    const imports = v.imports ?? null;
    return {
      documentId: doc.id,
      name: doc.name,
      tag: v.tag,
      seq,
      note: v.note ?? null,
      createdAt: Date.UTC(2026, 9, seq, 9, 30),
      size: Buffer.byteLength(v.source),
      sha256: v.sha256 ?? canonicalSha256(v.source, imports),
      source: v.source,
      imports,
    };
  }
}

/** A credentials file in a fresh temp folder, signed in to BASE unless `signedIn` is false. */
export function tempStore(signedIn = true): CredentialStore {
  const store = new CredentialStore(join(mkdtempSync(join(tmpdir(), 'proschi-cred-')), 'proschi', 'credentials.json'));
  if (signedIn) store.set(BASE, { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: Date.now() + 3_600_000 });
  return store;
}

export const fakeClient = (api: FakeApi, store = tempStore()) => new ApiClient({ base: BASE, store, fetch: api.fetch });
