import { BLANK_SOURCE, defaultClock, defaultIds, fileNameOf, storedImports, titleOf, type DocumentState, type SavedDiagram } from './documents';
import { fileMap, isRecord, isSafeKey } from './sanitize';

/**
 * Cloud sync of the editor's diagrams, the pure part: what the page and the
 * account (GET/PUT/DELETE /api/me/documents, backend/src/documents.ts) need
 * to send each other, and how what the server answers merges into the
 * diagrams in this browser. Nothing here touches the network or storage;
 * cloudSync.ts does, on a timer.
 *
 * The browser remembers, per diagram it synced, the server's version and a
 * fingerprint of the content at that version. A diagram whose content no
 * longer matches its fingerprint was edited here and is sent with that
 * version as its base; one remembered but gone was deleted here. When both
 * sides changed, neither wins silently: the server's copy keeps the id and
 * this browser's is kept beside it, renamed "<name> (conflict <date>)".
 */

/** A document as the account keeps it (CloudDocument in backend/src/documents.ts). */
export interface RemoteDoc {
  id: string;
  name: string;
  source: string;
  imports: Record<string, string> | null;
  version: number;
  /** Unix milliseconds, the server's clock. */
  updatedAt: number;
  /** Unix milliseconds; null unless deleted (a tombstone). */
  deletedAt: number | null;
}

export interface SyncMeta {
  /** The account this was synced with; another account starts over, like a first sign-in. */
  userId: string;
  /** The server's time of the last pull (GET ?since=); null before the first. */
  cursor: number | null;
  /** Per diagram synced: the server's version and the fingerprint of its content then. */
  docs: Record<string, { version: number; fp: string }>;
  /** Diagrams the server refused (too large, account full), with their fingerprint then: not sent again until they change. */
  refused: Record<string, string>;
  /**
   * Diagrams found in this browser when another account signed in: never
   * uploaded to this one unless the user says so (`ask` until they answer).
   */
  held?: string[];
  /** Whether to ask "Add N diagrams from this browser to your account?". */
  ask?: boolean;
  /** How many diagrams the account may keep (GET's `limit`); unknown until the first pull. */
  limit?: number;
  /** Diagrams the user moved to this browser only: never sent, and their cloud copy is deleted. */
  localOnly?: string[];
  /** Diagrams the user chose to keep in the account: first in line for a free slot. */
  keep?: string[];
}

/** What `proschi.docs.sync` holds. */
export interface StoredSync {
  /** Cloud sync turned off in this browser: diagrams stay local only. */
  off?: boolean;
  meta?: SyncMeta;
}

/** A write to send: a diagram edited here (`put`), or one deleted here (`delete`). */
export type SyncOp =
  | { kind: 'put'; id: string; baseVersion: number; fp: string; body: { name: string; source: string; imports: Record<string, string> | null } }
  | { kind: 'delete'; id: string; baseVersion: number };

export const emptyMeta = (userId: string): SyncMeta => ({ userId, cursor: null, docs: {}, refused: {} });

