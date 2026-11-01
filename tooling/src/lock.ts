/**
 * `proschi.lock` pins every remote import (git and https) to the bytes it
 * was first synced with; `.proschi/cache/` holds those bytes, named by their
 * sha256. Both live at the project root. Only `proschi imports sync` writes
 * them; every other command reads remote imports from here and never touches
 * the network.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CACHE_DIR, HASH, LOCK_FILE, parseLock, remoteError, type Lock } from './lockFormat';

export { CACHE_DIR, LOCK_FILE, cloudKey, emptyLock, gitKey, lockedHash, parseLock, remoteError, type CloudLock, type GitLock, type Lock } from './lockFormat';

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Reads the project's lockfile: undefined when there is none (parseLock checks it). */
export function readLock(root: string): Lock | undefined {
  const file = join(root, LOCK_FILE);
  return existsSync(file) ? parseLock(readFileSync(file, 'utf8')) : undefined;
}

const sorted = <T>(o: Record<string, T>, map: (v: T) => unknown = (v) => v) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, map(o[k])]));

/**
 * The lockfile's text: keys sorted, so it diffs well and the same imports
 * always give the same file. `cloud` is left out when empty, so lockfiles
 * without cloud imports stay as they were.
 */
export function formatLock(lock: Lock): string {
  const cloud = Object.keys(lock.cloud).length
    ? { cloud: sorted(lock.cloud, (e) => ({ tag: e.tag, seq: e.seq, sha256: e.sha256, ...(e.source ? { source: e.source } : {}), files: sorted(e.files) })) }
    : {};
  return JSON.stringify({ version: 1, git: sorted(lock.git, (e) => ({ commit: e.commit, files: sorted(e.files) })), https: sorted(lock.https), ...cloud }, null, 2) + '\n';
}

export function writeLock(root: string, lock: Lock): void {
  writeFileSync(join(root, LOCK_FILE), formatLock(lock));
}

const cacheFile = (root: string, hash: string) => join(root, CACHE_DIR, hash);

/** Cached bytes with this sha256: undefined when not cached; an ImportError when the copy was altered. */
export function readCached(root: string, hash: string, spec: string): Buffer | undefined {
  if (!HASH.test(hash)) return undefined;
  const file = cacheFile(root, hash);
  if (!existsSync(file)) return undefined;
  const bytes = readFileSync(file);
  if (sha256(bytes) !== hash) throw remoteError.altered(spec);
  return bytes;
}

/** Stores bytes in the cache under their sha256, which it returns. */
export function writeCached(root: string, bytes: Uint8Array): string {
  const hash = sha256(bytes);
  const dir = join(root, CACHE_DIR);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${hash}.${process.pid}.tmp`);
  writeFileSync(tmp, bytes);
  renameSync(tmp, cacheFile(root, hash));
  return hash;
}
