/**
 * The only code that touches the network, used by `proschi imports sync`
 * alone: reading files of git repositories with the system `git` (and the
 * user's own credentials), and https downloads.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImportError } from '../../frontend/src/dsl/imports';
import { MAX_IMPORT_BYTES } from './imports';

const GIT_TIMEOUT_MS = 120_000;
const HTTPS_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

/** The URL git fetches `<host>/<org>/<repo>` from; the user's `url.<base>.insteadOf` config can point it elsewhere (ssh, a mirror). */
export const defaultGitUrl = (repo: string): string => `https://${repo}.git`;

/** Settings for every git call: no hooks, no fsmonitor, no submodules, no `ext::` transport. */
function hardening(noHooks: string): string[] {
  return [
    '-c', `core.hooksPath=${noHooks}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'protocol.ext.allow=never',
    '-c', 'fetch.recurseSubmodules=false',
    '-c', 'submodule.recurse=false',
    '-c', 'transfer.fsckObjects=true',
  ];
}

/** The environment without variables that would point git at another repository than ours. */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE']) delete env[name];
  return env;
}

/**
 * A scratch bare repository to fetch into: nothing is checked out, so no
 * file of the remote is ever written as-is, and hooks point at an empty
 * folder. Arguments go to `git` directly, never through a shell.
 */
export class GitScratch {
  private readonly dir = mkdtempSync(join(tmpdir(), 'proschi-git-'));
  private readonly repo = join(this.dir, 'repo.git');
  private readonly noHooks = join(this.dir, 'no-hooks');

  constructor() {
    mkdirSync(this.noHooks);
    this.git(['init', '--bare', '--quiet', this.repo], false);
  }

  private git(args: string[], inRepo = true, encoding: 'utf8' | 'buffer' = 'utf8'): string | Buffer {
    try {
      return execFileSync('git', [...hardening(this.noHooks), ...(inRepo ? ['-C', this.repo] : []), ...args], {
        env: gitEnv(),
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_IMPORT_BYTES + 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: encoding === 'utf8' ? 'utf8' : 'buffer',
      });
    } catch (e) {
      const stderr = String((e as { stderr?: unknown }).stderr ?? '').trim();
      throw new ImportError(`git ${args[0]} failed${stderr ? `: ${stderr.split('\n').pop()}` : ''}`);
    }
  }

  /** Fetches one ref (or commit) shallowly and returns the commit it points at. */
  fetch(url: string, ref: string): string {
    // ref and url were validated (no leading '-'); '--' ends the options regardless.
    this.git(['fetch', '--quiet', '--depth=1', '--no-tags', '--no-recurse-submodules', '--', url, ref]);
    return String(this.git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim();
  }

  /** A regular file at `path` in `commit`: never a symlink or submodule, at most MAX_IMPORT_BYTES. */
  read(commit: string, path: string, spec: string): Buffer {
    const entry = String(this.git(['ls-tree', '-z', commit, '--', path]));
    const match = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t/.exec(entry);
    if (!match) throw new ImportError(`'${spec}': no such file in the repository at ${commit.slice(0, 12)}`);
    const [, mode, type, oid] = match;
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) throw new ImportError(`'${spec}' is not a regular file (a symlink, folder or submodule)`);
    const size = Number(String(this.git(['cat-file', '-s', oid])).trim());
    if (size > MAX_IMPORT_BYTES) throw new ImportError(`'${spec}' is larger than ${MAX_IMPORT_BYTES / 1_000_000} MB`);
    return this.git(['cat-file', 'blob', oid], true, 'buffer') as Buffer;
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Downloads an https URL: https redirects only, at most MAX_IMPORT_BYTES, within a timeout. */
export async function fetchHttps(url: string, fetchImpl: Fetch = fetch): Promise<Buffer> {
  let current = new URL(url);
  for (let redirects = 0; ; redirects++) {
    if (current.protocol !== 'https:') throw new ImportError(`'${url}' redirects to ${current.protocol}//; only https:// is allowed`);
    if (current.username || current.password) throw new ImportError(`'${url}' redirects to a URL with credentials`);
    let response: Response;
    try {
      response = await fetchImpl(current.href, { redirect: 'manual', signal: AbortSignal.timeout(HTTPS_TIMEOUT_MS) });
    } catch (e) {
      throw new ImportError(`Cannot download '${url}': ${(e as Error).message}`);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || redirects >= MAX_REDIRECTS) throw new ImportError(`'${url}' redirects too often or without a location`);
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new ImportError(`Cannot download '${url}': HTTP ${response.status}`);
    if (Number(response.headers.get('content-length') ?? 0) > MAX_IMPORT_BYTES) throw new ImportError(`'${url}' is larger than ${MAX_IMPORT_BYTES / 1_000_000} MB`);
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    for (;;) {
      const chunk = reader ? await reader.read() : { done: true as const, value: undefined };
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_IMPORT_BYTES) {
        await reader?.cancel();
        throw new ImportError(`'${url}' is larger than ${MAX_IMPORT_BYTES / 1_000_000} MB`);
      }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks);
  }
}