/** `proschi.docs.sync` as stored, which may be damaged: what is well-formed is kept. */
export function readStoredSync(value: unknown): StoredSync {
  if (!isRecord(value)) return {};
  const out: StoredSync = value.off === true ? { off: true } : {};
  const meta = value.meta;
  if (isRecord(meta) && typeof meta.userId === 'string') {
    const docs: SyncMeta['docs'] = {};
    if (isRecord(meta.docs)) {
      for (const [id, entry] of Object.entries(meta.docs)) {
        if (isSafeKey(id) && isRecord(entry) && Number.isSafeInteger(entry.version) && typeof entry.fp === 'string') docs[id] = { version: entry.version as number, fp: entry.fp };
      }
    }
    const refused: SyncMeta['refused'] = {};
    if (isRecord(meta.refused)) for (const [id, fp] of Object.entries(meta.refused)) if (isSafeKey(id) && typeof fp === 'string') refused[id] = fp;
    const cursor = typeof meta.cursor === 'number' && Number.isFinite(meta.cursor) ? meta.cursor : null;
    const held = Array.isArray(meta.held) ? meta.held.filter((id): id is string => typeof id === 'string') : [];
    const ids = (value: unknown) => (Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []);
    const localOnly = ids(meta.localOnly);
    const keep = ids(meta.keep);
    const limit = Number.isSafeInteger(meta.limit) && (meta.limit as number) >= 0 ? (meta.limit as number) : undefined;
    out.meta = {
      userId: meta.userId,
      cursor,
      docs,
      refused,
      ...(held.length ? { held } : {}),
      ...(meta.ask === true && held.length ? { ask: true } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(localOnly.length ? { localOnly } : {}),
      ...(keep.length ? { keep } : {}),
    };
  }
  return out;
}

/** cyrb53: a fast 53-bit string hash, plenty to tell edits apart. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function contentFingerprint(name: string, source: string, imports: Record<string, string> | null | undefined): string {
  const files = imports ? Object.entries(imports).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) : [];
  return `${source.length}:${hash(JSON.stringify([name, source, files]))}`;
}

// Diagrams are immutable values, so each is hashed once, not on every keystroke.
const fingerprints = new WeakMap<SavedDiagram, string>();

/** The fingerprint of what syncs of a diagram: its file name, source and imports. */
export function fingerprint(doc: SavedDiagram): string {
  let fp = fingerprints.get(doc);
  if (fp === undefined) {
    fp = contentFingerprint(fileNameOf(doc), doc.source, doc.imports);
    fingerprints.set(doc, fp);
  }
  return fp;
}

export const remoteFingerprint = (doc: RemoteDoc): string => contentFingerprint(doc.name, doc.source, doc.imports);

/** The server's copy as a diagram in this browser. */
export function toLocal(doc: RemoteDoc): SavedDiagram {
  const imports = storedImports(fileMap(doc.imports));
  return { id: doc.id, source: doc.source, fileName: doc.name, updatedAt: new Date(doc.updatedAt).toISOString(), ...(imports ? { imports } : {}) };
}

/** "2026-10-06 14:05" in local time, for a conflict copy's name. */
function stamp(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const TITLE_LINE = /^([ \t]*)title[ \t]+(?:"(?:[^"\\]|\\.)*"|[A-Za-z_]\w*)/m;

/** The source with its `title` line saying `title` (one is added when missing). */
export function retitle(source: string, title: string): string {
  const quoted = `"${title.replace(/["\\]/g, '\\$&')}"`;
  return TITLE_LINE.test(source) ? source.replace(TITLE_LINE, (_, indent: string) => `${indent}title ${quoted}`) : `title ${quoted}\n${source}`;
}

/** This browser's side of a conflict, under a new id and a name that says so: "<name> (conflict <date>)". */
export function conflictCopy(doc: SavedDiagram, id: string, now: string): SavedDiagram {
  const when = stamp(now);
  const base = fileNameOf(doc).replace(/\.proschi$/, '');
  return { ...doc, id, source: retitle(doc.source, `${titleOf(doc.source)} (conflict ${when})`), fileName: `${base} (conflict ${when}).proschi`, updatedAt: now };
}

export interface MergeResult {
  state: DocumentState;
  meta: SyncMeta;
  /** The titles of conflict copies made, to tell the user. */
  conflicts: string[];
}

/**
 * Merges the server's changes (a pull, or the copy a 409 answered with)
 * into this browser's diagrams. For each:
 *
 * - already seen (its version is not newer): nothing;
 * - deleted there: deleted here too, unless edited here, then restored by the next push;
 * - unknown here, or deleted here while it changed there: added (an edit beats a delete);
 * - unchanged here, or changed to the same content: the server's copy is taken;
 * - changed on both sides: the server's copy keeps the id, this browser's
 *   is kept as a conflict copy, and stays the open one if it was.
 *
 * On the first sync with an account (no cursor yet), a diagram never synced
 * that is identical to one the account has (the starter example on a new
 * device, say) is dropped instead of being uploaded twice.
 */
export function applyRemote(state: DocumentState, meta: SyncMeta, remotes: RemoteDoc[], now = defaultClock, newId = defaultIds): MergeResult {
  const docs = [...state.docs];
  let currentId = state.currentId;
  const known: SyncMeta['docs'] = { ...meta.docs };
  const conflicts: string[] = [];
  const held = [...(meta.held ?? [])];
  const localOnly = new Set(meta.localOnly ?? []);
  let changed = false;

  for (const remote of remotes) {
    // Ids name properties of `known`.
    if (!isSafeKey(remote.id)) continue;
    const seen = known[remote.id];
    if (seen && remote.version <= seen.version) continue;
    if (localOnly.has(remote.id)) {
      // Moved to this browser only: the copy here wins; the cloud copy is deleted at its latest version.
      if (remote.deletedAt !== null) delete known[remote.id];
      else if (seen) known[remote.id] = { version: remote.version, fp: seen.fp };
      continue;
    }
    const i = docs.findIndex((d) => d.id === remote.id);
    const local = i >= 0 ? docs[i] : undefined;
    const dirty = local !== undefined && fingerprint(local) !== seen?.fp;

    if (remote.deletedAt !== null) {
      if (local && dirty) {
        // Edited here: kept, and sent on top of the tombstone, which restores it.
        known[remote.id] = { version: remote.version, fp: '' };
        continue;
      }
      if (local) {
        docs.splice(i, 1);
        changed = true;
      }
      delete known[remote.id];
      continue;
    }

    const remoteFp = remoteFingerprint(remote);
    known[remote.id] = { version: remote.version, fp: remoteFp };
    if (!local) {
      docs.push(toLocal(remote));
      changed = true;
    } else if (!dirty || fingerprint(local) === remoteFp) {
      if (fingerprint(local) !== remoteFp) {
        docs[i] = toLocal(remote);
        changed = true;
      }
    } else {
      const copy = conflictCopy(local, newId(), now());
      // A copy of a diagram held back from this account is held back too.
      if (meta.held?.includes(remote.id)) held.push(copy.id);
      docs.splice(i, 1, toLocal(remote), copy);
      if (currentId === remote.id) currentId = copy.id;
      conflicts.push(titleOf(copy.source));
      changed = true;
    }
  }

  if (meta.cursor === null) {
    const has = (id: string) => Object.hasOwn(known, id);
    const synced = new Map(docs.filter((d) => has(d.id)).map((d) => [known[d.id].fp, d.id]));
    for (let i = docs.length - 1; i >= 0; i--) {
      const twin = !has(docs[i].id) && synced.get(fingerprint(docs[i]));
      if (twin) {
        if (currentId === docs[i].id) currentId = twin;
        docs.splice(i, 1);
        changed = true;
      }
    }
  }

  const nextMeta: SyncMeta = { ...meta, docs: known, ...(held.length ? { held } : {}) };
  if (!changed) return { state, meta: nextMeta, conflicts };
  if (docs.length === 0) docs.push({ id: newId(), source: BLANK_SOURCE, fileName: 'untitled.proschi', updatedAt: now() });
  if (!docs.some((d) => d.id === currentId)) currentId = docs[0].id;
  return { state: { docs, currentId }, meta: nextMeta, conflicts };
}

/** Which diagrams in this browser are in the account and which stay here, under the account's limit. */
export interface CloudPlan {
  /** Diagrams kept in (or on their way to) the account. */
  cloud: Set<string>;
  /** Diagrams that stay in this browser only: moved here, held back, refused, or past the limit. */
  local: Set<string>;
  /** `cloud.size`: the slots taken. */
  used: number;
  /** The account's limit; null while unknown (before the first pull). */
  limit: number | null;
  /** Slots still free after this plan. */
  free: number;
}

/**
 * Decides, deterministically, which diagrams sync under the account's limit:
 *
 * - a diagram the account already keeps keeps its slot;
 * - the others (never synced, or deleted there and edited here) take the free
 *   slots: those the user chose to keep in the cloud first, then the most
 *   recently edited (ties by id);
 * - the rest stay in this browser only, never lost and never retried until a
 *   slot frees up, as do diagrams moved to this browser only, held back from
 *   this account, or refused by the server since their last change.
 *
 * A new blank diagram takes no slot until something is typed into it.
 */
export function cloudPlan(state: DocumentState, meta: SyncMeta): CloudPlan {
  const held = new Set(meta.held ?? []);
  const localOnly = new Set(meta.localOnly ?? []);
  const keep = meta.keep ?? [];
  const cloud = new Set<string>();
  const local = new Set<string>();
  const candidates: SavedDiagram[] = [];
  const blank: string[] = [];
  for (const d of state.docs) {
    if (!isSafeKey(d.id) || held.has(d.id) || localOnly.has(d.id)) {
      local.add(d.id);
      continue;
    }
    const known = Object.hasOwn(meta.docs, d.id) ? meta.docs[d.id] : undefined;
    // fp '' is a diagram deleted in the account but edited here: restoring it needs a slot.
    if (known && known.fp !== '') cloud.add(d.id);
    else if (meta.refused[d.id] === fingerprint(d)) local.add(d.id);
    else if (!known && d.source === BLANK_SOURCE) blank.push(d.id);
    else candidates.push(d);
  }
  const limit = meta.limit ?? null;
  let free = Math.max(0, (limit ?? Infinity) - cloud.size);
  const rank = (d: SavedDiagram) => {
    const i = keep.indexOf(d.id);
    return i < 0 ? keep.length : i;
  };
  candidates.sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const d of candidates) {
    if (free > 0) {
      cloud.add(d.id);
      free--;
    } else local.add(d.id);
  }
  if (free === 0) for (const id of blank) local.add(id);
  return { cloud, local, used: cloud.size, limit, free: Number.isFinite(free) ? free : Number.MAX_SAFE_INTEGER };
}

