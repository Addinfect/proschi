import type { ImportResolver } from './types';

/**
 * Helpers for resolving `import` paths without a file system, e.g. against
 * documents saved in the browser or files carried in a share link, and the
 * syntax of remote import sources (`git:` and `https://`), shared with the CLI.
 */

/**
 * Why an import could not be resolved. Resolvers throw it, and the parser
 * reports its message on the import line. Recognised by `name`, so no
 * `instanceof` across bundles is needed.
 */
export class ImportError extends Error {
  override name = 'ImportError';
}

/** `git:<host>/<org>/<repo>//<path/in/repo>@<ref>`: one file of a git repository at a tag, branch or commit. */
export interface GitSpec {
  kind: 'git';
  /** `<host>/<org>/<repo>`, possibly with more path segments (GitLab subgroups). */
  repo: string;
  /** The file's path inside the repository, `/`-separated, without `.` or `..`. */
  path: string;
  ref: string;
}

/** An `https://` URL. */
export interface HttpsSpec {
  kind: 'https';
  url: string;
}

export type RemoteSpec = GitSpec | HttpsSpec;

/** Longest import spec accepted, remote or local. */
const MAX_SPEC_LENGTH = 1024;
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._ +-]*$/;
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::\d{1,5})?$/;
const REPO_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
/** A safe subset of git ref names (git check-ref-format), never starting with '-'. */
const REF = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;
/** `scheme:` at the start, two or more letters, so `C:\…` reads as a (Windows) absolute path. */
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]+):/;

/** Whether an import names a remote source (or tries to: any `scheme:` prefix). */
export function isRemoteSpec(spec: string): boolean {
  return SCHEME.test(spec);
}

/** Whether a local import path is absolute (`/x`, `\x`, `C:\x`, `C:/x`). */
function isAbsolutePath(path: string): boolean {
  return /^[\\/]/.test(path) || /^[A-Za-z]:/.test(path);
}

function checkRef(ref: string, spec: string) {
  if (
    !REF.test(ref) ||
    ref.length > 200 ||
    ref.includes('..') ||
    ref.includes('//') ||
    ref.endsWith('/') ||
    ref.endsWith('.') ||
    ref.endsWith('.lock') ||
    ref.split('/').some((p) => p.startsWith('.'))
  ) {
    throw new ImportError(`'${spec}' has an invalid ref '${ref}'; use a tag, branch or commit made of letters, digits, '.', '_', '-' and '/'`);
  }
}

/** Splits a repository path into segments, refusing anything but plain names. */
function repoPathSegments(path: string, spec: string): string[] {
  const parts = path.split('/');
  if (!path || parts.some((p) => !SEGMENT.test(p) || p === '.' || p === '..')) {
    throw new ImportError(`'${spec}' has an invalid path in the repository; use a relative path like dir/file.proschi, without '..'`);
  }
  return parts;
}

/**
 * Parses a remote import spec, throwing an ImportError that says what is
 * wrong with it. Returns undefined for local paths.
 */
export function parseRemoteSpec(spec: string): RemoteSpec | undefined {
  const scheme = SCHEME.exec(spec)?.[1].toLowerCase();
  if (!scheme) return undefined;
  if (spec.length > MAX_SPEC_LENGTH) throw new ImportError(`Import source is longer than ${MAX_SPEC_LENGTH} characters`);
  if (/[\s\0\\]/.test(spec)) throw new ImportError(`'${spec}' contains whitespace or a backslash`);
  if (scheme === 'git') {
    const body = spec.slice(4);
    const at = body.lastIndexOf('@');
    const split = body.indexOf('//');
    if (at === -1 || split === -1 || split > at) {
      throw new ImportError(`'${spec}' is not a git source; write git:<host>/<org>/<repo>//<path/in/repo>@<ref>`);
    }
    const repo = body.slice(0, split);
    const path = body.slice(split + 2, at);
    const ref = body.slice(at + 1);
    const [host, ...names] = repo.split('/');
    if (!HOST.test(host) || names.length < 2 || names.some((n) => !REPO_SEGMENT.test(n) || n.endsWith('.'))) {
      throw new ImportError(`'${spec}' names an invalid repository '${repo}'; write <host>/<org>/<repo>`);
    }
    repoPathSegments(path, spec);
    checkRef(ref, spec);
    return { kind: 'git', repo, path, ref };
  }
  if (scheme === 'http') throw new ImportError(`'${spec}' uses http://; only https:// imports are allowed`);
  if (scheme !== 'https') throw new ImportError(`'${spec}' is not a supported import source; use a relative path, git: or https://`);
  let url: URL;
  try {
    url = new URL(spec);
  } catch {
    throw new ImportError(`'${spec}' is not a valid URL`);
  }
  if (url.username || url.password) throw new ImportError(`'${spec}' contains credentials; git and https imports use your own credentials, never ones in the diagram`);
  if (url.hash) throw new ImportError(`'${spec}' has a #fragment; remove it`);
  if (!HOST.test(url.host)) throw new ImportError(`'${spec}' has an invalid host`);
  return { kind: 'https', url: url.href };
}

