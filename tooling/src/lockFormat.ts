/**
 * The `proschi.lock` format and the messages about remote imports, free of
 * Node so the Claude Code plugin's hooks module reads the lock and cache the
 * same way (lock.ts reads and writes them from Node).
 */
import { ImportError, LATEST_TAG, VERSION_TAG, formatRemoteSpec, parseRemoteSpec } from '../../frontend/src/dsl/imports';

export const LOCK_FILE = 'proschi.lock';
/** The cache folder at the project root; files in it are named by their sha256. */
export const CACHE_DIR = '.proschi/cache';

export interface GitLock {
  /** The commit the ref resolved to when it was first synced. */
  commit: string;
  /** sha256 (hex) of each file read from the repository, by path in the repository. */
  files: Record<string, string>;
}

/** A `cloud:` reference pinned to one saved version (docs/design/versions-and-cloud.md). */
export interface CloudLock {
  /** The tag the reference resolved to when it was first synced; never `latest`. */
  tag: string;
  /** The version's number within its diagram. */
  seq: number;
  /** The version's canonical sha256, as the versions API reports it. */
  sha256: string;
  /** sha256 (hex) of the diagram's source, when it is imported itself. */
  source?: string;
  /** sha256 (hex) of each file saved with the version that is imported (`cloud:<name>:<tag>//<path>`), by path. */
  files: Record<string, string>;
}

export interface Lock {
  version: 1;
  /** By `<host>/<org>/<repo>@<ref>`. */
  git: Record<string, GitLock>;
  /** sha256 (hex) by URL. */
  https: Record<string, string>;
  /** By `<name>:<tag>` as the import spells it, `latest` included. */
  cloud: Record<string, CloudLock>;
}

export const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export const emptyLock = (): Lock => ({ version: 1, git: {}, https: {}, cloud: {} });

/** The lock key of a git spec's repository and ref. */
export const gitKey = (repo: string, ref: string): string => `${repo}@${ref}`;

/** The lock key of a cloud spec's diagram and tag (`latest` stays `latest`: the entry says what it resolved to). */
export const cloudKey = (name: string, tag: string): string => `${name}:${tag}`;

/** Why a remote import cannot be read: everything but sync reads it from the lock and the cache. */
export const remoteError = {
  noLock: (spec: string) => new ImportError(`'${spec}' is a remote import and there is no ${LOCK_FILE}; run proschi imports sync`),
  notLocked: (spec: string) => (spec.startsWith('cloud:') ? remoteError.cloud(spec) : new ImportError(`'${spec}' is not in ${LOCK_FILE}; run proschi imports sync`)),
  /** A cloud version that is not pinned yet (docs/design/versions-and-cloud.md). */
  cloud: (spec: string) => new ImportError(`'${spec}' is a version in your Proschi account; run proschi imports sync to pin it (cloud sources need proschi login)`),
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
  const cloud = json.cloud ?? {};
  if (!isRecord(git) || !isRecord(https) || !isRecord(cloud)) throw invalid('"git", "https" and "cloud" must be objects');
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
  for (const [key, entry] of Object.entries(cloud)) {
    const hash = (v: unknown) => typeof v === 'string' && HASH.test(v);
    const valid =
      isCanonicalSpec(`cloud:${key}`, 'cloud') &&
      isRecord(entry) &&
      typeof entry.tag === 'string' &&
      VERSION_TAG.test(entry.tag) &&
      entry.tag !== LATEST_TAG &&
      Number.isSafeInteger(entry.seq) &&
      (entry.seq as number) > 0 &&
      hash(entry.sha256) &&
      (entry.source === undefined || hash(entry.source)) &&
      isRecord(entry.files) &&
      Object.entries(entry.files).every(([path, h]) => hash(h) && isCanonicalSpec(`cloud:${key}//${path}`, 'cloud'));
    if (!valid) throw invalid(`bad cloud entry '${key}'`);
    lock.cloud[key] = {
      tag: entry.tag as string,
      seq: entry.seq as number,
      sha256: entry.sha256 as string,
      ...(entry.source === undefined ? {} : { source: entry.source as string }),
      files: { ...(entry.files as Record<string, string>) },
    };
  }
  return lock;
}

/** Whether `spec` is a valid remote spec of that kind, spelled canonically. */
function isCanonicalSpec(spec: string, kind: 'cloud'): boolean {
  try {
    const remote = parseRemoteSpec(spec);
    return remote?.kind === kind && formatRemoteSpec(remote) === spec;
  } catch {
    return false;
  }
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
  if (remote?.kind === 'cloud') {
    const entry = lock.cloud[cloudKey(remote.name, remote.tag)];
    return remote.path === undefined ? entry?.source : entry?.files[remote.path];
  }
  return undefined;
}