/**
 * The writes waiting to be sent: first the deletes (diagrams deleted here, or
 * moved to this browser only), which free slots, then the diagrams edited or
 * made here that have a slot (cloudPlan), oldest first.
 */
export function pendingOps(state: DocumentState, meta: SyncMeta): SyncOp[] {
  const ops: SyncOp[] = [];
  const plan = cloudPlan(state, meta);
  const localOnly = new Set(meta.localOnly ?? []);
  const here = new Set(state.docs.map((d) => d.id));
  for (const [id, { version }] of Object.entries(meta.docs)) if (!here.has(id) || localOnly.has(id)) ops.push({ kind: 'delete', id, baseVersion: version });
  const edited = state.docs.filter((d) => {
    if (!plan.cloud.has(d.id)) return false;
    const fp = fingerprint(d);
    return fp !== meta.docs[d.id]?.fp && meta.refused[d.id] !== fp;
  });
  for (const d of [...edited].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))) {
    ops.push({
      kind: 'put',
      id: d.id,
      baseVersion: meta.docs[d.id]?.version ?? 0,
      fp: fingerprint(d),
      body: { name: fileNameOf(d), source: d.source, imports: d.imports ?? null },
    });
  }
  return ops;
}

/** "Move to this browser only": the diagram stops syncing and its cloud copy is deleted (pendingOps). */
export function moveToBrowser(meta: SyncMeta, id: string): SyncMeta {
  const localOnly = [...new Set([...(meta.localOnly ?? []), id])];
  const keep = (meta.keep ?? []).filter((k) => k !== id);
  const next: SyncMeta = { ...meta, localOnly };
  if (keep.length) next.keep = keep;
  else delete next.keep;
  return next;
}