/** The canonical spelling of a remote spec, which is also the path the import resolves to. */
export function formatRemoteSpec(spec: RemoteSpec): string {
  return spec.kind === 'git' ? `git:${spec.repo}//${spec.path}@${spec.ref}` : spec.url;
}

/**
 * Where `importPath`, imported from `fromPath`, points: a remote spec in its
 * canonical form, a path within the same remote source when `fromPath` is
 * remote, or a `/`-separated path relative to the root document's directory.
 * Throws an ImportError for absolute paths, malformed or insecure remote
 * specs, and relative paths that leave a remote source.
 *
 * Leading `..` that climbs above the root document is kept: the browser only
 * knows documents by name, so such keys are virtual. Readers of a real file
 * system must confine them to the project (tooling/src/imports.ts).
 */
export function resolveImportPath(fromPath: string | undefined, importPath: string): string {
  if (importPath.includes('\0')) throw new ImportError(`'${importPath.replace(/\0/g, '')}' contains a NUL character`);
  const remote = parseRemoteSpec(importPath);
  if (remote) return formatRemoteSpec(remote);
  if (isAbsolutePath(importPath)) throw new ImportError(`'${importPath}' is an absolute path; imports must be relative to the importing file`);
  const from = fromPath && isRemoteSpec(fromPath) ? parseRemoteSpec(fromPath) : undefined;
  if (from?.kind === 'git') {
    const parts = from.path.split('/').slice(0, -1);
    for (const part of importPath.split('/')) {
      if (part === '' || part === '.') continue;
      if (part !== '..') parts.push(part);
      else if (parts.length > 0) parts.pop();
      else throw new ImportError(`'${importPath}' leaves the repository ${from.repo}`);
    }
    repoPathSegments(parts.join('/'), importPath);
    return formatRemoteSpec({ ...from, path: parts.join('/') });
  }
  if (from?.kind === 'https') {
    const base = new URL(from.url);
    const url = new URL(importPath, base);
    if (url.origin !== base.origin) throw new ImportError(`'${importPath}' leaves ${base.origin}`);
    return formatRemoteSpec(parseRemoteSpec(url.href)!);
  }
  const parts = !fromPath ? [] : fromPath.split('/').slice(0, -1);
  for (const part of importPath.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' && parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

/** Like resolveImportPath, but undefined where that throws. */
export function joinImportPath(fromPath: string | undefined, importPath: string): string | undefined {
  try {
    return resolveImportPath(fromPath, importPath);
  } catch (e) {
    if (e instanceof ImportError) return undefined;
    throw e;
  }
}

/** Whether `key` may name a file in an imports map: a valid remote spec or a relative path. */
export function isImportKey(key: string): boolean {
  if (key.includes('\0')) return false;
  if (!isRemoteSpec(key)) return !isAbsolutePath(key);
  try {
    return resolveImportPath(undefined, key) === key;
  } catch {
    return false;
  }
}

/**
 * A resolver over a map of path → source. A local path that is not in the map
 * falls back to the one file with the same name, if exactly one exists, since
 * files opened in the browser only know their own name. Remote sources only
 * match their exact spec (as bundled by `proschi share-link`).
 */
export function mapResolver(files: Record<string, string>): ImportResolver {
  const paths = Object.keys(files).filter((p) => !isRemoteSpec(p));
  return (importPath, fromPath) => {
    const path = resolveImportPath(fromPath, importPath);
    if (Object.prototype.hasOwnProperty.call(files, path)) return { path, source: files[path] };
    if (isRemoteSpec(path)) return undefined;
    const name = path.split('/').pop();
    const sameName = paths.filter((p) => p.split('/').pop() === name);
    return sameName.length === 1 ? { path: sameName[0], source: files[sameName[0]] } : undefined;
  };
}
