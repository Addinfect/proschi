import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeShareLink } from '../../frontend/src/playground/share';
import { run } from '../src/cli';
import { parseFile } from '../src/imports';
import { LOCK_FILE, CACHE_DIR, readLock } from '../src/lock';
import { runImports, syncImports } from '../src/sync';
import { collectFiles } from '../src/cli';

// Counts every git process the code under test starts; the fixtures use spawnSync.
const spawned = vi.hoisted(() => ({ git: [] as string[][] }));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    execFileSync: ((file: string, args: string[], options: object) => {
      spawned.git.push(args);
      return original.execFileSync(file, args, options);
    }) as typeof original.execFileSync,
  };
});

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

// A local bare repository standing in for git:example.com/acme/infra.
const base = realpathSync(mkdtempSync(join(tmpdir(), 'proschi-sync-')));
const work = join(base, 'work');
mkdirSync(join(work, 'shared'), { recursive: true });
git(base, 'init', '-q', '-b', 'main', work);
writeFileSync(join(work, 'shared', 'base.proschi'), 'import "nodes.proschi"\napi -> db\n');
writeFileSync(join(work, 'shared', 'nodes.proschi'), 'api [REST API]\ndb [PostgreSQL]\n');
writeFileSync(join(work, 'shared', 'escape.proschi'), 'import "../../outside.proschi"\n');
symlinkSync('/etc/passwd', join(work, 'shared', 'link.proschi'));
git(work, 'add', '-A');
git(work, 'commit', '-q', '-m', 'v1');
git(work, 'tag', 'v1.0.0');
const v1 = git(work, 'rev-parse', 'HEAD');
const bare = join(base, 'infra.git');
git(base, 'clone', '-q', '--bare', work, bare);
const gitUrl = (repo: string) => {
  expect(repo).toBe('example.com/acme/infra');
  return `file://${bare}`;
};

const SPEC = 'git:example.com/acme/infra//shared/base.proschi@v1.0.0';
const HTTPS = 'https://example.com/lib/cache.proschi';

