import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeShareLink } from '../../frontend/src/playground/share';
import { collectFiles } from '../src/cli';
import { parseFile } from '../src/imports';
import { CACHE_DIR, LOCK_FILE, readLock } from '../src/lock';
import { shareLink } from '../src/share';
import { runImports, syncImports } from '../src/sync';
import { FakeApi, fakeClient, tempStore } from './fakeApi';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'proschi-cloud-')));
let n = 0;
function project(files: Record<string, string>): string {
  const dir = join(base, `p${n++}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'proschi.json'), '{}');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

let api: FakeApi;
beforeEach(() => {
  api = new FakeApi();
  api.documents = [
    {
      id: 'd1',
      name: 'orders.proschi',
      versions: [
        { tag: 'v1', source: 'import "db.proschi"\napi [REST API]\napi -> db\n', imports: { 'db.proschi': 'db [PostgreSQL]\n' } },
        { tag: '2026-11-01', source: 'import "lib/db.proschi"\napi [GraphQL]\napi -> db\n', imports: { 'lib/db.proschi': 'import "../cache.proschi"\ndb [MySQL]\n', 'cache.proschi': 'cache [Redis]\n' } },
      ],
    },
  ];
  vi.stubGlobal('fetch', () => {
    throw new Error('the network was used');
  });
});
afterEach(() => vi.unstubAllGlobals());

const sync = (dir: string, { frozen = false, client = fakeClient(api) } = {}) => syncImports(collectFiles([dir]), { frozen, api: client });

describe('proschi imports sync with cloud: sources', () => {
  it('pins cloud:<name> (latest) to the concrete tag, seq and sha256, nested //path imports included', async () => {
    const dir = project({ 'app.proschi': 'import "cloud:orders"\nclient -> api\n' });
    const result = await sync(dir);
    expect(result.errors).toEqual([]);
    const entry = readLock(dir)!.cloud['orders:latest'];
    expect(entry).toMatchObject({ tag: '2026-11-01', seq: 2, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(Object.keys(entry.files)).toEqual(['cache.proschi', 'lib/db.proschi']);
    expect(entry.source).toMatch(/^[0-9a-f]{64}$/);
    // One resolve for the version and its files.
    expect(api.calls.filter((c) => c.includes('/resolve'))).toEqual(['GET /api/me/versions/resolve?name=orders.proschi&tag=latest']);
    expect(readdirSync(join(dir, CACHE_DIR))).toHaveLength(3);
    expect(readFileSync(join(dir, LOCK_FILE), 'utf8')).toContain('"cloud": {');

    // Every other command reads the lock and the cache only.
    api.calls.length = 0;
    const parsed = parseFile(join(dir, 'app.proschi'));
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.diagram.nodes.find((x) => x.id === 'db')?.techStack).toBe('MySQL');
    const link = shareLink(join(dir, 'app.proschi'));
    expect('url' in link && decodeShareLink(link.url.slice(link.url.indexOf('#')))?.imports).toEqual({
      'cloud:orders:latest': 'import "lib/db.proschi"\napi [GraphQL]\napi -> db\n',
      'cloud:orders:latest//lib/db.proschi': 'import "../cache.proschi"\ndb [MySQL]\n',
      'cloud:orders:latest//cache.proschi': 'cache [Redis]\n',
    });
    expect(api.calls).toEqual([]);
  });

  it('keeps a pinned latest on its version after a newer one is saved, until its entry is deleted', async () => {
    const dir = project({ 'app.proschi': 'import "cloud:orders:latest"\n' });
    await sync(dir);
    api.documents[0].versions.push({ tag: 'v3', source: 'api [gRPC]\n' });
    rmSync(join(dir, CACHE_DIR), { recursive: true });
    expect((await sync(dir)).errors).toEqual([]);
    expect(readLock(dir)!.cloud['orders:latest'].tag).toBe('2026-11-01');
    expect(api.calls).toContain('GET /api/me/versions/resolve?name=orders.proschi&tag=2026-11-01');
    rmSync(join(dir, LOCK_FILE));
    expect((await sync(dir)).errors).toEqual([]);
    expect(readLock(dir)!.cloud['orders:latest']).toMatchObject({ tag: 'v3', seq: 3 });
  });

  it('pins a concrete tag, and reads files relative to the diagram', async () => {
    const dir = project({ 'app.proschi': 'import "cloud:orders.proschi:v1"\nimport "cloud:orders:v1//db.proschi"\n' });
    expect((await sync(dir)).errors).toEqual([]);
    const lock = readLock(dir)!;
    expect(Object.keys(lock.cloud)).toEqual(['orders:v1']);
    expect(lock.cloud['orders:v1']).toMatchObject({ tag: 'v1', seq: 1, files: { 'db.proschi': expect.any(String) } });
  });

  it('rejects a version whose content does not match its sha256', async () => {
    api.documents[0].versions[1].sha256 = 'f'.repeat(64);
    const dir = project({ 'app.proschi': 'import "cloud:orders"\n' });
    const result = await sync(dir);
    expect(result.errors).toEqual(["'cloud:orders:latest': the content does not match its sha256 ffffffffffff; try again"]);
    expect(result.written).toBe(false);
  });

  it('rejects a pinned version that changed (a tag deleted and the diagram restored, a tampered lock)', async () => {
    const dir = project({ 'app.proschi': 'import "cloud:orders:v1"\n' });
    await sync(dir);
    api.documents[0].versions[0] = { tag: 'v1', source: 'api [SOAP]\n' };
    rmSync(join(dir, CACHE_DIR), { recursive: true });
    const result = await sync(dir);
    expect(result.errors).toEqual([expect.stringMatching(/^'cloud:orders:v1' does not match its sha256 in proschi\.lock \(version v1, seq 1, sha256 [0-9a-f]{12}\)/)]);
  });

  it('says to sign in, without asking the API, when there are no tokens', async () => {
    const dir = project({ 'app.proschi': 'import "cloud:orders"\n' });
    const result = await sync(dir, { client: fakeClient(api, tempStore(false)) });
    expect(result.errors).toEqual(["'cloud:orders:latest': cloud: sources need `proschi login`"]);
    expect(api.calls).toEqual([]);
  });

  it('reports a missing diagram, tag or saved file', async () => {
    const dir = project({ 'app.proschi': 'import "cloud:payments"\nimport "cloud:orders:v9"\nimport "cloud:orders:v1//nope.proschi"\n' });
    expect((await sync(dir)).errors).toEqual([
      "'cloud:payments:latest': your account has no diagram payments.proschi with a saved version",
      "'cloud:orders:v9': your account has no diagram orders.proschi with a version tagged v9",
      "'cloud:orders:v1//nope.proschi': no file nope.proschi is saved with cloud:orders:v1",
    ]);
  });

  it('with --frozen, fails on an unlocked cloud import and passes on a locked, cached one without the API', async () => {
    const dir = project({ 'app.proschi': 'import "cloud:orders"\n' });
    const out: string[] = [];
    const runSync = (...args: string[]) => runImports(['sync', ...args, dir], collectFiles, (s) => out.push(s), (s) => out.push(s), { api: fakeClient(api) });
    writeFileSync(join(dir, LOCK_FILE), '{"version": 1, "git": {}, "https": {}}\n');
    expect(await runSync('--frozen')).toBe(1);
    expect(out.pop()).toBe("error: proschi.lock is out of date: 'cloud:orders:latest' is not locked; run proschi imports sync and commit proschi.lock");
    expect(await runSync()).toBe(0);
    expect(out.pop()).toMatch(/^3 remote file\(s\) from 1 source\(s\) locked in .*proschi\.lock$/);
    api.calls.length = 0;
    expect(await runSync('--frozen')).toBe(0);
    expect(api.calls).toEqual([]);
    // Without the cache, frozen fetches the pinned version (not latest) and checks it.
    rmSync(join(dir, CACHE_DIR), { recursive: true });
    api.documents[0].versions.push({ tag: 'v3', source: 'x\n' });
    expect(await runSync('--frozen')).toBe(0);
    expect(api.calls).toEqual(['GET /api/me/versions/resolve?name=orders.proschi&tag=2026-11-01']);
  });

  it('gives the sync hint to every other command when a cloud import is not pinned', () => {
    const dir = project({ 'app.proschi': 'import "cloud:orders"\n' });
    writeFileSync(join(dir, LOCK_FILE), '{"version": 1, "git": {}, "https": {}}\n');
    expect(parseFile(join(dir, 'app.proschi')).diagnostics.map((d) => d.message)).toEqual([
      "'cloud:orders:latest' is a version in your Proschi account; run proschi imports sync to pin it (cloud sources need proschi login)",
    ]);
  });

  it('rejects malformed cloud lock entries', () => {
    const dir = project({ 'app.proschi': 'import "cloud:orders"\n' });
    const bad = (entry: unknown, key = 'orders:latest') => {
      writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ version: 1, cloud: { [key]: entry } }));
      return parseFile(join(dir, 'app.proschi')).diagnostics[0].message;
    };
    const ok = { tag: 'v1', seq: 1, sha256: 'a'.repeat(64), files: {} };
    expect(bad({ ...ok, tag: 'latest' })).toMatch(/bad cloud entry 'orders:latest'/);
    expect(bad({ ...ok, seq: 0 })).toMatch(/bad cloud entry/);
    expect(bad({ ...ok, source: '../../etc/passwd' })).toMatch(/bad cloud entry/);
    expect(bad({ ...ok, files: { '../x.proschi': 'a'.repeat(64) } })).toMatch(/bad cloud entry/);
    expect(bad(ok, 'orders.proschi:latest')).toMatch(/bad cloud entry/);
    expect(bad(ok, 'orders')).toMatch(/bad cloud entry/);
  });
});

describe('proschi imports sync --update', () => {
  const run = async (dir: string, ...args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runImports(['sync', ...args, dir], collectFiles, (s) => out.push(s), (s) => err.push(s), { api: fakeClient(api) });
    return { code, out, err };
  };

  it('moves every latest pin to the newest version, refetching it, and prints old -> new', async () => {
    const dir = project({ 'app.proschi': 'import "cloud:orders"\n' });
    await sync(dir);
    api.documents[0].versions.push({ tag: 'v3', source: 'api [gRPC]\n' });
    // A plain sync keeps the pin.
    expect((await run(dir)).code).toBe(0);
    expect(readLock(dir)!.cloud['orders:latest'].tag).toBe('2026-11-01');
    const { code, out } = await run(dir, '--update');
    expect(code).toBe(0);
    expect(out[0]).toBe('cloud:orders:latest: 2026-11-01 -> v3');
    expect(readLock(dir)!.cloud['orders:latest']).toMatchObject({ tag: 'v3', seq: 3, files: {} });
    expect(parseFile(join(dir, 'app.proschi')).diagram.nodes.find((x) => x.id === 'api')?.techStack).toBe('gRPC');
    // Already the newest: nothing changes.
    expect((await run(dir, '--update')).out[0]).toBe('cloud:orders:latest: v3 (already the newest)');
  });

  it('updates only the named specs; a concrete tag never moves', async () => {
    api.documents.push({ id: 'd2', name: 'payments.proschi', versions: [{ tag: 'p1', source: 'pay [Stripe]\n' }] });
    const dir = project({ 'app.proschi': 'import "cloud:orders"\nimport "cloud:payments:latest"\nimport "cloud:orders:v1//db.proschi"\n' });
    expect((await sync(dir)).errors).toEqual([]);
    api.documents[0].versions.push({ tag: 'v3', source: 'api [gRPC]\n' });
    api.documents[1].versions.push({ tag: 'p2', source: 'pay [Adyen]\n' });
    const { code, out } = await run(dir, '--update', 'cloud:payments', 'cloud:orders:v1');
    expect(code).toBe(0);
    expect(out[0]).toBe('cloud:payments:latest: p1 -> p2');
    const lock = readLock(dir)!;
    expect(lock.cloud['orders:latest'].tag).toBe('2026-11-01');
    expect(lock.cloud['orders:v1'].tag).toBe('v1');
    expect(lock.cloud['payments:latest'].tag).toBe('p2');
  });

  it('rejects --update with --frozen, a non-cloud spec and a spec that is not imported', async () => {
    const dir = project({ 'app.proschi': 'import "cloud:orders"\n' });
    await sync(dir);
    expect((await run(dir, '--update', '--frozen')).err).toEqual(['error: --update and --frozen cannot be used together']);
    expect((await run(dir, '--frozen', '--update')).code).toBe(1);
    expect((await run(dir, '--update', 'cloud:orders:latest//db.proschi')).err).toEqual(["error: --update takes cloud:<name> imports, not 'cloud:orders:latest//db.proschi'"]);
    expect((await run(dir, '--update', 'cloud:payments')).err).toEqual(["error: --update: 'cloud:payments:latest' is not imported by these files"]);
  });
});