/** "Keep in cloud": the diagram syncs again, first in line for a free slot. */
export function keepInCloud(meta: SyncMeta, id: string): SyncMeta {
  const next: SyncMeta = { ...meta, keep: [...(meta.keep ?? []).filter((k) => k !== id), id] };
  const localOnly = (meta.localOnly ?? []).filter((k) => k !== id);
  if (localOnly.length) next.localOnly = localOnly;
  else delete next.localOnly;
  const held = (meta.held ?? []).filter((k) => k !== id);
  if (held.length) next.held = held;
  else {
    delete next.held;
    delete next.ask;
  }
  const refused = { ...meta.refused };
  delete refused[id];
  next.refused = refused;
  return next;
}

/** After the server saved a put: its version, and the fingerprint of what was sent (later edits stay pending). */
export function afterPut(meta: SyncMeta, op: Extract<SyncOp, { kind: 'put' }>, saved: RemoteDoc): SyncMeta {
  const refused = { ...meta.refused };
  delete refused[op.id];
  const next: SyncMeta = { ...meta, docs: { ...meta.docs, [op.id]: { version: saved.version, fp: op.fp } }, refused };
  const keep = (meta.keep ?? []).filter((k) => k !== op.id);
  if (keep.length) next.keep = keep;
  else delete next.keep;
  return next;
}

