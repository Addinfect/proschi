import { describe, expect, it } from 'vitest';
import type { DocumentState, SavedDiagram } from './documents';
import { BLANK_SOURCE } from './documents';
import { afterDelete, afterPut, afterRefused, answerAsk, applyRemote, cloudPlan, conflictCopy, emptyMeta, fingerprint, forgetSynced, keepInCloud, moveToBrowser, pendingOps, readStoredSync, remoteFingerprint, retitle, switchAccount, type RemoteDoc, type SyncMeta } from './sync';

const NOW = '2026-10-06T14:05:00.000Z';
const clock = () => NOW;
let n = 0;
const ids = () => `new-${++n}`;

const local = (id: string, source: string, fileName = `${id}.proschi`): SavedDiagram => ({ id, source, fileName, updatedAt: '2026-10-01T00:00:00.000Z' });
const remote = (id: string, source: string, version: number, name = `${id}.proschi`): RemoteDoc => ({ id, name, source, imports: null, version, updatedAt: 1_000, deletedAt: null });
const tombstone = (id: string, version: number): RemoteDoc => ({ id, name: '', source: '', imports: null, version, updatedAt: 2_000, deletedAt: 2_000 });
const state = (...docs: SavedDiagram[]): DocumentState => ({ docs, currentId: docs[0].id });

/** Meta that says `docs` were synced at `version` with their current content. */
function synced(docs: SavedDiagram[], version = 1, cursor: number | null = 500): SyncMeta {
  return { ...emptyMeta('u1'), cursor, docs: Object.fromEntries(docs.map((d) => [d.id, { version, fp: fingerprint(d) }])) };
}

