/**
 * The `proschi.lock` format and the messages about remote imports, free of
 * Node so the Claude Code plugin's hooks module reads the lock and cache the
 * same way (lock.ts reads and writes them from Node).
 */
import { ImportError, parseRemoteSpec } from '../../frontend/src/dsl/imports';

export const LOCK_FILE = 'proschi.lock';
/** The cache folder at the project root; files in it are named by their sha256. */
export const CACHE_DIR = '.proschi/cache';

export interface GitLock {
  /** The commit the ref resolved to when it was first synced. */
  commit: string;
  /** sha256 (hex) of each file read from the repository, by path in the repository. */
  files: Record<string, string>;
}

export interface Lock {
  version: 1;
  /** By `<host>/<org>/<repo>@<ref>`. */
  git: Record<string, GitLock>;
  /** sha256 (hex) by URL. */
  https: Record<string, string>;
}

export const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export const emptyLock = (): Lock => ({ version: 1, git: {}, https: {} });

/** The lock key of a git spec's repository and ref. */
export const gitKey = (repo: string, ref: string): string => `${repo}@${ref}`;

/** Why a remote import cannot be read: everything but sync reads it from the lock and the cache. */
export const remoteError = {
  noLock: (spec: string) => new ImportError(`'${spec}' is a remote import and there is no ${LOCK_FILE}; run proschi imports sync`),
  notLocked: (spec: string) => new ImportError(`'${spec}' is not in ${LOCK_FILE}; run proschi imports sync`),
  notCached: (spec: string) => new ImportError(`'${spec}' is not in the import cache (${CACHE_DIR}); run proschi imports sync`),
  altered: (spec: string) => new ImportError(`The cached copy of '${spec}' does not match its hash in ${LOCK_FILE}; run proschi imports sync`),
};

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The lockfile's text, checked. A lockfile comes in with pull requests like
 * any other file, so every value is checked before it is used as a path
 * (hashes name cache files).
 */
export function parseLock(text: string): Lock {
  const invalid = (why: string) => new ImportError(`Invalid ${LOCK_FILE}: ${why}; delete it and run proschi imports sync`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw invalid((e as Error).message);
  }
  if (!isRecord(json) || json.version !== 1) throw invalid('expected {"version": 1, …}');
  const lock = emptyLock();
  const git = json.git ?? {};
  const https = json.https ?? {};
  if (!isRecord(git) || !isRecord(https)) throw invalid('"git" and "https" must be objects');
  for (const [key, entry] of Object.entries(git)) {
    const at = key.lastIndexOf('@');
    const valid =
      at > 0 &&
      isRecord(entry) &&
      typeof entry.commit === 'string' &&
      COMMIT.test(entry.commit) &&
      isRecord(entry.files) &&
      Object.entries(entry.files).every(([path, hash]) => typeof hash === 'string' && HASH.test(hash) && isGitSpec(`git:${key.slice(0, at)}//${path}@${key.slice(at + 1)}`));
    if (!valid) throw invalid(`bad git entry '${key}'`);
    lock.git[key] = { commit: entry.commit as string, files: { ...(entry.files as Record<string, string>) } };
  }
  for (const [url, hash] of Object.entries(https)) {
    if (typeof hash !== 'string' || !HASH.test(hash) || parseRemoteSpec(url)?.kind !== 'https') throw invalid(`bad https entry '${url}'`);
    lock.https[url] = hash;
  }
  return lock;
}

function isGitSpec(spec: string): boolean {
  try {
    return parseRemoteSpec(spec)?.kind === 'git';
  } catch {
    return false;
  }
}

/** The sha256 the lock holds for a remote spec (canonical form), if any. */
export function lockedHash(lock: Lock, spec: string): string | undefined {
  const remote = parseRemoteSpec(spec);
  if (remote?.kind === 'git') return lock.git[gitKey(remote.repo, remote.ref)]?.files[remote.path];
  if (remote?.kind === 'https') return lock.https[remote.url];
  return undefined;
}
