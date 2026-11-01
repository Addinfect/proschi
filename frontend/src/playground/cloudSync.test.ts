import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocSync, PUSH_DELAY_MS, SyncError, type Transport } from './cloudSync';
import { createDocStore, type DocStore } from './docStore';
import { addDoc, removeDoc, selectDoc, updateCurrent, type DocumentState } from './documents';
import type { RemoteDoc, StoredSync } from './sync';

/** The account's documents in memory, with the server's rules (backend/src/documents.ts). */
class FakeServer implements Transport {
  docs = new Map<string, RemoteDoc>();
  online = true;
  /** The account's limit (documentLimit); none unless a test sets it. */
  limit?: number;
  calls: string[] = [];
  private clock = 1_000;

  private check(what: string) {
    this.calls.push(what);
    if (!this.online) throw new SyncError(0, 'Failed to fetch');
  }

  async list(since: number | null) {
    this.check(`list ${since}`);
    const documents = [...this.docs.values()].filter((d) => since === null || d.updatedAt >= since).map((d) => ({ ...d }));
    return { documents, cursor: this.clock, ...(this.limit !== undefined ? { limit: this.limit, used: this.live() } : {}) };
  }

  live() {
    return [...this.docs.values()].filter((d) => d.deletedAt === null).length;
  }

  async put(id: string, body: { name: string; source: string; imports: Record<string, string> | null; baseVersion: number }) {
    this.check(`put ${id}@${body.baseVersion}`);
    const existing = this.docs.get(id);
    if (existing && existing.version !== body.baseVersion) throw new SyncError(409, 'changed', undefined, { ...existing });
    if (body.source.length > 100) throw new SyncError(413, 'too large');
    if (this.limit !== undefined && (!existing || existing.deletedAt !== null) && this.live() >= this.limit) {
      throw new SyncError(409, 'Your account keeps 2 diagrams', undefined, undefined, { code: 'document_limit', limit: this.limit });
    }
    return this.write({ id, name: body.name, source: body.source, imports: body.imports, version: (existing?.version ?? 0) + 1, updatedAt: 0, deletedAt: null });
  }

  async remove(id: string, baseVersion: number) {
    this.check(`delete ${id}@${baseVersion}`);
    const existing = this.docs.get(id);
    if (!existing) return null;
    if (existing.version !== baseVersion) throw new SyncError(409, 'changed', undefined, { ...existing });
    return this.write({ ...existing, name: '', source: '', imports: null, version: existing.version + 1, deletedAt: this.clock });
  }

  async removeAll() {
    this.check('remove all');
    this.docs.clear();
  }

  /** A change made by another device. */
  write(doc: RemoteDoc): RemoteDoc {
    const saved = { ...doc, updatedAt: ++this.clock };
    this.docs.set(doc.id, saved);
    return { ...saved };
  }
}

const initial = (): DocumentState => ({ docs: [{ id: 'a', source: 'title "A"\n', fileName: 'a.proschi', updatedAt: '2026-10-01T00:00:00.000Z' }], currentId: 'a' });

let server: FakeServer;
let store: DocStore;
let saved: StoredSync | null;
/** The diagrams saved with `saved`. */
let savedDocs: DocumentState | null;
let conflicts: string[][];
let signedOut: number;
let sync: DocSync;