describe('cloud sync merge', () => {
  it('adds diagrams from the account and takes newer copies of unchanged ones', () => {
    const a = local('a', 'title "A"\n');
    const meta = synced([a]);
    const result = applyRemote(state(a), meta, [remote('a', 'title "A2"\n', 2), remote('b', 'title "B"\n', 1)], clock, ids);
    expect(result.state.docs.map((d) => [d.id, d.source])).toEqual([
      ['a', 'title "A2"\n'],
      ['b', 'title "B"\n'],
    ]);
    expect(result.meta.docs.a.version).toBe(2);
    expect(result.conflicts).toEqual([]);
    expect(pendingOps(result.state, result.meta)).toEqual([]);
  });

  it('drops cloud: files from a diagram in the account, and sends it back without them', () => {
    const withCloud = { ...remote('a', 'import "cloud:orders"\n', 1), imports: { 'cloud:orders:latest': 'api', 'db.proschi': 'db' } };
    const result = applyRemote({ docs: [local('x', 'x')], currentId: 'x' }, emptyMeta('u1'), [withCloud], clock, ids);
    expect(result.state.docs.find((d) => d.id === 'a')?.imports).toEqual({ 'db.proschi': 'db' });
    expect(pendingOps(result.state, result.meta)).toContainEqual(expect.objectContaining({ kind: 'put', id: 'a', body: expect.objectContaining({ imports: { 'db.proschi': 'db' } }) }));
  });

  it('ignores versions it already has', () => {
    const a = local('a', 'mine');
    const before = state(a);
    const result = applyRemote(before, synced([a], 3), [remote('a', 'old', 3), remote('a', 'older', 2)], clock, ids);
    expect(result.state).toBe(before);
  });

  it('keeps both when a diagram changed here and there: the local one is renamed', () => {
    const a = local('a', 'title "Shop"\nservice api\n', 'shop.proschi');
    const meta = synced([a]);
    const edited = { ...a, source: 'title "Shop"\nservice web\n' };
    const result = applyRemote(state(edited), meta, [remote('a', 'title "Shop"\nservice db\n', 2, 'shop.proschi')], clock, ids);
    const [server, copy] = result.state.docs;
    expect(server).toMatchObject({ id: 'a', source: 'title "Shop"\nservice db\n' });
    expect(copy.id).not.toBe('a');
    expect(copy.source).toMatch(/^title "Shop \(conflict \d{4}-\d\d-\d\d \d\d:\d\d\)"\nservice web\n$/);
    expect(copy.fileName).toMatch(/^shop \(conflict .+\)\.proschi$/);
    // The open diagram stays the one being edited.
    expect(result.state.currentId).toBe(copy.id);
    expect(result.conflicts).toEqual([expect.stringMatching(/^Shop \(conflict /)]);
    // The copy is new: it is uploaded; the server's copy is in sync.
    expect(pendingOps(result.state, result.meta)).toEqual([expect.objectContaining({ kind: 'put', id: copy.id, baseVersion: 0 })]);
  });

  it('a change to the same content is no conflict', () => {
    const a = local('a', 'one');
    const same = { ...a, source: 'two' };
    const result = applyRemote(state(same), synced([a]), [remote('a', 'two', 2)], clock, ids);
    expect(result.state.docs).toHaveLength(1);
    expect(pendingOps(result.state, result.meta)).toEqual([]);
  });

  it('deletes what was deleted elsewhere, unless it was edited here', () => {
    const a = local('a', 'A');
    const b = local('b', 'B');
    const meta = synced([a, b]);
    const editedB = { ...b, source: 'B edited' };
    const result = applyRemote(state(a, editedB), meta, [tombstone('a', 2), tombstone('b', 2)], clock, ids);
    expect(result.state.docs.map((d) => d.id)).toEqual(['b']);
    expect(result.meta.docs.a).toBeUndefined();
    // b is sent on top of the tombstone, which restores it.
    expect(pendingOps(result.state, result.meta)).toEqual([expect.objectContaining({ kind: 'put', id: 'b', baseVersion: 2 })]);
  });

  it('a diagram deleted here but edited elsewhere comes back', () => {
    const a = local('a', 'A');
    const b = local('b', 'B');
    const meta = synced([a, b]);
    expect(pendingOps(state(a), meta)).toEqual([{ kind: 'delete', id: 'b', baseVersion: 1 }]);
    const result = applyRemote(state(a), meta, [remote('b', 'B edited', 2)], clock, ids);
    expect(result.state.docs.map((d) => d.source)).toEqual(['A', 'B edited']);
    expect(pendingOps(result.state, result.meta)).toEqual([]);
  });

  it('never leaves the editor without a diagram', () => {
    const a = local('a', 'A');
    const result = applyRemote(state(a), synced([a]), [tombstone('a', 2)], clock, ids);
    expect(result.state.docs).toHaveLength(1);
    expect(result.state.docs[0].id).not.toBe('a');
    expect(result.state.currentId).toBe(result.state.docs[0].id);
  });

  it('first sign-in: merges by id, uploads what the account lacks, keeps both on a clash, drops exact twins', () => {
    const same = local('same', 'title "Same"\n');
    const clash = local('clash', 'title "Mine"\n');
    const onlyHere = local('here', 'title "Here"\n');
    const starter = local('starter-local', 'title "Starter"\n', 'starter.proschi');
    const meta = emptyMeta('u1');
    const result = applyRemote(
      state(starter, same, clash, onlyHere),
      meta,
      [remote('same', 'title "Same"\n', 4), remote('clash', 'title "Theirs"\n', 2), remote('starter-remote', 'title "Starter"\n', 1, 'starter.proschi')],
      clock,
      ids,
    );
    const docs = result.state.docs;
    expect(docs.map((d) => d.id)).not.toContain('starter-local');
    expect(result.state.currentId).toBe('starter-remote');
    expect(docs.filter((d) => d.id === 'same')).toHaveLength(1);
    expect(docs.find((d) => d.id === 'clash')?.source).toBe('title "Theirs"\n');
    expect(docs.some((d) => d.source.startsWith('title "Mine (conflict'))).toBe(true);
    const ops = pendingOps(result.state, result.meta);
    expect(ops.map((o) => o.kind === 'put' && [o.baseVersion, o.body.source])).toEqual(
      expect.arrayContaining([
        [0, 'title "Here"\n'],
        [0, expect.stringMatching(/^title "Mine \(conflict/)],
      ]),
    );
    expect(ops).toHaveLength(2);
  });

  it('ops: deletes first (they free slots), then edits and new diagrams oldest first with their base version', () => {
    const a = local('a', 'A');
    const b = local('b', 'B');
    const meta = synced([a, b], 5);
    const editedA = { ...a, source: 'A2', updatedAt: '2026-10-03T00:00:00.000Z' };
    const added = { ...local('c', 'C'), imports: { 'lib.proschi': 'x' }, updatedAt: '2026-10-02T00:00:00.000Z' };
    const ops = pendingOps({ docs: [editedA, added], currentId: 'a' }, meta);
    expect(ops).toEqual([
      { kind: 'delete', id: 'b', baseVersion: 5 },
      { kind: 'put', id: 'c', baseVersion: 0, fp: fingerprint(added), body: { name: 'c.proschi', source: 'C', imports: { 'lib.proschi': 'x' } } },
      { kind: 'put', id: 'a', baseVersion: 5, fp: fingerprint(editedA), body: { name: 'a.proschi', source: 'A2', imports: null } },
    ]);
    let next = afterPut(meta, ops[1] as Extract<(typeof ops)[0], { kind: 'put' }>, remote('c', 'C', 1));
    next = afterDelete(next, 'b');
    expect(pendingOps({ docs: [editedA, added], currentId: 'a' }, next).map((o) => o.id)).toEqual(['a']);
  });

  it('renaming a file counts as an edit', () => {
    const a = local('a', 'A');
    expect(pendingOps(state({ ...a, fileName: 'renamed.proschi' }), synced([a]))).toHaveLength(1);
  });

  it('local and remote fingerprints agree', () => {
    const doc = { ...local('a', 'src', 'x.proschi'), imports: { 'b.proschi': '1', 'a.proschi': '2' } };
    expect(fingerprint(doc)).toBe(remoteFingerprint({ ...remote('a', 'src', 1, 'x.proschi'), imports: { 'a.proschi': '2', 'b.proschi': '1' } }));
  });

  it('retitles a copy, with or without a title line', () => {
    expect(retitle('  title Shop\nservice a\n', 'Shop "2"')).toBe('  title "Shop \\"2\\""\nservice a\n');
    expect(retitle('service a\n', 'X')).toBe('title "X"\nservice a\n');
    expect(conflictCopy(local('a', 'service a\n', 'a.proschi'), 'b', NOW)).toMatchObject({ id: 'b', fileName: expect.stringMatching(/^a \(conflict .+\)\.proschi$/) });
  });

  it('reads stored state defensively', () => {
    expect(readStoredSync(null)).toEqual({});
    expect(readStoredSync({ off: true })).toEqual({ off: true });
    const stored = readStoredSync({ meta: { userId: 'u', cursor: 'x', docs: { a: { version: 1, fp: 'f' }, b: { version: 'x' }, ['__proto__']: { version: 1, fp: 'f' } }, refused: 4 } });
    expect(stored.meta).toEqual({ userId: 'u', cursor: null, docs: { a: { version: 1, fp: 'f' } }, refused: {} });
  });

  it('account switch: drops the previous account\'s synced diagrams, holds back the rest', () => {
    const synced1 = local('s1', 'title "Synced"\n');
    const edited = local('s2', 'title "Edited"\n');
    const never = local('n1', 'title "Never synced"\n');
    const blank = { ...local('blank', BLANK_SOURCE) };
    const previous = { ...synced([synced1, edited]), userId: 'u1' };
    const editedNow = { ...edited, source: 'title "Edited later"\n' };
    const result = switchAccount(state(synced1, editedNow, never, blank), previous, 'u2', clock, ids);
    expect(result.state.docs.map((d) => d.id)).toEqual(['s2', 'n1', 'blank']);
    expect(result.meta).toEqual({ ...emptyMeta('u2'), held: ['s2', 'n1'], ask: true });
    expect(pendingOps(result.state, result.meta)).toEqual([]);
    expect(pendingOps(result.state, answerAsk(result.meta, false))).toEqual([]);
    expect(pendingOps(result.state, answerAsk(result.meta, true)).map((o) => o.id)).toEqual(['s2', 'n1']);
  });

  it('account switch with only synced diagrams leaves a blank one, and asks nothing', () => {
    const a = local('a', 'A');
    const result = switchAccount(state(a), { ...synced([a]), userId: 'u1' }, 'u2', clock, ids);
    expect(result.state.docs).toEqual([expect.objectContaining({ source: BLANK_SOURCE })]);
    expect(result.meta).toEqual(emptyMeta('u2'));
  });

  it('a conflict copy of a held diagram is held too', () => {
    const mine = local('x', 'mine');
    const meta = { ...emptyMeta('u2'), held: ['x'] };
    const result = applyRemote(state(mine), meta, [remote('x', 'theirs', 1)], clock, ids);
    const copy = result.state.docs.find((d) => d.id !== 'x')!;
    expect(result.meta.held).toEqual(['x', copy.id]);
    expect(pendingOps(result.state, result.meta)).toEqual([]);
  });

  it('forgetting the synced diagrams keeps unsent edits and resets the cursor', () => {
    const a = local('a', 'A');
    const b = local('b', 'B');
    const meta = synced([a, b], 2);
    const result = forgetSynced(state(a, { ...b, source: 'B2' }), meta);
    expect(result.removed).toBe(1);
    expect(result.state?.docs.map((d) => d.id)).toEqual(['b']);
    expect(result.meta).toEqual({ ...meta, cursor: null, docs: { b: meta.docs.b } });
    expect(forgetSynced(state(a), synced([a])).state).toBeNull();
  });

  it('a new blank diagram is not uploaded until something is typed', () => {
    expect(pendingOps(state(local('n', BLANK_SOURCE)), emptyMeta('u'))).toEqual([]);
  });

  describe('the account\'s limit', () => {
    const at = (id: string, day: number) => ({ ...local(id, `title "${id}"\n`), updatedAt: `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z` });
    const limited = (docs: SavedDiagram[], limit: number): SyncMeta => ({ ...synced(docs), limit });
    const puts = (s: DocumentState, m: SyncMeta) => pendingOps(s, m).flatMap((o) => (o.kind === 'put' ? [o.id] : []));

    it('diagrams in the account keep their slot; new ones take the free slots, most recently edited first', () => {
      const kept = [at('a', 1), at('b', 2), at('c', 3)];
      const fresh = [at('old', 4), at('newest', 9), at('mid', 6), at('tie-b', 7), at('tie-a', 7)];
      const s = { docs: [...kept, ...fresh], currentId: 'a' };
      const plan = cloudPlan(s, limited(kept, 5));
      expect([...plan.cloud].sort()).toEqual(['a', 'b', 'c', 'newest', 'tie-a']);
      expect([...plan.local].sort()).toEqual(['mid', 'old', 'tie-b']);
      expect(plan).toMatchObject({ used: 5, limit: 5, free: 0 });
      expect(puts(s, limited(kept, 5)).sort()).toEqual(['newest', 'tie-a']);
    });

    it('full: new diagrams stay in this browser and nothing is sent for them, an edit of a kept one still is', () => {
      const kept = [at('a', 1), at('b', 2)];
      const s = { docs: [...kept, at('n', 3)], currentId: 'a' };
      const meta = limited(kept, 2);
      expect(cloudPlan(s, meta)).toMatchObject({ used: 2, free: 0, local: new Set(['n']) });
      expect(pendingOps(s, meta)).toEqual([]);
      const edited = { docs: [{ ...kept[0], source: 'title "a2"\n' }, kept[1], at('n', 3)], currentId: 'a' };
      expect(puts(edited, meta)).toEqual(['a']);
      // A blank new diagram is marked too, once there is no room.
      expect(cloudPlan({ docs: [...kept, local('blank', BLANK_SOURCE)], currentId: 'a' }, meta).local.has('blank')).toBe(true);
    });

    it('a delete frees a slot for the next new diagram, and goes first', () => {
      const kept = [at('a', 1), at('b', 2)];
      const meta = limited(kept, 2);
      const s = { docs: [kept[0], at('n', 3)], currentId: 'a' };
      expect(pendingOps(s, meta).map((o) => `${o.kind} ${o.id}`)).toEqual(['delete b', 'put n']);
    });

    it('unknown limit (before the first pull): everything may sync, the server decides', () => {
      const s = { docs: [at('a', 1), at('b', 2)], currentId: 'a' };
      expect(cloudPlan(s, emptyMeta('u1'))).toMatchObject({ limit: null, local: new Set() });
      expect(puts(s, emptyMeta('u1')).sort()).toEqual(['a', 'b']);
    });

    it('a refusal for the limit is not retried until a delete frees a slot', () => {
      const kept = [at('a', 1)];
      const n = at('n', 2);
      const s = { docs: [kept[0], n], currentId: 'a' };
      const op = pendingOps(s, synced(kept))[0] as Extract<ReturnType<typeof pendingOps>[0], { kind: 'put' }>;
      const refused = afterRefused(synced(kept), op, 5);
      expect(refused.limit).toBe(5);
      expect(pendingOps(s, refused)).toEqual([]);
      expect(cloudPlan(s, refused).local.has('n')).toBe(true);
      expect(puts(s, afterDelete(refused, 'gone'))).toEqual(['n']);
    });

    it('move to this browser only deletes the cloud copy and frees the slot; keep in cloud takes it back first', () => {
      const kept = [at('a', 1), at('b', 2)];
      const s = { docs: [...kept, at('n', 9)], currentId: 'a' };
      let meta = moveToBrowser(limited(kept, 2), 'a');
      expect(pendingOps(s, meta).map((o) => `${o.kind} ${o.id}`)).toEqual(['delete a', 'put n']);
      meta = afterDelete(meta, 'a');
      meta = afterPut(meta, pendingOps(s, meta)[0] as Extract<ReturnType<typeof pendingOps>[0], { kind: 'put' }>, remote('n', 'title "n"\n', 1));
      expect(cloudPlan(s, meta)).toMatchObject({ local: new Set(['a']), used: 2, free: 0 });
      // Its own tombstone coming back does not restore it.
      const pulled = applyRemote(s, meta, [tombstone('a', 2)], clock, ids);
      expect(pendingOps(pulled.state, pulled.meta)).toEqual([]);
      // Keep in cloud: first in line once a slot is free.
      meta = keepInCloud(afterDelete(meta, 'b'), 'a');
      const s2 = { docs: [kept[0], at('n', 9), at('newer', 10)], currentId: 'a' };
      expect(puts(s2, meta)).toEqual(['a']);
      expect(cloudPlan(s2, meta).local).toEqual(new Set(['newer']));
    });

    it('a diagram moved here while another device edits it is still deleted there, at the latest version', () => {
      const a = at('a', 1);
      const meta = moveToBrowser(limited([a], 5), 'a');
      const pulled = applyRemote(state(a), meta, [remote('a', 'theirs', 4)], clock, ids);
      expect(pulled.state.docs[0].source).toBe(a.source);
      expect(pendingOps(pulled.state, pulled.meta)).toEqual([{ kind: 'delete', id: 'a', baseVersion: 4 }]);
    });

    it('held diagrams stay local; answering yes lets the most recent fill the free slots', () => {
      const s = { docs: [at('x', 1), at('y', 3), at('z', 2)], currentId: 'x' };
      const meta: SyncMeta = { ...emptyMeta('u2'), limit: 2, held: ['x', 'y', 'z'], ask: true };
      expect(cloudPlan(s, meta)).toMatchObject({ local: new Set(['x', 'y', 'z']), free: 2 });
      const yes = answerAsk(meta, true);
      expect(cloudPlan(s, yes)).toMatchObject({ cloud: new Set(['y', 'z']), local: new Set(['x']) });
    });

    it('reads the limit and the choices back from storage', () => {
      const back = readStoredSync({ meta: { userId: 'u', cursor: 1, docs: {}, refused: {}, limit: 5, localOnly: ['a', 3], keep: ['b'] } });
      expect(back.meta).toMatchObject({ limit: 5, localOnly: ['a'], keep: ['b'] });
      expect(readStoredSync({ meta: { userId: 'u', docs: {}, refused: {}, limit: -1 } }).meta?.limit).toBeUndefined();
    });
  });
});
