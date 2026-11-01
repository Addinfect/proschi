import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';

/**
 * The account's synced diagrams and their saved versions, in memory with the
 * backend's rules (backend/src/versions.ts), for versions.accounts.e2e.ts.
 */

interface Version {
  tag: string;
  seq: number;
  note: string | null;
  createdAt: number;
  size: number;
  sha256: string;
  name: string;
  source: string;
  imports: Record<string, string> | null;
}

const sha = (source: string, imports: Record<string, string> | null) =>
  createHash('sha256')
    .update(JSON.stringify([source, Object.entries(imports ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))]))
    .digest('hex');

/** A version as the list and the save answer it: without its content. */
const infoOf = ({ tag, seq, note, createdAt, size, sha256 }: Version) => ({ tag, seq, note, createdAt, size, sha256 });

export class Account {
  docs = new Map<string, { id: string; name: string; source: string; imports: Record<string, string> | null; version: number; updatedAt: number; deletedAt: null }>();
  versions = new Map<string, Version[]>();
  /** Tags deleted per diagram: never reusable. */
  deleted = new Map<string, Set<string>>();
  resolves: string[] = [];
  private seq = 0;

  /** A version saved earlier, of a diagram named `name`. */
  seed(id: string, name: string, tag: string, source: string, imports: Record<string, string> | null = null) {
    if (!this.docs.has(id)) this.docs.set(id, { id, name, source, imports, version: 1, updatedAt: 1, deletedAt: null });
    const list = this.versions.get(id) ?? [];
    list.unshift({ tag, seq: ++this.seq, note: null, createdAt: Date.UTC(2026, 9, 1), size: source.length, sha256: sha(source, imports), name, source, imports });
    this.versions.set(id, list);
  }

  async mock(page: Page) {
    await page.route(
      (url) => url.pathname.startsWith('/api/me/documents') || url.pathname.startsWith('/api/me/versions'),
      async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const parts = url.pathname.split('/').map(decodeURIComponent);
        const method = request.method();
        if (url.pathname === '/api/me/versions/resolve') {
          const name = url.searchParams.get('name')!;
          const tag = url.searchParams.get('tag')!;
          this.resolves.push(`${name}:${tag}`);
          const base = name.replace(/\.proschi$/, '');
          const doc = [...this.docs.values()].find((d) => d.name === base || d.name === `${base}.proschi`);
          const list = doc ? this.versions.get(doc.id) ?? [] : [];
          const v = tag === 'latest' ? list[0] : list.find((x) => x.tag === tag);
          if (!doc || !v) return route.fulfill({ status: 404, json: { error: 'not_found' } });
          return route.fulfill({ json: { documentId: doc.id, name: doc.name, tag: v.tag, seq: v.seq, sha256: v.sha256, source: v.source, imports: v.imports } });
        }
        if (url.pathname === '/api/me/documents') return route.fulfill({ json: { documents: [...this.docs.values()], cursor: 0, limit: 5, used: this.docs.size } });
        const id = parts[4];
        const doc = this.docs.get(id);
        if (parts[5] !== 'versions') {
          // PUT /api/me/documents/<id>. No test here deletes a diagram, so anything else (a DELETE: a diagram lost) fails loudly.
          if (method !== 'PUT') throw new Error(`Unexpected ${method} ${url.pathname}${url.search}`);
          const body = request.postDataJSON() as { name: string; source: string; imports: Record<string, string> | null; baseVersion: number };
          const saved = { id, name: body.name, source: body.source, imports: body.imports, version: (doc?.version ?? 0) + 1, updatedAt: Date.now(), deletedAt: null };
          this.docs.set(id, saved);
          return route.fulfill({ json: { document: saved } });
        }
        if (!doc) return route.fulfill({ status: 404, json: { error: 'not_found' } });
        const list = this.versions.get(id) ?? [];
        const tag = parts[6];
        if (method === 'GET' && !tag) return route.fulfill({ json: { versions: list.map(infoOf), limit: 20 } });
        if (method === 'GET') {
          const v = tag === 'latest' ? list[0] : list.find((x) => x.tag === tag);
          return v ? route.fulfill({ json: { version: { ...v, documentId: id } } }) : route.fulfill({ status: 404, json: { error: 'not_found' } });
        }
        if (method === 'DELETE') {
          this.versions.set(id, list.filter((v) => v.tag !== tag));
          this.deleted.set(id, (this.deleted.get(id) ?? new Set()).add(tag));
          return route.fulfill({ status: 204 });
        }
        if (method !== 'POST') throw new Error(`Unexpected ${method} ${url.pathname}`);
        const body = request.postDataJSON() as { tag: string; note?: string; documentVersion: number };
        if (body.documentVersion !== doc.version) return route.fulfill({ status: 409, json: { error: 'stale', message: 'Sync first', documentVersion: doc.version } });
        if (list.some((v) => v.tag === body.tag) || this.deleted.get(id)?.has(body.tag)) return route.fulfill({ status: 409, json: { error: 'tag_taken', message: 'Taken' } });
        const v: Version = {
          tag: body.tag,
          seq: ++this.seq,
          note: body.note ?? null,
          createdAt: Date.now(),
          size: doc.source.length,
          sha256: sha(doc.source, doc.imports),
          name: doc.name,
          source: doc.source,
          imports: doc.imports,
        };
        this.versions.set(id, [v, ...list]);
        return route.fulfill({ status: 201, json: { version: infoOf(v) } });
      },
    );
  }
}

export const ORDERS = 'title "Orders"\n\napi "Orders API" [REST API]\ndb "Orders DB" [Postgres]\napi -> db\n';

/** This browser holds `docs`, the first one open. */
export async function seed(page: Page, docs: { id: string; fileName: string; source: string }[]) {
  await page.addInitScript((list) => {
    localStorage.setItem('proschi.docs', JSON.stringify({ docs: list.map((d) => ({ ...d, updatedAt: '2026-10-01T00:00:00.000Z' })), currentId: list[0].id }));
  }, docs);
}
