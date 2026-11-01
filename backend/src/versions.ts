import type { Ctx } from './context';
import { checkId, limited } from './documents';
import { HttpError, json, readJson } from './http';
import { limitsFor } from './plans';

/**
 * Immutable versions of the user's synced diagrams (backend/README.md
 * "Diagram versions"). A version is a snapshot of the stored document (its
 * name, source and imports) under a tag the user picks, e.g. 2026-11-01.
 * There is no way to change one: only to delete it, which keeps a tombstone
 * (tag and seq, content cleared) so the tag is never reused and `latest`,
 * the live version with the highest seq, never goes back to an older one by
 * surprise. Deleting the document or the account deletes every version.
 *
 *   POST   /api/me/documents/<id>/versions {tag, note?, documentVersion}
 *   GET    /api/me/documents/<id>/versions
 *   GET    /api/me/documents/<id>/versions/<tag | latest>
 *   DELETE /api/me/documents/<id>/versions/<tag>
 *   GET    /api/me/versions/resolve?name=<document name>&tag=<tag | latest>
 */

export const LATEST = 'latest';
export const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MAX_NOTE = 280;
const MAX_NAME = 512;
const NO_STORE = { 'Cache-Control': 'no-store' };
const encoder = new TextEncoder();

export interface VersionMeta {
  tag: string;
  seq: number;
  note: string | null;
  /** Unix milliseconds. */
  createdAt: number;
  /** UTF-8 bytes of the source plus every import's source. */
  size: number;
  /** Hex SHA-256 of the canonical form (canonicalForm). */
  sha256: string;
}

export interface Version extends VersionMeta {
  documentId: string;
  name: string;
  source: string;
  imports: Record<string, string> | null;
}

interface Row {
  document_id: string;
  seq: number;
  tag: string;
  name: string;
  source: string;
  imports: string | null;
  note: string | null;
  size: number;
  sha256: string;
  created_at: number;
  deleted_at: number | null;
}

const META = 'seq, tag, note, size, sha256, created_at';
const ALL = 'document_id, seq, tag, name, source, imports, note, size, sha256, created_at, deleted_at';

const metaOf = (row: Pick<Row, 'seq' | 'tag' | 'note' | 'size' | 'sha256' | 'created_at'>): VersionMeta => ({
  tag: row.tag,
  seq: row.seq,
  note: row.note,
  createdAt: row.created_at,
  size: row.size,
  sha256: row.sha256,
});

const versionOf = (row: Row): Version => ({
  ...metaOf(row),
  documentId: row.document_id,
  name: row.name,
  source: row.source,
  imports: row.imports === null ? null : (JSON.parse(row.imports) as Record<string, string>),
});

/**
 * The string a version's sha256 is taken of: `JSON.stringify([source,
 * imports])`, the imports as [path, source] pairs sorted by path (UTF-16
 * code unit order, as `<` compares strings), `[]` without any.
 */
