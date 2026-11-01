/**
 * Saved versions of the signed-in user's diagrams (docs/design/versions-and-cloud.md),
 * read through the versions API (backend/README.md, "Diagram versions"),
 * with every answer checked: a version's content must hash to the sha256
 * the API reports for it.
 */
import { createHash } from 'node:crypto';
import { LATEST_TAG, VERSION_TAG, cloudDocumentName, isImportKey, parseRemoteSpec, type CloudSpec } from '../../frontend/src/dsl/imports';
import { ApiError, type ApiClient } from './api';

export interface ResolvedVersion {
  documentId: string;
  /** The diagram's file name when the version was saved. */
  name: string;
  tag: string;
  seq: number;
  sha256: string;
  source: string;
  /** The files saved with it, by path (or remote spec); empty when none. */
  imports: Record<string, string>;
}

export interface VersionInfo {
  tag: string;
  seq: number;
  note: string | null;
  createdAt: number;
  size: number;
  sha256: string;
}

/** How a version's content is hashed: lowercase hex SHA-256 of `JSON.stringify([source, sorted import pairs])` (backend/src/versions.ts). */
export function canonicalSha256(source: string, imports: Record<string, string> | null | undefined): string {
  const pairs = Object.entries(imports ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify([source, pairs]), 'utf8').digest('hex');
}

/** A diagram name as `cloud:` names it, checked; an Error that says what is allowed. */
export function cloudName(name: string): CloudSpec {
  if (name.includes(':') || name.includes('//')) throw new Error(`'${name}' is not a diagram name; write it without cloud: or a tag, e.g. orders`);
  const spec = parseRemoteSpec(`cloud:${name}`);
  if (spec?.kind !== 'cloud') throw new Error(`'${name}' is not a diagram name`);
  return spec;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const HASH = /^[0-9a-f]{64}$/;

/** What `GET /api/me/versions/resolve` gives for `spec`'s diagram at `tag`, checked against its sha256. */
export async function resolveVersion(client: ApiClient, spec: CloudSpec, tag: string): Promise<ResolvedVersion> {
  const where = `cloud:${spec.name}:${tag}`;
  let body: unknown;
  try {
    body = await client.get(`/api/me/versions/resolve?name=${encodeURIComponent(cloudDocumentName(spec))}&tag=${encodeURIComponent(tag)}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) throw new Error(`'${where}': your account has no diagram ${cloudDocumentName(spec)} with ${tag === LATEST_TAG ? 'a saved version' : `a version tagged ${tag}`}`);
    if (e instanceof ApiError && e.code === 'ambiguous_name') throw new Error(`'${where}': several of your diagrams are named ${cloudDocumentName(spec)}; rename one`);
    if (e instanceof ApiError) throw new Error(`'${where}': ${e.message}`);
    throw e;
  }
  const b = isRecord(body) ? body : {};
  const imports = b.imports ?? {};
  const valid =
    typeof b.documentId === 'string' &&
    typeof b.name === 'string' &&
    typeof b.tag === 'string' &&
    VERSION_TAG.test(b.tag) &&
    b.tag !== LATEST_TAG &&
    (tag === LATEST_TAG || b.tag === tag) &&
    Number.isSafeInteger(b.seq) &&
    (b.seq as number) > 0 &&
    typeof b.sha256 === 'string' &&
    HASH.test(b.sha256) &&
    typeof b.source === 'string' &&
    isRecord(imports) &&
    Object.entries(imports).every(([k, v]) => typeof v === 'string' && isImportKey(k));
  if (!valid) throw new Error(`'${where}': the versions API gave an answer that is not a version`);
  const version = { ...(b as unknown as ResolvedVersion), imports: imports as Record<string, string> };
  if (canonicalSha256(version.source, version.imports) !== version.sha256) {
    throw new Error(`'${where}': the content does not match its sha256 ${version.sha256.slice(0, 12)}; try again`);
  }
  return {
    documentId: version.documentId,
    name: version.name,
    tag: version.tag,
    seq: version.seq,
    sha256: version.sha256,
    source: version.source,
    imports: version.imports,
  };
}

/** The live diagram `spec` names (stored as `<name>` or `<name>.proschi`, like the resolve route matches; both at once is ambiguous). */
export async function findDocument(client: ApiClient, spec: CloudSpec): Promise<{ id: string; name: string }> {
  const body = await client.get('/api/me/documents');
  const documents = isRecord(body) && Array.isArray(body.documents) ? body.documents : [];
  const wanted = cloudDocumentName(spec);
  const matches = documents.filter(
    (d): d is { id: string; name: string } => isRecord(d) && typeof d.id === 'string' && !d.deletedAt && (d.name === spec.name || d.name === wanted),
  );
  if (matches.length === 0) throw new Error(`Your account has no diagram named ${wanted}`);
  if (matches.length > 1) throw new Error(`Several of your diagrams are named ${wanted}; rename one`);
  return { id: matches[0].id, name: matches[0].name };
}

/** A diagram's saved versions, newest first, and how many it may keep. */
export async function listVersions(client: ApiClient, documentId: string): Promise<{ versions: VersionInfo[]; limit: number | undefined }> {
  const body = await client.get(`/api/me/documents/${encodeURIComponent(documentId)}/versions`);
  const list = isRecord(body) && Array.isArray(body.versions) ? body.versions : undefined;
  const ok = (v: unknown): v is VersionInfo =>
    isRecord(v) && typeof v.tag === 'string' && Number.isSafeInteger(v.seq) && typeof v.createdAt === 'number' && typeof v.size === 'number' && typeof v.sha256 === 'string';
  if (!list || !list.every(ok)) throw new Error('The versions API gave an answer that is not a list of versions');
  const limit = isRecord(body) && typeof body.limit === 'number' ? body.limit : undefined;
  return { versions: list.map((v) => ({ tag: v.tag, seq: v.seq, note: typeof v.note === 'string' ? v.note : null, createdAt: v.createdAt, size: v.size, sha256: v.sha256 })), limit };
}
