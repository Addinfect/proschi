/**
 * `proschi imports sync [--frozen]`: the only command that touches the
 * network. It walks the import graph of the given files, downloads their
 * git and https imports into the cache, and pins each to the commit and
 * sha256 it was first seen with in proschi.lock (trust on first use). With
 * --frozen (for CI) the lock must already hold every import, unchanged.
 */
import { readFileSync } from 'node:fs';
import { ImportError, isRemoteSpec, parseRemoteSpec } from '../../frontend/src/dsl/imports';
import { GitScratch, defaultGitUrl, fetchHttps, type Fetch } from './fetchers';
import { MAX_IMPORT_DEPTH, displayPath, fileResolver, projectRoot } from './imports';
import { LOCK_FILE, emptyLock, formatLock, gitKey, readCached, readLock, sha256, writeCached, writeLock, type Lock } from './lock';
import { parse } from './proschi';

export const IMPORTS_USAGE = `  proschi imports sync [--frozen] [<file|dir>...]`;

export const IMPORTS_HELP = `imports sync
        Downloads the git: and https:// imports of the files (default: the
        current folder) into .proschi/cache and pins them in proschi.lock.
        No other command uses the network. --frozen fails instead of
        changing proschi.lock (for CI).`;

export interface SyncOptions {
  frozen?: boolean;
  fetch?: Fetch;
  /** Where git fetches a repository from (tests point it at a local bare repository). */
  gitUrl?: (repo: string) => string;
}

export interface SyncResult {
  root: string;
  lock: Lock;
  errors: string[];
  /** Whether proschi.lock was written. */
  written: boolean;
}

const staleLock = (what: string) => new ImportError(`${LOCK_FILE} is out of date: ${what}; run proschi imports sync and commit ${LOCK_FILE}`);