export function canonicalForm(source: string, imports: Record<string, string> | null): string {
  const pairs = Object.entries(imports ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([source, pairs]);
}

async function hexSha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

function sizeOf(source: string, imports: Record<string, string> | null): number {
  let size = encoder.encode(source).length;
  for (const text of Object.values(imports ?? {})) size += encoder.encode(text).length;
  return size;
}

function badTag(): Response {
  return json(
    { error: 'bad_tag', message: 'A tag is 1 to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit, and not "latest"' },
    400,
    NO_STORE,
  );
}

/** The user's live document `id`; 404 for one deleted or never there. */
async function liveDocument(DB: D1Database, userId: string, id: string): Promise<{ version: number }> {
  const row = await DB.prepare('SELECT version FROM documents WHERE user_id = ? AND id = ? AND deleted_at IS NULL').bind(userId, id).first<{ version: number }>();
  if (!row) throw new HttpError(404, 'No such diagram');
  return row;
}

/** The live version `tag` (or the latest) of a document; null without one. */
async function findVersion(DB: D1Database, userId: string, documentId: string, tag: string): Promise<Row | null> {
  return tag === LATEST
    ? DB.prepare(`SELECT ${ALL} FROM document_versions WHERE user_id = ? AND document_id = ? AND deleted_at IS NULL ORDER BY seq DESC LIMIT 1`)
        .bind(userId, documentId)
        .first<Row>()
    : DB.prepare(`SELECT ${ALL} FROM document_versions WHERE user_id = ? AND document_id = ? AND tag = ? AND deleted_at IS NULL`)
        .bind(userId, documentId, tag)
        .first<Row>();
}

/**
 * POST /api/me/documents/<id>/versions {tag, note?, documentVersion}:
 * snapshots the stored document. `documentVersion` is the document version
 * the client has: 409 `stale` when the stored one is another, so the client
 * syncs first and never tags what it has not seen.
 */
export async function createVersion(request: Request, ctx: Ctx, rawId: string): Promise<Response> {
  const id = checkId(rawId);
  const user = await limited(request, ctx);
  const body = await readJson(request, 4096);
  const { tag, note, documentVersion } = body;
  if (typeof tag !== 'string' || !TAG.test(tag) || tag === LATEST) return badTag();
  if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > MAX_NOTE)) throw new HttpError(400, `note must be at most ${MAX_NOTE} characters`);
  if (typeof documentVersion !== 'number' || !Number.isSafeInteger(documentVersion) || documentVersion < 1) {
    throw new HttpError(400, 'documentVersion must be the version of the diagram the client has');
  }
  const noteText = typeof note === 'string' && note.trim() ? note : null;
  const { DB } = ctx.env;
  const stale = (version: number) =>
    json({ error: 'stale', message: 'The diagram changed since; sync it, then tag it again', documentVersion: version }, 409, NO_STORE);

  const doc = await DB.prepare('SELECT name, source, imports, version FROM documents WHERE user_id = ? AND id = ? AND deleted_at IS NULL')
    .bind(user.id, id)
    .first<{ name: string; source: string; imports: string | null; version: number }>();
  if (!doc) throw new HttpError(404, 'No such diagram');
  if (doc.version !== documentVersion) return stale(doc.version);
  const imports = doc.imports === null ? null : (JSON.parse(doc.imports) as Record<string, string>);
  const limit = limitsFor(user.plan).versionsPerDocument;
  // One statement: the document still at that version, room under the limit, the next seq, the tag free (UNIQUE).
  const row = await DB.prepare(
    `INSERT INTO document_versions (user_id, document_id, seq, tag, name, source, imports, note, size, sha256, created_at)
     SELECT ?1, ?2, COALESCE((SELECT MAX(seq) FROM document_versions WHERE user_id = ?1 AND document_id = ?2), 0) + 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
     WHERE EXISTS (SELECT 1 FROM documents WHERE user_id = ?1 AND id = ?2 AND version = ?11 AND deleted_at IS NULL)
       AND (SELECT COUNT(*) FROM document_versions WHERE user_id = ?1 AND document_id = ?2 AND deleted_at IS NULL) < ?12
     ON CONFLICT DO NOTHING
     RETURNING ${META}`,
  )
    .bind(user.id, id, tag, doc.name, doc.source, doc.imports, noteText, sizeOf(doc.source, imports), await hexSha256(canonicalForm(doc.source, imports)), Date.now(), documentVersion, limit)
    .first<Row>();
  if (row) return json({ version: metaOf(row) }, 201, NO_STORE);

  const taken = await DB.prepare('SELECT 1 FROM document_versions WHERE user_id = ? AND document_id = ? AND tag = ?').bind(user.id, id, tag).first();
  if (taken) return json({ error: 'tag_taken', message: `This diagram already has (or had) a version tagged ${tag}` }, 409, NO_STORE);
  const now = await liveDocument(DB, user.id, id);
  if (now.version !== documentVersion) return stale(now.version);
  const used = await DB.prepare('SELECT COUNT(*) AS n FROM document_versions WHERE user_id = ? AND document_id = ? AND deleted_at IS NULL')
    .bind(user.id, id)
    .first<{ n: number }>();
  return json(
    { error: 'version_limit', message: `A diagram keeps at most ${limit} versions; delete one to tag another`, limit, used: used?.n ?? 0 },
    409,
    NO_STORE,
  );
}

/** GET /api/me/documents/<id>/versions: the live versions, newest first, and how many a diagram may keep. */
export async function listVersions(request: Request, ctx: Ctx, rawId: string): Promise<Response> {
  const id = checkId(rawId);
  const user = await limited(request, ctx);
  await liveDocument(ctx.env.DB, user.id, id);
  const { results } = await ctx.env.DB.prepare(`SELECT ${META} FROM document_versions WHERE user_id = ? AND document_id = ? AND deleted_at IS NULL ORDER BY seq DESC`)
    .bind(user.id, id)
    .all<Row>();
  return json({ versions: results.map(metaOf), limit: limitsFor(user.plan).versionsPerDocument }, 200, NO_STORE);
}

