/**
 * `proschi imports sync [--frozen]`: the only command that fetches imports
 * (and the only one that writes proschi.lock and the cache). It walks the
 * import graph of the given files, downloads their git, https and cloud
 * imports into the cache, and pins each to the commit, saved version and
 * sha256 it was first seen with in proschi.lock (trust on first use). With
 * --frozen (for CI) the lock must already hold every import, unchanged.
 * --update re-resolves `cloud:<name>` (latest) pins to the newest version.
 * (`proschi versions` also reads the account, but never writes the lock.)
 */
import { readFileSync } from 'node:fs';
import { ImportError, LATEST_TAG, isRemoteSpec, parseRemoteSpec, type CloudSpec } from '../../frontend/src/dsl/imports';
import { ApiClient } from './api';
import { resolveVersion, type ResolvedVersion } from './cloud';
import { DEFAULT_SITE, normalizeBase } from './credentials';
import { GitScratch, defaultGitUrl, fetchHttps, type Fetch } from './fetchers';
import { MAX_IMPORT_DEPTH, displayPath, fileResolver, projectRoot } from './imports';
import { LOCK_FILE, cloudKey, emptyLock, formatLock, gitKey, readCached, readLock, sha256, writeCached, writeLock, type Lock } from './lock';
import { parse } from './proschi';

export const IMPORTS_USAGE = `  proschi imports sync [--frozen | --update [<cloud:spec>...]] [--base <url>] [<file|dir>...]`;

export const IMPORTS_HELP = `imports sync
        Downloads the git:, https:// and cloud: imports of the files (default:
        the current folder) into .proschi/cache and pins them in proschi.lock:
        a git ref to its commit, cloud:<name> (latest) or cloud:<name>:<tag>
        to the version's tag, seq and sha256. A pinned import stays pinned;
        --update moves the given cloud:<name> imports (default: all of them)
        to their newest saved version (a concrete tag never moves). cloud:
        sources need proschi login (--base: the site, default
        ${DEFAULT_SITE}). No other command fetches imports. --frozen fails
        instead of changing proschi.lock (for CI).`;

export interface SyncOptions {
  frozen?: boolean;
  /** Re-resolve these cloud specs' `latest` pins (true: every one) instead of keeping them. */
  update?: true | string[];
  fetch?: Fetch;
  /** Where git fetches a repository from (tests point it at a local bare repository). */
  gitUrl?: (repo: string) => string;
  /** The signed-in account cloud: imports are read from (default: the tokens of proschi login for proschi.app). */
  api?: ApiClient;
}

export interface SyncResult {
  root: string;
  lock: Lock;
  errors: string[];
  /** Whether proschi.lock was written. */
  written: boolean;
  /** With --update: each re-resolved `latest` pin by lock key, and its tag before (undefined when new) and after. */
  updated: Record<string, { from?: string; to: string }>;
}

const staleLock = (what: string) => new ImportError(`${LOCK_FILE} is out of date: ${what}; run proschi imports sync and commit ${LOCK_FILE}`);