/**
 * After the server deleted a diagram (or did not have it). The slot it frees
 * may take a new diagram the server refused while the account was full, so
 * refusals of diagrams never synced are tried again.
 */
export function afterDelete(meta: SyncMeta, id: string): SyncMeta {
  const docs = { ...meta.docs };
  delete docs[id];
  const refused: SyncMeta['refused'] = {};
  for (const [rid, fp] of Object.entries(meta.refused)) if (Object.hasOwn(docs, rid)) refused[rid] = fp;
  return { ...meta, docs, refused };
}

/**
 * After the server refused a put (413 too large, or 409 document_limit with
 * the account full): not sent again until the diagram changes (or, for the
 * limit, a delete frees a slot). `limit` is the account's, when it said.
 */
export function afterRefused(meta: SyncMeta, op: Extract<SyncOp, { kind: 'put' }>, limit?: number): SyncMeta {
  return { ...meta, refused: { ...meta.refused, [op.id]: op.fp }, ...(limit !== undefined ? { limit } : {}) };
}

/** The diagrams held back from the account (another account's, or there before it) still in this browser. */
export function heldDocs(state: DocumentState, meta: SyncMeta): SavedDiagram[] {
  const held = new Set(meta.held ?? []);
  return state.docs.filter((d) => held.has(d.id));
}

/** The user's answer to "Add N diagrams from this browser to your account?". */
export function answerAsk(meta: SyncMeta, add: boolean): SyncMeta {
  const next = { ...meta };
  delete next.ask;
  if (add) delete next.held;
  return next;
}

/**
 * Removes from this browser the diagrams synced with `meta`'s account and
 * unchanged since (they are safe in the account); those with edits not yet
 * sent stay. The account's sync starts over (no cursor) so signing in again
 * brings them back, and their entries go, so nothing is deleted from the
 * account. Null state when no diagram is left.
 */
export function forgetSynced(state: DocumentState, meta: SyncMeta): { state: DocumentState | null; meta: SyncMeta; removed: number } {
  const clean = new Set(state.docs.filter((d) => Object.hasOwn(meta.docs, d.id) && meta.docs[d.id].fp === fingerprint(d)).map((d) => d.id));
  const docs = state.docs.filter((d) => !clean.has(d.id));
  const known: SyncMeta['docs'] = {};
  for (const d of docs) if (Object.hasOwn(meta.docs, d.id)) known[d.id] = meta.docs[d.id];
  const next: SyncMeta = { ...meta, cursor: null, docs: known };
  if (docs.length === 0) return { state: null, meta: next, removed: clean.size };
  return { state: { docs, currentId: docs.some((d) => d.id === state.currentId) ? state.currentId : docs[0].id }, meta: next, removed: clean.size };
}

/**
 * Another account signed in on a browser synced with `previous`'s: the
 * previous account's synced diagrams leave this browser (they are safe in
 * that account), and every diagram left (never synced, or with edits not yet
 * sent) is held back from the new account until the user agrees to add it.
 * The new account starts with a fresh sync state.
 */
export function switchAccount(state: DocumentState, previous: SyncMeta, userId: string, now = defaultClock, newId = defaultIds): { state: DocumentState; meta: SyncMeta } {
  const forgotten = forgetSynced(state, previous);
  const next = forgotten.state ?? { docs: [{ id: newId(), source: BLANK_SOURCE, fileName: 'untitled.proschi', updatedAt: now() }], currentId: '' };
  const docs = next.docs;
  const currentId = docs.some((d) => d.id === next.currentId) ? next.currentId : docs[0].id;
  const held = docs.filter((d) => d.source !== BLANK_SOURCE).map((d) => d.id);
  return { state: { docs, currentId }, meta: { ...emptyMeta(userId), ...(held.length ? { held, ask: true } : {}) } };
}
