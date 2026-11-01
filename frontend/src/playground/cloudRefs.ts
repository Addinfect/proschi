import { ImportError, cloudDocumentName, cloudSpecsOf, isImportKey, isRemoteSpec, joinImportPath, parseRemoteSpec } from '../dsl/imports';
import type { ImportResolver } from '../dsl/types';

/**
 * `cloud:<name>:<tag>` sources in the editor (docs/design/versions-and-cloud.md,
 * V6): before the synchronous parse, the versions a diagram reads are fetched
 * from the signed-in account and added to the resolver's files. The parse
 * itself never fetches.
 */

/** GET /api/me/versions/resolve's answer. */
export interface ResolvedVersion {
  documentId: string;
  name: string;
  tag: string;
  seq: number;
  sha256: string;
  source: string;
  imports: Record<string, string> | null;
}

/** Fetches one version (`name` as cloudDocumentName gives it); throws an Error whose message says what went wrong. */
export type FetchVersion = (name: string, tag: string) => Promise<ResolvedVersion>;

export const SIGNED_OUT_MESSAGE = 'Sign in to use cloud: sources; they are versions saved in your Proschi account.';

/** The text a version's sha256 is of (canonicalForm in backend/src/versions.ts). */
export function canonicalForm(source: string, imports: Record<string, string> | null): string {
  const pairs = Object.entries(imports ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([source, pairs]);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whether a fetched version is the bytes its hash says. */
export async function verifyVersion(version: Pick<ResolvedVersion, 'source' | 'imports' | 'sha256'>): Promise<boolean> {
  return (await sha256Hex(canonicalForm(version.source, version.imports))) === version.sha256;
}

/**
 * The files a version adds to the resolver: its source under its spec, the
 * files saved with it under `<spec>//<path>`, and remote files it bundled
 * under their own spec.
 */
export function versionFiles(spec: string, version: Pick<ResolvedVersion, 'source' | 'imports'>): Record<string, string> {
  const files: Record<string, string> = { [spec]: version.source };
  for (const [path, source] of Object.entries(version.imports ?? {})) {
    const key = isRemoteSpec(path) ? path : `${spec}//${path}`;
    if (isImportKey(key) && !(key in files)) files[key] = source;
  }
  return files;
}

/** Fetched versions by canonical spec, for this page's session: a tag never changes; `latest` is asked again on refresh. */
export type VersionCache = Map<string, ResolvedVersion>;

export interface CloudFiles {
  /** Every file the fetched versions add, by key. */
  files: Record<string, string>;
  /** Why a spec could not be fetched, by canonical spec. */
  errors: Record<string, string>;
}

/**
 * Fetches the versions `source` reads, and the ones those read in turn, until
 * nothing new turns up. A spec already in `bundled` (a share link's files)
 * that cannot be fetched is not an error: the bundled copy is used.
 */
export async function fetchCloudFiles(
  source: string,
  { path, bundled = {} }: { path?: string; bundled?: Record<string, string> },
  fetchVersion: FetchVersion | null,
  cache: VersionCache,
): Promise<CloudFiles> {
  const files: Record<string, string> = {};
  const errors: Record<string, string> = {};
  const tried = new Set<string>();
  for (;;) {
    const fresh = cloudSpecsOf(source, { path, files: { ...bundled, ...files } }).filter((spec) => !tried.has(spec));
    if (fresh.length === 0) return { files, errors };
    await Promise.all(
      fresh.map(async (spec) => {
        tried.add(spec);
        try {
          const version = cache.get(spec) ?? (await fetchOne(spec, fetchVersion));
          cache.set(spec, version);
          Object.assign(files, versionFiles(spec, version));
        } catch (e) {
          if (!(spec in bundled)) errors[spec] = e instanceof Error ? e.message : String(e);
        }
      }),
    );
  }
}

async function fetchOne(spec: string, fetchVersion: FetchVersion | null): Promise<ResolvedVersion> {
  if (!fetchVersion) throw new Error(SIGNED_OUT_MESSAGE);
  const parsed = parseRemoteSpec(spec);
  if (parsed?.kind !== 'cloud') throw new Error(`'${spec}' is not a cloud source`);
  const version = await fetchVersion(cloudDocumentName(parsed), parsed.tag);
  if (!(await verifyVersion(version))) throw new Error(`${spec} does not match its checksum, so it was not used; reload to fetch it again.`);
  return version;
}

/**
 * A resolver that reports why a cloud source is missing (signed out, not
 * found, …) on its import line, and says it is still loading while it is.
 */
export function withCloudErrors(resolve: ImportResolver, errors: Record<string, string>, loading: boolean): ImportResolver {
  return (importPath, fromPath) => {
    const found = resolve(importPath, fromPath);
    if (found) return found;
    const resolved = joinImportPath(fromPath, importPath);
    const spec = resolved === undefined ? undefined : parseRemoteSpec(resolved);
    if (spec?.kind !== 'cloud' || spec.path) return found;
    const key = `cloud:${spec.name}:${spec.tag}`;
    if (errors[key]) throw new ImportError(errors[key]);
    if (loading) throw new ImportError(`Loading ${key} from your account…`);
    return found;
  };
}

/** The account's resolve endpoint, with the reasons it answers in words. */
export const fetchFromAccount: FetchVersion = async (name, tag) => {
  const spec = `cloud:${name.replace(/\.proschi$/, '')}:${tag}`;
  let response: Response;
  try {
    response = await fetch(`/api/me/versions/resolve?${new URLSearchParams({ name, tag })}`, { credentials: 'same-origin' });
  } catch {
    throw new Error(`Could not reach your account to load ${spec}; check the connection and reload.`);
  }
  if (response.ok) return (await response.json()) as ResolvedVersion;
  const data = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
  if (response.status === 401) throw new Error(SIGNED_OUT_MESSAGE);
  if (response.status === 404) {
    throw new Error(
      tag === 'latest'
        ? `${spec}: your account has no diagram named ${name} with a saved version. Save one under Diagrams → Versions.`
        : `${spec}: your account has no diagram named ${name} with a version '${tag}'.`,
    );
  }
  if (data.error === 'ambiguous_name') throw new Error(`${spec}: several diagrams in your account are named ${name.replace(/\.proschi$/, '')}; rename one of them.`);
  throw new Error(`Could not load ${spec}: ${data.message ?? data.error ?? `${response.status} ${response.statusText}`}`);
};