export async function syncImports(entries: string[], { frozen = false, update, fetch, gitUrl = defaultGitUrl, api }: SyncOptions = {}): Promise<SyncResult> {
  const updated: SyncResult['updated'] = {};
  const roots = [...new Set(entries.map((e) => projectRoot(e)))];
  if (roots.length !== 1) {
    const errors = roots.length ? [`The files belong to different project roots (${roots.map((r) => displayPath(r)).join(', ')}); sync each separately`] : ['No .proschi files to sync'];
    return { root: roots[0] ?? '', lock: emptyLock(), errors, written: false, updated };
  }
  const [root] = roots;
  const lock = emptyLock();
  const fail = (errors: string[]): SyncResult => ({ root, lock, errors, written: false, updated });
  if (frozen && update) return fail(['--update and --frozen cannot be used together']);
  // The lock keys --update re-resolves; a concrete tag never moves, so it is left out.
  let moving: Set<string> | true | undefined;
  const asked: string[] = [];
  if (update === true) moving = true;
  else if (update) {
    moving = new Set();
    for (const spec of update) {
      let remote;
      try {
        remote = parseRemoteSpec(spec);
      } catch (e) {
        return fail([(e as Error).message]);
      }
      if (remote?.kind !== 'cloud' || remote.path !== undefined) return fail([`--update takes cloud:<name> imports, not '${spec}'`]);
      const key = cloudKey(remote.name, remote.tag);
      asked.push(key);
      if (remote.tag === LATEST_TAG) moving.add(key);
    }
  }
  const moves = (key: string) => (moving === true ? key.endsWith(`:${LATEST_TAG}`) : !!moving?.has(key));
  let old: Lock | undefined;
  try {
    old = readLock(root);
  } catch (e) {
    return fail([(e as Error).message]);
  }
  if (frozen && !old) return fail([`${LOCK_FILE} is missing; run proschi imports sync and commit it`]);

  const texts = new Map<string, string>();
  const failed = new Map<string, string>();
  const scratches = new Map<string, GitScratch>();
  const commits = new Map<string, string>();
  const versions = new Map<string, Promise<ResolvedVersion>>();

  /** A saved version, fetched once per diagram and tag; every failure an ImportError. */
  const version = (spec: string, remote: CloudSpec, tag: string): Promise<ResolvedVersion> => {
    const key = cloudKey(remote.name, tag);
    if (!versions.has(key)) {
      const client = (api ??= new ApiClient({ base: DEFAULT_SITE }));
      const got = client.signedIn()
        ? resolveVersion(client, remote, tag).catch((e: Error) => {
            throw e instanceof ImportError ? e : new ImportError(e.message.startsWith("'cloud:") ? e.message : `'${spec}': ${e.message}`);
          })
        : Promise.reject(new ImportError(`'${spec}': cloud: sources need \`proschi login\``));
      got.catch(() => undefined);
      versions.set(key, got);
    }
    return versions.get(key)!;
  };

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
    if (remote.kind === 'cloud') {
      const key = cloudKey(remote.name, remote.tag);
      const pinned = moves(key) ? undefined : old?.cloud[key];
      const pinnedHash = remote.path === undefined ? pinned?.source : pinned?.files[remote.path];
      if (frozen && !pinnedHash) throw staleLock(`'${spec}' is not locked`);
      let bytes = cached(pinnedHash);
      let at = pinned;
      if (!bytes) {
        // A locked reference stays on its locked version; `latest` is resolved once.
        const got = await version(spec, remote, pinned?.tag ?? remote.tag);
        if (pinned && (got.sha256 !== pinned.sha256 || got.seq !== pinned.seq)) {
          throw changed(`version ${pinned.tag}, seq ${pinned.seq}, sha256 ${pinned.sha256.slice(0, 12)}`);
        }
        const text = remote.path === undefined ? got.source : got.imports[remote.path];
        if (text === undefined) throw new ImportError(`'${spec}': no file ${remote.path} is saved with cloud:${remote.name}:${got.tag}`);
        bytes = Buffer.from(text, 'utf8');
        if (pinnedHash && sha256(bytes) !== pinnedHash) throw changed(`version ${got.tag}`);
        writeCached(root, bytes);
        at = { tag: got.tag, seq: got.seq, sha256: got.sha256, files: {} };
        if (moves(key)) updated[key] = { from: old?.cloud[key]?.tag, to: got.tag };
      }
      const entry = (lock.cloud[key] ??= { tag: at!.tag, seq: at!.seq, sha256: at!.sha256, files: {} });
      if (remote.path === undefined) entry.source = sha256(bytes);
      else entry.files[remote.path] = sha256(bytes);
      return bytes;
    }
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
  for (const key of asked) if (!lock.cloud[key]) errors.push(`--update: 'cloud:${key}' is not imported by these files`);
  if (errors.length) return fail(errors);

  const text = formatLock(lock);
  if (old && text !== formatLock(old)) {
    if (frozen) return fail([staleLock('it locks imports that are no longer used').message]);
  }
  const write = !frozen && (old ? text !== formatLock(old) : lockedSources(lock) > 0);
  if (write) writeLock(root, lock);
  return { root, lock, errors, written: write, updated };
}

const lockedSources = (lock: Lock) => Object.keys(lock.git).length + Object.keys(lock.https).length + Object.keys(lock.cloud).length;
const lockedFiles = (lock: Lock) =>
  Object.values(lock.git).reduce((n, g) => n + Object.keys(g.files).length, 0) +
  Object.keys(lock.https).length +
  Object.values(lock.cloud).reduce((n, c) => n + Object.keys(c.files).length + (c.source ? 1 : 0), 0);

export async function runImports(
  args: string[],
  collectFiles: (paths: string[]) => string[],
  out: (s: string) => void,
  err: (s: string) => void,
  options: Omit<SyncOptions, 'frozen' | 'update'> = {},
): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== 'sync') {
    err(`Usage:\n${IMPORTS_USAGE}`);
    return 2;
  }
  let frozen = false;
  let update: true | string[] | undefined;
  let base: string | undefined;
  const paths: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--frozen') frozen = true;
    else if (arg === '--update') update ??= true;
    else if (update && arg.startsWith('cloud:')) update = [...(update === true ? [] : update), arg];
    else if (arg === '--base') {
      try {
        base = normalizeBase(rest[++i] ?? '');
      } catch (e) {
        err((e as Error).message);
        return 2;
      }
    } else if (arg.startsWith('-')) {
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
  const api = options.api ?? (base ? new ApiClient({ base }) : undefined);
  const result = await syncImports(files, { ...options, api, frozen, update });
  if (result.errors.length) {
    err(result.errors.map((e) => `error: ${e}`).join('\n'));
    return 1;
  }
  for (const [key, { from, to }] of Object.entries(result.updated)) out(from === to ? `cloud:${key}: ${to} (already the newest)` : `cloud:${key}: ${from ?? '(not pinned)'} -> ${to}`);
  const sources = lockedSources(result.lock);
  const filesLocked = lockedFiles(result.lock);
  const lockPath = displayPath(`${result.root}/${LOCK_FILE}`);
  if (!sources) out('No git:, https:// or cloud: imports to sync');
  else out(`${filesLocked} remote file(s) from ${sources} source(s) ${result.written ? 'locked in' : 'match'} ${lockPath}`);
  return 0;
}
