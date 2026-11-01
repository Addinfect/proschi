import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runVersions } from '../src/versions';
import { BASE, FakeApi, tempStore } from './fakeApi';

const V1 = `title "Orders"
client [Browser]
api [REST API]
db [PostgreSQL]
legacy [SOAP]
client -> api
api -> db
api -> legacy

usecase checkout "Check out" {
  client -> api : POST /orders
  api -> db : save order
}
`;

const V2 = `title "Orders v2"
import "cache.proschi"
client [Browser]
api [GraphQL] x3
db [PostgreSQL]
client -> api
api -> db
api -> cache

usecase checkout "Check out" {
  client -> api : POST /orders
  api -> cache : reserve stock
  api -> db : save order
}
`;

let api: FakeApi;
beforeEach(() => {
  api = new FakeApi();
  api.documents = [
    {
      id: 'd1',
      name: 'orders.proschi',
      versions: [
        { tag: 'v1', source: V1, note: 'first cut' },
        { tag: '2026-11-01', source: V2, imports: { 'cache.proschi': 'cache [Redis]\n' }, note: 'adds a cache' },
      ],
    },
    { id: 'd2', name: 'old.proschi', versions: [], deletedAt: 1 },
  ];
});

async function versions(...args: string[]) {
  const out: string[] = [];
  const errors: string[] = [];
  const code = await runVersions([...args.slice(0, 1), '--base', BASE, ...args.slice(1)], (s) => out.push(s), (s) => errors.push(s), { store: tempStore(), fetch: api.fetch });
  return { code, out: out.join('\n'), err: errors.join('\n') };
}

describe('proschi versions', () => {
  it('lists the versions of a diagram, newest first', async () => {
    const { code, out } = await versions('list', 'orders');
    expect(code).toBe(0);
    expect(out).toBe(
      [
        'orders.proschi: 2 versions (keeps up to 20)',
        '  TAG         SEQ  SAVED (UTC)       SIZE   NOTE',
        '  2026-11-01  #2   2026-10-02 09:30  249 B  adds a cache',
        '  v1          #1   2026-10-01 09:30  205 B  first cut',
      ].join('\n'),
    );
    const json = JSON.parse((await versions('list', '--json', 'orders.proschi')).out);
    expect(json).toMatchObject({ name: 'orders.proschi', documentId: 'd1', limit: 20, versions: [{ tag: '2026-11-01', seq: 2 }, { tag: 'v1', seq: 1 }] });
  });

  it('diffs a tag against latest', async () => {
    const { code, out, err } = await versions('diff', 'orders', 'v1');
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out).toMatchSnapshot();
    expect(api.calls).toEqual(['GET /api/me/versions/resolve?name=orders.proschi&tag=v1', 'GET /api/me/versions/resolve?name=orders.proschi&tag=latest']);
  });

  it('diffs a version against a local file, and prints JSON', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'proschi-versions-')));
    writeFileSync(join(dir, 'proschi.json'), '{}');
    writeFileSync(join(dir, 'orders.proschi'), V1.replace('legacy [SOAP]', 'legacy [SOAP, deprecated]'));
    const text = await versions('diff', 'orders', 'v1', join(dir, 'orders.proschi'));
    expect(text.out.split('\n').slice(2)).toEqual(['Nodes', '  ~ legacy', '      techStack: "SOAP API" → "SOAP, deprecated"', '', '0 added, 0 removed, 1 changed']);
    const same = await versions('diff', 'orders', 'v1', 'v1');
    expect(same.out).toBe('cloud:orders:v1 (#1) → cloud:orders:v1 (#1)\n\nNo changes');
    const json = JSON.parse((await versions('diff', '--json', 'orders', 'v1', '2026-11-01')).out);
    expect(json.base).toMatchObject({ tag: 'v1', seq: 1 });
    expect(json.target).toMatchObject({ tag: '2026-11-01', seq: 2 });
    expect(json.summary.total).toEqual({ added: 2, removed: 2, changed: 4 });
  });

  it('finds a diagram stored with or without .proschi, and calls both at once ambiguous', async () => {
    api.documents.push({ id: 'p', name: 'payments', versions: [{ tag: 'p1', source: 'pay [Stripe]\n' }] });
    expect((await versions('list', 'payments')).out).toContain('p1');
    api.documents.push({ id: 'p2', name: 'payments.proschi', versions: [] });
    expect((await versions('list', 'payments')).err).toBe('error: Several of your diagrams are named payments.proschi; rename one');
  });

  it('explains unknown diagrams and tags, and needs a sign-in', async () => {
    expect((await versions('list', 'payments')).err).toBe('error: Your account has no diagram named payments.proschi');
    expect((await versions('list', 'old')).err).toBe('error: Your account has no diagram named old.proschi');
    expect((await versions('diff', 'orders', 'v9')).err).toBe("error: 'cloud:orders:v9': your account has no diagram orders.proschi with a version tagged v9");
    expect((await versions('diff', 'orders', 'bad tag!')).err).toMatch(/is not a version tag/);
    expect((await versions('list', 'cloud:orders')).err).toMatch(/is not a diagram name/);
    const out: string[] = [];
    expect(await runVersions(['list', '--base', BASE, 'orders'], () => undefined, (s) => out.push(s), { store: tempStore(false), fetch: api.fetch })).toBe(1);
    expect(out).toEqual([`error: Not signed in to ${BASE}; run proschi login`]);
    expect((await versions('show', 'orders')).code).toBe(2);
  });
});