let n = 0;
/** A fresh project with proschi.json and the given files. */
function project(files: Record<string, string>): string {
  const dir = join(base, `p${n++}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'proschi.json'), '{}');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const responses = new Map<string, () => Response>();
const fetchStub = vi.fn(async (url: string) => responses.get(url)?.() ?? new Response('nope', { status: 404 }));

function capture(argv: string[]) {
  const out: string[] = [];
  const result = run(argv, (s) => out.push(s), (s) => out.push(s));
  return Promise.resolve(result).then((code) => ({ code, out: out.join('\n') }));
}

const sync = (dir: string, frozen = false) => syncImports(collectFiles([dir]), { frozen, gitUrl, fetch: fetchStub });

beforeEach(() => {
  spawned.git.length = 0;
  fetchStub.mockClear();
  responses.set(HTTPS, () => new Response('cache [Redis]\n'));
  vi.stubGlobal('fetch', () => {
    throw new Error('the network was used');
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('proschi imports sync', () => {
  it('fetches git and https imports, pins them in proschi.lock, and caches them', async () => {
    const dir = project({ 'app.proschi': `import "${SPEC}"\nimport "${HTTPS}"\nclient -> api\n` });
    const result = await sync(dir);
    expect(result.errors).toEqual([]);
    const lock = readLock(dir)!;
    expect(lock.git['example.com/acme/infra@v1.0.0'].commit).toBe(v1);
    expect(Object.keys(lock.git['example.com/acme/infra@v1.0.0'].files)).toEqual(['shared/base.proschi', 'shared/nodes.proschi']);
    expect(Object.keys(lock.https)).toEqual([HTTPS]);
    expect(readdirSync(join(dir, CACHE_DIR))).toHaveLength(3);
    // Shallow fetch of the exact ref, options ended before the url and ref, hooks disabled.
    const fetches = spawned.git.filter((a) => a.includes('fetch'));
    expect(fetches).toHaveLength(1);
    expect(fetches[0].slice(-3)).toEqual(['--', `file://${bare}`, 'v1.0.0']);
    expect(fetches[0]).toContain('--depth=1');
    expect(fetches[0].join(' ')).toMatch(/core\.hooksPath=\S+no-hooks/);
  });

  it('lets every other command read remote imports from the cache only, never spawning git or fetching', async () => {
    const dir = project({ 'app.proschi': `import "${SPEC}"\nimport "${HTTPS}"\nclient -> api\nclient -> cache\n` });
    const before = await capture(['check', join(dir, 'app.proschi')]);
    expect(before.out).toContain(`'${SPEC}' is a remote import and there is no proschi.lock; run proschi imports sync`);
    await sync(dir);
    spawned.git.length = 0;
    fetchStub.mockClear();

    const file = join(dir, 'app.proschi');
    expect(parseFile(file).diagnostics).toEqual([]);
    expect(parseFile(file).diagram.nodes.map((n) => n.id)).toEqual(['api', 'db', 'cache', 'client']);
    expect((await capture(['check', file])).code).toBe(0);
    const share = await capture(['share-link', file]);
    expect(decodeShareLink(share.out.slice(share.out.indexOf('#')))?.imports).toEqual({
      [SPEC]: 'import "nodes.proschi"\napi -> db\n',
      'git:example.com/acme/infra//shared/nodes.proschi@v1.0.0': 'api [REST API]\ndb [PostgreSQL]\n',
      [HTTPS]: 'cache [Redis]\n',
    });
    expect(spawned.git).toEqual([]);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('says what to do when a remote import is not synced', async () => {
    const dir = project({ 'app.proschi': `import "${SPEC}"\n` });
    await sync(dir);
    writeFileSync(join(dir, 'app.proschi'), `import "${SPEC}"\nimport "git:example.com/acme/infra//shared/nodes.proschi@main"\n`);
    expect(parseFile(join(dir, 'app.proschi')).diagnostics.map((d) => d.message)).toEqual([
      "'git:example.com/acme/infra//shared/nodes.proschi@main' is not in proschi.lock; run proschi imports sync",
    ]);
    const share = await capture(['share-link', join(dir, 'app.proschi')]);
    expect(share.code).toBe(1);
    expect(share.out).toContain('run proschi imports sync');
  });

  it('detects a cached file that no longer matches its hash', async () => {
    const dir = project({ 'app.proschi': `import "${HTTPS}"\n` });
    await sync(dir);
    const hash = readLock(dir)!.https[HTTPS];
    writeFileSync(join(dir, CACHE_DIR, hash), 'evil [Redis]\n');
    expect(parseFile(join(dir, 'app.proschi')).diagnostics.map((d) => d.message)).toEqual([
      `The cached copy of '${HTTPS}' does not match its hash in proschi.lock; run proschi imports sync`,
    ]);
    // sync downloads it again, and it matches.
    expect((await sync(dir)).errors).toEqual([]);
    expect(parseFile(join(dir, 'app.proschi')).diagnostics).toEqual([]);
  });

  it('trusts on first use: content that changed since it was locked is an error', async () => {
    const dir = project({ 'app.proschi': `import "${HTTPS}"\nimport "${SPEC}"\n` });
    await sync(dir);
    const lockText = readFileSync(join(dir, LOCK_FILE), 'utf8');
    const lock = JSON.parse(lockText);
    lock.git['example.com/acme/infra@v1.0.0'].files['shared/nodes.proschi'] = 'a'.repeat(64);
    writeFileSync(join(dir, LOCK_FILE), JSON.stringify(lock));
    responses.set(HTTPS, () => new Response('changed [Redis]\n'));
    const { rmSync } = await import('node:fs');
    rmSync(join(dir, CACHE_DIR), { recursive: true });
    const result = await sync(dir);
    expect(result.errors).toEqual([
      expect.stringMatching(new RegExp(`^'${HTTPS}' does not match its sha256 in proschi.lock`)),
      expect.stringMatching(/^'git:example\.com\/acme\/infra\/\/shared\/nodes\.proschi@v1\.0\.0' does not match its sha256 in proschi\.lock \(commit [0-9a-f]{12}\)/),
    ]);
    expect(result.written).toBe(false);
  });

  it('keeps a locked branch on its locked commit', async () => {
    const dir = project({ 'app.proschi': 'import "git:example.com/acme/infra//shared/nodes.proschi@main"\n' });
    await sync(dir);
    writeFileSync(join(work, 'shared', 'nodes.proschi'), 'api [GraphQL]\ndb [PostgreSQL]\n');
    git(work, 'commit', '-q', '-am', 'v2');
    git(work, 'push', '-q', bare, 'main');
    const { rmSync } = await import('node:fs');
    rmSync(join(dir, CACHE_DIR), { recursive: true });
    expect((await sync(dir)).errors).toEqual([]);
    expect(readLock(dir)!.git['example.com/acme/infra@main'].commit).toBe(v1);
    expect(parseFile(join(dir, 'app.proschi')).diagram.nodes.find((n) => n.id === 'api')?.techStack).toBe('REST API');
  });

  it('with --frozen, fails on a missing or stale lock and passes on a current one without the network', async () => {
    const dir = project({ 'app.proschi': `import "${HTTPS}"\n` });
    const out: string[] = [];
    const runSync = (...args: string[]) => runImports(['sync', ...args, dir], collectFiles, (s) => out.push(s), (s) => out.push(s), { gitUrl, fetch: fetchStub });
    expect(await runSync('--frozen')).toBe(1);
    expect(out.pop()).toBe('error: proschi.lock is missing; run proschi imports sync and commit it');
    expect(await runSync()).toBe(0);
    expect(out.pop()).toMatch(/^1 remote file\(s\) from 1 source\(s\) locked in .*proschi\.lock$/);
    fetchStub.mockClear();
    expect(await runSync('--frozen')).toBe(0);
    expect(fetchStub).not.toHaveBeenCalled();

    writeFileSync(join(dir, 'app.proschi'), `import "${HTTPS}"\nimport "${SPEC}"\n`);
    expect(await runSync('--frozen')).toBe(1);
    expect(out.pop()).toBe(`error: proschi.lock is out of date: '${SPEC}' is not locked; run proschi imports sync and commit proschi.lock`);
    writeFileSync(join(dir, 'app.proschi'), 'a -> b\n');
    expect(await runSync('--frozen')).toBe(1);
    expect(out.pop()).toMatch(/proschi\.lock is out of date: it locks imports that are no longer used/);
  });

  it('confines relative imports of a remote file to its repository, and refuses symlinks in it', async () => {
    const dir = project({
      'app.proschi': 'import "git:example.com/acme/infra//shared/escape.proschi@v1.0.0"\nimport "git:example.com/acme/infra//shared/link.proschi@v1.0.0"\n',
    });
    const { errors } = await sync(dir);
    expect(errors).toEqual([
      "git:example.com/acme/infra//shared/escape.proschi@v1.0.0: '../../outside.proschi' leaves the repository example.com/acme/infra",
      "'git:example.com/acme/infra//shared/link.proschi@v1.0.0' is not a regular file (a symlink, folder or submodule)",
    ]);
  });

  it('refuses ref injection, http:// and credentials without running git', async () => {
    const dir = project({
      'app.proschi': [
        'import "git:example.com/acme/infra//shared/base.proschi@--upload-pack=touch${IFS}/tmp/pwned"',
        'import "git:example.com/acme/infra//shared/base.proschi@-oProxyCommand=x"',
        'import "http://example.com/a.proschi"',
        'import "https://user:secret@example.com/a.proschi"',
        'import "git:example.com/acme/infra//../../../etc/passwd@v1"',
        '',
      ].join('\n'),
    });
    const { errors } = await sync(dir);
    expect(errors.map((e) => e.replace(/^.*?: '/, "'"))).toEqual([
      expect.stringMatching(/has an invalid ref '--upload-pack=touch\$\{IFS\}\/tmp\/pwned'/),
      expect.stringMatching(/has an invalid ref '-oProxyCommand=x'/),
      expect.stringMatching(/uses http:\/\/; only https:\/\/ imports are allowed/),
      expect.stringMatching(/contains credentials/),
      expect.stringMatching(/invalid path in the repository/),
    ]);
    expect(spawned.git).toEqual([]);
    expect(existsSync('/tmp/pwned')).toBe(false);
  });

  it('refuses oversized downloads and redirects away from https', async () => {
    const big = 'https://example.com/big.proschi';
    const streamed = 'https://example.com/streamed.proschi';
    const redirect = 'https://example.com/redirect.proschi';
    responses.set(big, () => new Response('x', { headers: { 'content-length': String(2_000_000) } }));
    responses.set(streamed, () => new Response('# ' + 'x'.repeat(1_000_001)));
    responses.set(redirect, () => new Response(null, { status: 302, headers: { location: 'http://example.com/plain.proschi' } }));
    const dir = project({ 'app.proschi': `import "${big}"\nimport "${streamed}"\nimport "${redirect}"\n` });
    expect((await sync(dir)).errors).toEqual([
      `'${big}' is larger than 1 MB`,
      `'${streamed}' is larger than 1 MB`,
      `'${redirect}' redirects to http://; only https:// is allowed`,
    ]);
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
  });

  it('reports import cycles through remote files like local ones', async () => {
    const a = 'https://example.com/cycle/a.proschi';
    responses.set(a, () => new Response('import "b.proschi"\n'));
    responses.set('https://example.com/cycle/b.proschi', () => new Response('import "a.proschi"\n'));
    const dir = project({ 'app.proschi': `import "${a}"\n` });
    expect((await sync(dir)).errors).toEqual([]);
    expect(parseFile(join(dir, 'app.proschi')).diagnostics.map((d) => d.message)).toEqual(['Import cycle: a.proschi → b.proschi → a.proschi']);
  });

  it('rejects a lockfile whose hashes are not hashes (they name cache files)', async () => {
    const dir = project({ 'app.proschi': `import "${HTTPS}"\n` });
    writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ version: 1, git: {}, https: { [HTTPS]: '../../../../etc/passwd' } }));
    expect(parseFile(join(dir, 'app.proschi')).diagnostics[0].message).toMatch(/^Invalid proschi\.lock: bad https entry/);
    expect((await sync(dir)).errors[0]).toMatch(/^Invalid proschi\.lock/);
  });
});
