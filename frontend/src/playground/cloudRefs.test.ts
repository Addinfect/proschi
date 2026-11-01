import { describe, expect, it } from 'vitest';
import { parse } from '../dsl';
import { canonicalForm, fetchCloudFiles, sha256Hex, verifyVersion, withCloudErrors, SIGNED_OUT_MESSAGE, type ResolvedVersion, type VersionCache } from './cloudRefs';
import { filesResolver } from './imports';

async function version(name: string, tag: string, source: string, imports: Record<string, string> | null = null): Promise<ResolvedVersion> {
  return { documentId: `doc-${name}`, name, tag, seq: 1, sha256: await sha256Hex(canonicalForm(source, imports)), source, imports };
}

/** A fake account: the versions it has by `name:tag`, and every request made. */
function account(versions: Record<string, ResolvedVersion>) {
  const calls: string[] = [];
  const fetchVersion = async (name: string, tag: string) => {
    calls.push(`${name}:${tag}`);
    const found = versions[`${name}:${tag}`];
    if (!found) throw new Error(`no ${name}:${tag}`);
    return found;
  };
  return { calls, fetchVersion };
}

describe('the canonical form and its sha256', () => {
  it('matches the backend reference', async () => {
    expect(canonicalForm('title "A"', null)).toBe('["title \\"A\\"",[]]');
    expect(canonicalForm('x', { 'b.proschi': '2', 'a.proschi': '1' })).toBe('["x",[["a.proschi","1"],["b.proschi","2"]]]');
    // Paths sort by code units, not locale: 'Z' before 'a'.
    expect(canonicalForm('x', { a: '1', Z: '2' })).toBe('["x",[["Z","2"],["a","1"]]]');
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('rejects a version whose bytes do not match', async () => {
    const good = await version('orders.proschi', 'v1', 'title "Orders"');
    expect(await verifyVersion(good)).toBe(true);
    expect(await verifyVersion({ ...good, source: 'title "Tampered"' })).toBe(false);
  });
});

describe('fetching cloud sources before the parse', () => {
  const org = 'title "Org"\nsystem orders {\n  from "cloud:orders:latest"\n}\n';

  it('fetches what the document reads, then what those read, until nothing is new', async () => {
    const { calls, fetchVersion } = account({
      'orders.proschi:latest': await version('orders.proschi', 'v2', 'title "Orders"\nimport "db.proschi"\nimport "cloud:infra:v1"\napi [REST API]\n', {
        'db.proschi': 'db [Postgres]\n',
      }),
      'infra.proschi:v1': await version('infra.proschi', 'v1', 'cache [Redis]\n'),
    });
    const cache: VersionCache = new Map();
    const result = await fetchCloudFiles(org, { path: 'org.proschi' }, fetchVersion, cache);
    expect(calls).toEqual(['orders.proschi:latest', 'infra.proschi:v1']);
    expect(result.errors).toEqual({});
    expect(Object.keys(result.files).sort()).toEqual(['cloud:infra:v1', 'cloud:orders:latest', 'cloud:orders:latest//db.proschi']);

    const parsed = parse(org, { path: 'org.proschi', resolve: filesResolver(result.files, 'org.proschi') });
    expect(parsed.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(parsed.diagram.systems?.[0].diagram?.nodes.map((n) => n.id).sort()).toEqual(['api', 'cache', 'db']);

    // Cached for the session: nothing is asked again.
    await fetchCloudFiles(org, { path: 'org.proschi' }, fetchVersion, cache);
    expect(calls).toHaveLength(2);
  });

  it('reports what could not be fetched, and refuses a bad checksum', async () => {
    const good = await version('orders.proschi', 'latest', 'api [REST API]\n');
    const { fetchVersion } = account({ 'orders.proschi:latest': { ...good, source: 'evil [REST API]\n' } });
    const result = await fetchCloudFiles(org, {}, fetchVersion, new Map());
    expect(result.files).toEqual({});
    expect(result.errors['cloud:orders:latest']).toMatch(/does not match its checksum/);
  });

  it('signed out, says to sign in, unless the share link bundled the file', async () => {
    expect((await fetchCloudFiles(org, {}, null, new Map())).errors).toEqual({ 'cloud:orders:latest': SIGNED_OUT_MESSAGE });
    expect((await fetchCloudFiles(org, { bundled: { 'cloud:orders:latest': 'api [REST API]\n' } }, null, new Map())).errors).toEqual({});
  });

  it('puts the reason on the import line', () => {
    const errors = { 'cloud:orders:latest': SIGNED_OUT_MESSAGE };
    const parsed = parse(org, { path: 'org.proschi', resolve: withCloudErrors(filesResolver({}, 'org.proschi'), errors, false) });
    expect(parsed.diagnostics.map((d) => [d.line, d.message])).toEqual([[3, SIGNED_OUT_MESSAGE]]);
    const loading = parse(org, { path: 'org.proschi', resolve: withCloudErrors(filesResolver({}, 'org.proschi'), {}, true) });
    expect(loading.diagnostics[0].message).toBe('Loading cloud:orders:latest from your account…');
  });

  it('a name with a space is an error before anything is fetched', async () => {
    const { calls, fetchVersion } = account({});
    const source = 'import "cloud:my orders:v1"\n';
    expect(await fetchCloudFiles(source, {}, fetchVersion, new Map())).toEqual({ files: {}, errors: {} });
    expect(calls).toEqual([]);
    expect(parse(source, { resolve: filesResolver({}, 'x.proschi') }).diagnostics[0].message).toMatch(/whitespace/);
  });
});