/** GET /api/me/documents/<id>/versions/<tag | latest>: a version with its content. */
export async function getVersion(request: Request, ctx: Ctx, rawId: string, tag: string): Promise<Response> {
  const id = checkId(rawId);
  const user = await limited(request, ctx);
  await liveDocument(ctx.env.DB, user.id, id);
  const row = tag === LATEST || TAG.test(tag) ? await findVersion(ctx.env.DB, user.id, id, tag) : null;
  if (!row) throw new HttpError(404, tag === LATEST ? 'This diagram has no versions' : 'No such version');
  return json({ version: versionOf(row) }, 200, NO_STORE);
}

/**
 * DELETE /api/me/documents/<id>/versions/<tag>: deletes a version's content
 * at once; its tag stays taken. 204, also for a tag the diagram does not have.
 */
export async function deleteVersion(request: Request, ctx: Ctx, rawId: string, tag: string): Promise<Response> {
  const id = checkId(rawId);
  const user = await limited(request, ctx);
  if (tag === LATEST) return json({ error: 'bad_tag', message: 'Delete a version by its own tag, not "latest"' }, 400, NO_STORE);
  await liveDocument(ctx.env.DB, user.id, id);
  await ctx.env.DB.prepare(
    `UPDATE document_versions SET name = '', source = '', imports = NULL, note = NULL, size = 0, sha256 = '', deleted_at = ?4
     WHERE user_id = ?1 AND document_id = ?2 AND tag = ?3 AND deleted_at IS NULL`,
  )
    .bind(user.id, id, tag, Date.now())
    .run();
  return new Response(null, { status: 204 });
}

/**
 * GET /api/me/versions/resolve?name=&tag=: a cloud reference, resolved in
 * the signed-in account only. One trailing `.proschi` is taken off `name`;
 * a live document matches when its name is what is left, with or without
 * `.proschi`. 409 `ambiguous_name` when more than one document matches
 * (`x` next to `x.proschi`, whichever form is asked for), 404 when none
 * does or it has no such version.
 */
export async function resolveVersion(request: Request, ctx: Ctx): Promise<Response> {
  const user = await limited(request, ctx);
  const params = new URL(request.url).searchParams;
  const name = params.get('name') ?? '';
  const base = name.endsWith('.proschi') ? name.slice(0, -'.proschi'.length) : name;
  const tag = params.get('tag') ?? '';
  if (!base || name.length > MAX_NAME) throw new HttpError(400, `name must be a diagram's name, 1 to ${MAX_NAME} characters`);
  if (tag !== LATEST && !TAG.test(tag)) return badTag();
  const { DB } = ctx.env;
  const { results } = await DB.prepare(
    "SELECT id FROM documents WHERE user_id = ?1 AND deleted_at IS NULL AND (name = ?2 OR name = ?2 || '.proschi') ORDER BY id",
  )
    .bind(user.id, base)
    .all<{ id: string }>();
  if (results.length === 0) throw new HttpError(404, `No diagram named ${name} in your account`);
  if (results.length > 1) {
    return json(
      { error: 'ambiguous_name', message: `${results.length} diagrams in your account are named ${name}; rename all but one`, documentIds: results.map((r) => r.id) },
      409,
      NO_STORE,
    );
  }
  const row = await findVersion(DB, user.id, results[0].id, tag);
  if (!row) throw new HttpError(404, tag === LATEST ? `${name} has no versions` : `${name} has no version ${tag}`);
  const v = versionOf(row);
  return json({ documentId: v.documentId, name: v.name, tag: v.tag, seq: v.seq, sha256: v.sha256, source: v.source, imports: v.imports }, 200, NO_STORE);
}

/** The versions in "Download my data", with their content; deleted ones as tombstones (tag, seq, deletedAt). */
export async function exportVersions(DB: D1Database, userId: string): Promise<(Version & { deletedAt: number | null })[]> {
  const { results } = await DB.prepare(`SELECT ${ALL} FROM document_versions WHERE user_id = ? ORDER BY document_id, seq`).bind(userId).all<Row>();
  return results.map((row) => ({ ...versionOf(row), deletedAt: row.deleted_at }));
}