function makeSync(userId = 'u1') {
  sync = new DocSync({
    store,
    transport: server,
    userId,
    storage: {
      load: () => saved,
      save: (v, docs) => {
        saved = JSON.parse(JSON.stringify(v)) as StoredSync;
        savedDocs = docs;
      },
    },
    timers: { set: (run, ms) => setTimeout(run, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
    onConflict: (titles) => conflicts.push(titles),
    onSignedOut: () => signedOut++,
  });
  return sync;
}

/** Lets pending promises and timers up to `ms` run. */
async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
}

const type = (source: string) => store.set((s) => updateCurrent(s, source));

describe('DocSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    server = new FakeServer();
    store = createDocStore(initial());
    saved = null;
    savedDocs = null;
    conflicts = [];
    signedOut = 0;
  });
  afterEach(() => {
    sync?.stop();
    vi.useRealTimers();
  });

  it('first sign-in uploads the diagrams in this browser and pulls the account', async () => {
    server.write({ id: 'b', name: 'b.proschi', source: 'title "B"\n', imports: null, version: 1, updatedAt: 0, deletedAt: null });
    makeSync().start();
    await settle();
    expect(server.calls).toEqual(['list null', 'put a@0']);
    expect(store.get().docs.map((d) => d.id).sort()).toEqual(['a', 'b']);
    expect(server.docs.get('a')?.source).toBe('title "A"\n');
    expect(sync.getStatus()).toEqual({ kind: 'saved' });
    expect(saved?.meta?.docs.a.version).toBe(1);
  });

  it('saves its state with the diagrams it pulled, so closing the tab at once never reads as deleting them', async () => {
    server.write({ id: 'b', name: 'b.proschi', source: 'title "B"\n', imports: null, version: 1, updatedAt: 0, deletedAt: null });
    makeSync().start();
    await settle();
    expect(Object.keys(saved?.meta?.docs ?? {}).sort()).toEqual(['a', 'b']);
    expect(savedDocs?.docs.map((d) => d.id).sort()).toEqual(['a', 'b']);
    // The next load, from what was saved: nothing to delete.
    store = createDocStore(savedDocs!);
    server.calls = [];
    makeSync().start();
    await settle();
    expect(server.calls.filter((c) => !c.startsWith('list'))).toEqual([]);
    expect(server.docs.get('b')?.deletedAt).toBeNull();
  });

  it('pushes edits about 2 s after the last change, not on every keystroke', async () => {
    makeSync().start();
    await settle();
    server.calls = [];
    type('title "A1"\n');
    expect(sync.getStatus()).toEqual({ kind: 'saving' });
    await settle(PUSH_DELAY_MS - 500);
    type('title "A2"\n');
    await settle(PUSH_DELAY_MS - 500);
    expect(server.calls).toEqual([]);
    await settle(500);
    expect(server.calls).toEqual(['put a@1']);
    expect(server.docs.get('a')).toMatchObject({ source: 'title "A2"\n', version: 2 });
    expect(sync.getStatus()).toEqual({ kind: 'saved' });
  });

  it('flush sends what is pending at once, e.g. as the page is hidden', async () => {
    makeSync().start();
    await settle();
    type('title "Bye"\n');
    await sync.flush(true);
    expect(server.docs.get('a')?.source).toBe('title "Bye"\n');
  });

  it('pushedVersion pushes the edits first, to tag a version of what is on screen', async () => {
    makeSync().start();
    await settle();
    type('title "Tagged"\n');
    expect(await sync.pushedVersion('a')).toBe(2);
    expect(server.docs.get('a')?.source).toBe('title "Tagged"\n');
    expect(await sync.pushedVersion('nope')).toBeNull();
  });

  it('deletes with the base version, and learns deletions made elsewhere', async () => {
    makeSync().start();
    await settle();
    store.set((s) => addDoc(s, 'title "B"\n', () => '2026-10-02T00:00:00.000Z', () => 'b'));
    await settle(PUSH_DELAY_MS);
    store.set((s) => removeDoc(s, 'a'));
    await settle(PUSH_DELAY_MS);
    expect(server.docs.get('a')).toMatchObject({ deletedAt: expect.any(Number), version: 2 });
    // Another device deletes b.
    const b = server.docs.get('b')!;
    server.write({ ...b, source: '', name: '', version: b.version + 1, deletedAt: 5 });
    await sync.sync();
    expect(store.get().docs.map((d) => d.id)).not.toContain('b');
    expect(store.get().docs).toHaveLength(1);
  });

  it('on a 409 keeps both: the server copy, and this browser\'s renamed', async () => {
    makeSync().start();
    await settle();
    // Another device saves version 2 meanwhile.
    server.write({ ...server.docs.get('a')!, source: 'title "A"\nservice theirs\n', version: 2 });
    type('title "A"\nservice mine\n');
    await settle(PUSH_DELAY_MS);
    const docs = store.get().docs;
    expect(docs.find((d) => d.id === 'a')?.source).toBe('title "A"\nservice theirs\n');
    const copy = docs.find((d) => d.id !== 'a')!;
    expect(copy.source).toMatch(/^title "A \(conflict .+\)"\nservice mine\n$/);
    expect(store.get().currentId).toBe(copy.id);
    expect(conflicts).toEqual([[expect.stringMatching(/^A \(conflict /)]]);
    // Both are in the account now.
    expect(server.docs.get(copy.id)?.source).toBe(copy.source);
    expect(server.docs.get('a')?.source).toBe('title "A"\nservice theirs\n');
    expect(sync.getStatus()).toEqual({ kind: 'saved' });
  });

  it('offline: keeps editing, says so, queues and retries with backoff', async () => {
    makeSync().start();
    await settle();
    server.online = false;
    type('title "Offline 1"\n');
    await settle(PUSH_DELAY_MS);
    expect(sync.getStatus()).toEqual({ kind: 'offline' });
    type('title "Offline 2"\n');
    expect(store.get().docs[0].source).toBe('title "Offline 2"\n');
    await settle(2000);
    expect(sync.getStatus()).toEqual({ kind: 'offline' });
    server.online = true;
    // The second retry waits twice as long.
    await settle(4000);
    expect(server.docs.get('a')).toMatchObject({ source: 'title "Offline 2"\n', version: 2 });
    expect(sync.getStatus()).toEqual({ kind: 'saved' });
  });

  it('remembers what is pending across reloads', async () => {
    makeSync().start();
    await settle();
    server.online = false;
    type('title "Unsent"\n');
    await settle(PUSH_DELAY_MS);
    sync.stop();
    server.online = true;
    server.calls = [];
    makeSync().start();
    await settle();
    expect(server.calls).toEqual(['list 0', 'put a@1']);
    expect(server.docs.get('a')?.source).toBe('title "Unsent"\n');
  });

  it('does not resend a diagram the server refused until it changes', async () => {
    makeSync().start();
    await settle();
    type('x'.repeat(101));
    await settle(PUSH_DELAY_MS);
    expect(sync.getStatus()).toEqual({ kind: 'saved', note: 'too large' });
    server.calls = [];
    await sync.sync();
    expect(server.calls).toEqual(['list 0']);
    type('small');
    await settle(PUSH_DELAY_MS);
    expect(server.docs.get('a')?.source).toBe('small');
    expect(sync.getStatus()).toEqual({ kind: 'saved' });
  });

  it('turned off: sends nothing; deleting the cloud copies keeps the local ones', async () => {
    makeSync().start();
    await settle();
    sync.setEnabled(false);
    expect(saved?.off).toBe(true);
    server.calls = [];
    type('title "Local only"\n');
    await settle(PUSH_DELAY_MS * 2);
    expect(server.calls).toEqual([]);
    expect(sync.getStatus()).toEqual({ kind: 'off' });
    await sync.deleteCloudCopies();
    expect(server.docs.size).toBe(0);
    expect(store.get().docs[0].source).toBe('title "Local only"\n');
    // Still off after a reload.
    sync.stop();
    makeSync().start();
    await settle();
    expect(sync.getStatus()).toEqual({ kind: 'off' });
    expect(server.calls).toEqual(['remove all']);
    // Turned on again: uploaded as new.
    sync.setEnabled(true);
    await settle();
    expect(server.docs.get('a')).toMatchObject({ source: 'title "Local only"\n', version: 1 });
  });

  it('a 401 stops syncing and reports the sign-out', async () => {
    server.list = async () => {
      throw new SyncError(401, 'Sign in first');
    };
    makeSync().start();
    await settle();
    expect(signedOut).toBe(1);
    expect(sync.getStatus()).toEqual({ kind: 'signed-out' });
  });

  it('another account: the previous one\'s synced diagrams leave, the rest wait for a yes', async () => {
    makeSync('u1').start();
    await settle();
    // Signed out (keeping the diagrams), a diagram made, edits to another not yet sent.
    sync.stop();
    store.set((s) => addDoc(s, 'title "Mine"\n', () => '2026-10-02T00:00:00.000Z', () => 'mine'));
    const u1Docs = server.docs;
    server = new FakeServer();
    server.write({ id: 'theirs', name: 'theirs.proschi', source: 'title "U2"\n', imports: null, version: 1, updatedAt: 0, deletedAt: null });
    makeSync('u2').start();
    await settle(PUSH_DELAY_MS * 2);
    // u1's diagram is gone from this browser (it is in u1's account), u2's arrived, nothing uploaded.
    expect(store.get().docs.map((d) => d.id).sort()).toEqual(['mine', 'theirs']);
    expect(u1Docs.get('a')?.source).toBe('title "A"\n');
    expect(server.calls).toEqual(['list null']);
    expect(sync.askCount()).toBe(1);
    expect(saved?.meta).toMatchObject({ userId: 'u2', held: ['mine'], ask: true });
    // Edits to a held diagram stay in this browser too.
    store.set((s) => updateCurrent({ ...s, currentId: 'mine' }, 'title "Mine 2"\n'));
    await settle(PUSH_DELAY_MS);
    expect(server.calls).toEqual(['list null']);
    sync.answer(true);
    await settle();
    expect(server.docs.get('mine')?.source).toBe('title "Mine 2"\n');
    expect(sync.askCount()).toBe(0);
  });

  it('another account: "keep in this browser only" never uploads them, and asks once', async () => {
    saved = { meta: { userId: 'u1', cursor: 5, docs: { a: { version: 3, fp: 'edited-since' } }, refused: {} } };
    makeSync('u2').start();
    await settle();
    // `a` had edits u1 never got: it stays, held back.
    expect(store.get().docs.map((d) => d.id)).toEqual(['a']);
    expect(sync.askCount()).toBe(1);
    sync.answer(false);
    expect(sync.askCount()).toBe(0);
    expect(sync.heldCount()).toBe(1);
    type('title "Still mine"\n');
    await settle(PUSH_DELAY_MS);
    sync.stop();
    makeSync('u2').start();
    await settle(PUSH_DELAY_MS);
    expect(sync.askCount()).toBe(0);
    expect(server.calls).toEqual(['list null', 'list 0']);
    expect(server.docs.size).toBe(0);
  });

  it('signing out can remove the synced diagrams from this browser, keeping unsent edits', async () => {
    store.set((s) => addDoc(s, 'title "B"\n', () => '2026-10-02T00:00:00.000Z', () => 'b'));
    makeSync().start();
    await settle();
    server.online = false;
    store.set((s) => updateCurrent({ ...s, currentId: 'b' }, 'title "B unsent"\n'));
    expect(sync.forgetSynced()).toBe(1);
    expect(store.get().docs.map((d) => d.id)).toEqual(['b']);
    // Nothing is deleted from the account, and signing in again brings `a` back.
    server.online = true;
    makeSync().start();
    await settle();
    expect(server.docs.get('a')?.deletedAt).toBeNull();
    expect(store.get().docs.map((d) => d.id).sort()).toEqual(['a', 'b']);
    expect(server.docs.get('b')?.source).toBe('title "B unsent"\n');
  });

  describe('the account\'s limit', () => {
    const add = (id: string, day: number) => store.set((s) => addDoc(s, `title "${id}"\n`, () => `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`, () => id));

    it('fills the free slots, keeps the rest in this browser without retrying, and says how full the account is', async () => {
      server.limit = 2;
      makeSync().start();
      await settle();
      expect(sync.getStatus()).toEqual({ kind: 'saved', used: 1, limit: 2 });
      add('b', 2);
      add('c', 3);
      await settle(PUSH_DELAY_MS);
      // The most recently edited takes the last slot; `b` stays here.
      expect([...server.docs.keys()].sort()).toEqual(['a', 'c']);
      expect(sync.getStatus()).toEqual({ kind: 'saved', used: 2, limit: 2 });
      expect([...sync.plan().local]).toEqual(['b']);
      server.calls = [];
      store.set((s) => updateCurrent(selectDoc(s, 'b'), 'title "b2"\n'));
      await settle(PUSH_DELAY_MS * 5);
      await sync.sync();
      expect(server.calls).toEqual(['list 0']);
      // An edit of a diagram the account keeps is still saved.
      store.set((s) => updateCurrent(selectDoc(s, 'a'), 'title "a2"\n'));
      await settle(PUSH_DELAY_MS);
      expect(server.docs.get('a')?.source).toBe('title "a2"\n');
    });

    it('deleting a diagram frees its slot for one waiting in this browser', async () => {
      server.limit = 2;
      add('b', 2);
      makeSync().start();
      await settle();
      add('c', 3);
      await settle(PUSH_DELAY_MS);
      expect(server.docs.has('c')).toBe(false);
      store.set((s) => removeDoc(s, 'a'));
      await settle(PUSH_DELAY_MS);
      expect(server.calls.slice(-2)).toEqual(['delete a@1', 'put c@0']);
      expect(sync.plan().local.size).toBe(0);
    });

    it('a refusal from a full account (another device took the slot) is not retried in a loop', async () => {
      makeSync().start();
      await settle();
      // Another device filled the account since the last pull.
      server.limit = 1;
      server.write({ id: 'other', name: 'other.proschi', source: 'x', imports: null, version: 1, updatedAt: 0, deletedAt: null });
      server.limit = 2;
      add('b', 2);
      await settle(PUSH_DELAY_MS);
      expect(server.calls.filter((c) => c === 'put b@0')).toHaveLength(1);
      await settle(PUSH_DELAY_MS * 10);
      expect(server.calls.filter((c) => c === 'put b@0')).toHaveLength(1);
      expect(sync.getStatus()).toMatchObject({ kind: 'saved' });
      expect(sync.plan().local.has('b')).toBe(true);
    });

    it('move to this browser only, and keep in cloud', async () => {
      server.limit = 2;
      add('b', 2);
      makeSync().start();
      await settle();
      add('c', 3);
      await settle(PUSH_DELAY_MS);
      sync.moveToBrowser('a');
      await settle();
      expect(server.docs.get('a')?.deletedAt).not.toBeNull();
      expect(server.docs.get('c')?.deletedAt).toBeNull();
      expect([...sync.plan().local]).toEqual(['a']);
      expect(store.get().docs.map((d) => d.id).sort()).toEqual(['a', 'b', 'c']);
      // Back in the cloud once a slot is free.
      sync.moveToBrowser('b');
      await settle();
      sync.keepInCloud('a');
      await settle();
      expect(server.docs.get('a')?.deletedAt).toBeNull();
      expect([...sync.plan().local]).toEqual(['b']);
    });

    it('another account: offers to add only as many diagrams as fit', async () => {
      saved = { meta: { userId: 'u1', cursor: 5, docs: {}, refused: {} } };
      add('b', 2);
      add('c', 3);
      server.limit = 2;
      server.write({ id: 'theirs', name: 'theirs.proschi', source: 'title "U2"\n', imports: null, version: 1, updatedAt: 0, deletedAt: null });
      makeSync('u2').start();
      await settle();
      expect(sync.askCount()).toBe(1);
      sync.answer(true);
      await settle();
      expect(server.live()).toBe(2);
      expect(server.docs.has('c')).toBe(true);
      expect([...sync.plan().local].sort()).toEqual(['a', 'b']);
      expect(sync.getStatus()).toEqual({ kind: 'saved', used: 2, limit: 2 });
    });
  });
});