export async function syncImports(entries: string[], { frozen = false, fetch, gitUrl = defaultGitUrl }: SyncOptions = {}): Promise<SyncResult> {
  const roots = [...new Set(entries.map((e) => projectRoot(e)))];
  if (roots.length !== 1) {
    const errors = roots.length ? [`The files belong to different project roots (${roots.map((r) => displayPath(r)).join(', ')}); sync each separately`] : ['No .proschi files to sync'];
    return { root: roots[0] ?? '', lock: emptyLock(), errors, written: false };
  }
  const [root] = roots;
  const lock = emptyLock();
  let old: Lock | undefined;
  try {
    old = readLock(root);
  } catch (e) {
    return { root, lock, errors: [(e as Error).message], written: false };
  }
  if (frozen && !old) return { root, lock, errors: [`${LOCK_FILE} is missing; run proschi imports sync and commit it`], written: false };

  const texts = new Map<string, string>();
  const failed = new Map<string, string>();
  const scratches = new Map<string, GitScratch>();
  const commits = new Map<string, string>();

  /** The bytes of a remote file: from the cache when the lock pins it, else downloaded and checked against the lock. */
  const obtain = async (spec: string): Promise<Buffer> => {
    const remote = parseRemoteSpec(spec)!;
    const cached = (hash: string | undefined) => {
      try {
        return hash ? readCached(root, hash, spec) : undefined;
      } catch {
        return undefined; // An altered cache copy is downloaded again.
      }
    };
    const changed = (pin: string) =>
      new ImportError(`'${spec}' does not match its sha256 in ${LOCK_FILE} (${pin}); its content changed. If that is expected, delete its entry from ${LOCK_FILE} and sync again`);
    if (remote.kind === 'https') {
      const pinned = old?.https[remote.url];
      if (frozen && !pinned) throw staleLock(`'${spec}' is not locked`);
      let bytes = cached(pinned);
      if (!bytes) {
        bytes = await fetchHttps(remote.url, fetch);
        if (pinned && sha256(bytes) !== pinned) throw changed(`sha256 ${pinned.slice(0, 12)}`);
        writeCached(root, bytes);
      }
      lock.https[remote.url] = sha256(bytes);
      return bytes;
    }
    const key = gitKey(remote.repo, remote.ref);
    const pinnedEntry = old?.git[key];
    const pinnedHash = pinnedEntry?.files[remote.path];
    if (frozen && !pinnedHash) throw staleLock(`'${spec}' is not locked`);
    let bytes = cached(pinnedHash);
    let commit = pinnedEntry?.commit;
    if (!bytes) {
      let scratch = scratches.get(remote.repo);
      if (!scratch) scratches.set(remote.repo, (scratch = new GitScratch()));
      if (!commits.has(key)) {
        // A locked ref stays on its locked commit; a new one is resolved once.
        const got = scratch.fetch(gitUrl(remote.repo), commit ?? remote.ref);
        if (commit && got !== commit) throw new ImportError(`'${spec}': fetching the locked commit ${commit} gave ${got}`);
        if (/^[0-9a-f]{40}$/.test(remote.ref) && got !== remote.ref) throw new ImportError(`'${spec}': the ref is a commit but resolved to ${got}`);
        commits.set(key, got);
      }
      commit = commits.get(key)!;
      bytes = scratch.read(commit, remote.path, spec);
      if (pinnedHash && sha256(bytes) !== pinnedHash) throw changed(`commit ${commit.slice(0, 12)}`);
      writeCached(root, bytes);
    }
    lock.git[key] ??= { commit: commit!, files: {} };
    lock.git[key].files[remote.path] = sha256(bytes);
    return bytes;
  };

  let errors: string[] = [];
  try {
    for (let round = 0; round <= MAX_IMPORT_DEPTH + 1; round++) {
      const pending = new Set<string>();
      const found = new Set<string>();
      for (const entry of entries) {
        const resolver = fileResolver({
          entry,
          remote: (spec) => {
            if (texts.has(spec)) return texts.get(spec);
            if (!failed.has(spec)) pending.add(spec);
            return undefined;
          },
        });
        parse(readFileSync(entry, 'utf8'), { path: entry, resolve: resolver });
        for (const [where, message] of resolver.errors) {
          const from = where.split('\0')[0] || entry;
          found.add(`${isRemoteSpec(from) ? from : displayPath(from)}: ${message}`);
        }
      }
      if (pending.size === 0) {
        errors = [...found];
        break;
      }
      for (const spec of pending) {
        try {
          texts.set(spec, (await obtain(spec)).toString('utf8'));
        } catch (e) {
          if (!(e instanceof ImportError)) throw e;
          failed.set(spec, e.message);
        }
      }
    }
  } finally {
    for (const scratch of scratches.values()) scratch.dispose();
  }
  errors.push(...failed.values());
  if (errors.length) return { root, lock, errors, written: false };

  const text = formatLock(lock);
  if (old && text !== formatLock(old)) {
    if (frozen) return { root, lock, errors: [staleLock('it locks imports that are no longer used').message], written: false };
  }
  const write = !frozen && (old ? text !== formatLock(old) : Object.keys(lock.git).length + Object.keys(lock.https).length > 0);
  if (write) writeLock(root, lock);
  return { root, lock, errors, written: write };
}

export async function runImports(
  args: string[],
  collectFiles: (paths: string[]) => string[],
  out: (s: string) => void,
  err: (s: string) => void,
  options: Omit<SyncOptions, 'frozen'> = {},
): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== 'sync') {
    err(`Usage:\n${IMPORTS_USAGE}`);
    return 2;
  }
  let frozen = false;
  const paths: string[] = [];
  for (const arg of rest) {
    if (arg === '--frozen') frozen = true;
    else if (arg.startsWith('-')) {
      err(`Unknown option ${arg}\n\nUsage:\n${IMPORTS_USAGE}`);
      return 2;
    } else paths.push(arg);
  }
  let files: string[];
  try {
    files = collectFiles(paths.length ? paths : ['.']);
  } catch (e) {
    err(String((e as Error).message));
    return 2;
  }
  const result = await syncImports(files, { ...options, frozen });
  if (result.errors.length) {
    err(result.errors.map((e) => `error: ${e}`).join('\n'));
    return 1;
  }
  const sources = Object.keys(result.lock.git).length + Object.keys(result.lock.https).length;
  const filesLocked = Object.values(result.lock.git).reduce((n, g) => n + Object.keys(g.files).length, 0) + Object.keys(result.lock.https).length;
  const lockPath = displayPath(`${result.root}/${LOCK_FILE}`);
  if (!sources) out('No git: or https:// imports to sync');
  else out(`${filesLocked} remote file(s) from ${sources} source(s) ${result.written ? 'locked in' : 'match'} ${lockPath}`);
  return 0;
}
