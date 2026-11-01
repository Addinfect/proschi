import { MAX_PATH_LENGTH, fileMap, isRecord } from './sanitize';

/** A diagram saved in this browser. Its name comes from the `title` line. */
export interface SavedDiagram {
  id: string;
  source: string;
  updatedAt: string;
  /**
   * Name imports use for it: the file it was opened from, or one made from its
   * title when it was created. It does not follow later title edits, so imports
   * of it keep working; only renaming the file changes it.
   */
  fileName?: string;
  /**
   * Imported files (path → source) that came with a share link. They win over
   * saved diagrams of the same name, so the link renders as it was shared.
   * Never `cloud:` files (storedImports): those are fetched again each time.
   */
  imports?: Record<string, string>;
}

/** Whether an imports key is a `cloud:` version or a file saved with one (`cloud:<name>:<tag>//<path>`). */
const isCloudKey = (path: string): boolean => /^cloud:/i.test(path);

/**
 * The imports a diagram keeps (in this browser, the account and its saved
 * versions): all but `cloud:` files, which are fetched from the account each
 * time, so a share link's copies never get saved, synced or frozen into a
 * version. Undefined when nothing is left.
 */
export function storedImports(imports: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!imports) return undefined;
  const kept = Object.fromEntries(Object.entries(imports).filter(([path]) => !isCloudKey(path)));
  return Object.keys(kept).length ? kept : undefined;
}

/** The `cloud:` files of a share link's imports, used only while it is open where a version cannot be fetched. */
export function cloudImports(imports: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(imports ?? {}).filter(([path]) => isCloudKey(path)));
}

export interface DocumentState {
  docs: SavedDiagram[];
  currentId: string;
}

export const BLANK_SOURCE = 'title "Untitled"\n\n';

/** Where the editor keeps its diagrams (DocumentState), in localStorage. */
export const DOCS_KEY = 'proschi.docs';
/** Cloud sync's state and setting (StoredSync in sync.ts), in localStorage. */
export const SYNC_KEY = 'proschi.docs.sync';

/**
 * One saved diagram read from storage or a backup: its id and source must be
 * strings; a bad date, file name or imports map is dropped, not fatal.
 */
export function readDiagram(value: unknown): SavedDiagram | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.source !== 'string') return null;
  const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString();
  const fileName = typeof value.fileName === 'string' && value.fileName.trim() && value.fileName.length <= MAX_PATH_LENGTH ? value.fileName : undefined;
  const imports = storedImports(fileMap(value.imports));
  return { id: value.id, source: value.source, updatedAt, ...(fileName ? { fileName } : {}), ...(imports ? { imports } : {}) };
}

/**
 * The saved state as read from localStorage, which may be missing, damaged or
 * hand-edited: well-formed diagrams are kept (the first of each id), the rest
 * dropped. Null when no diagram is left.
 */
export function readState(value: unknown): DocumentState | null {
  if (!isRecord(value) || !Array.isArray(value.docs)) return null;
  const seen = new Set<string>();
  const docs: SavedDiagram[] = [];
  for (const item of value.docs) {
    const doc = readDiagram(item);
    if (doc && !seen.has(doc.id)) {
      seen.add(doc.id);
      docs.push(doc);
    }
  }
  if (docs.length === 0) return null;
  const currentId = typeof value.currentId === 'string' && seen.has(value.currentId) ? value.currentId : docs[0].id;
  return { docs, currentId };
}

type Clock = () => string;
type IdFactory = () => string;

export const defaultClock: Clock = () => new Date().toISOString();
export const defaultIds: IdFactory = () => `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

interface InitialInput {
  /** What localStorage held; checked here, since it may be damaged. */
  stored: unknown;
  /** Source from the editor before named diagrams existed. */
  legacySource: unknown;
  /** Source from a `#code=` share link, or from an example link (`?example=<id>`). */
  sharedSource: string | null;
  /** Imported files carried by the share link. */
  sharedImports?: Record<string, string>;
  fallbackSource: string;
}

/**
 * Builds the starting state. A share link opens its diagram, reusing an
 * identical saved one so reloading a shared URL never piles up copies.
 */
export function initialState(input: InitialInput, now: Clock = defaultClock, newId: IdFactory = defaultIds): DocumentState {
  const valid = readState(input.stored);
  let docs = valid ? [...valid.docs] : [];
  let currentId = valid?.currentId ?? '';

  if (docs.length === 0 && typeof input.legacySource === 'string' && input.legacySource && input.legacySource !== input.sharedSource) {
    docs.push({ id: newId(), source: input.legacySource, updatedAt: now() });
  }

  if (input.sharedSource !== null) {
    const kept = storedImports(input.sharedImports);
    const imports = kept ? { imports: kept } : {};
    const existing = docs.find((d) => d.source === input.sharedSource);
    if (existing) {
      currentId = existing.id;
      if (imports.imports) docs = docs.map((d) => (d === existing ? { ...d, ...imports } : d));
    } else {
      const doc = { id: newId(), source: input.sharedSource, updatedAt: now(), ...imports };
      docs = [doc, ...docs];
      currentId = doc.id;
    }
  }

  if (docs.length === 0) docs.push({ id: newId(), source: input.fallbackSource, updatedAt: now() });
  if (!docs.some((d) => d.id === currentId)) currentId = docs[0].id;
  return { docs: nameDocs(docs), currentId };
}

export function currentDoc(state: DocumentState): SavedDiagram {
  return state.docs.find((d) => d.id === state.currentId) ?? state.docs[0];
}

export function updateCurrent(state: DocumentState, source: string, now: Clock = defaultClock): DocumentState {
  if (currentDoc(state).source === source) return state;
  return {
    ...state,
    docs: state.docs.map((d) => (d.id === state.currentId ? { ...d, source, updatedAt: now() } : d)),
  };
}

/** Changes the text of the diagram `id`, e.g. a team file edited while navigated into it from the org diagram. */
export function updateDoc(state: DocumentState, id: string, source: string, now: Clock = defaultClock): DocumentState {
  if (state.docs.find((d) => d.id === id)?.source === source) return state;
  return { ...state, docs: state.docs.map((d) => (d.id === id ? { ...d, source, updatedAt: now() } : d)) };
}

/**
 * Adds the files a diagram imports (path → source) as diagrams of those file
 * names, so its imports resolve and the files can be edited; a file name
 * already saved keeps its diagram, so opening the same example again adds nothing.
 */
export function addFiles(state: DocumentState, files: Readonly<Record<string, string>>, now: Clock = defaultClock, newId: IdFactory = defaultIds): DocumentState {
  const taken = new Set(state.docs.map(fileNameOf));
  const added = Object.entries(files)
    .filter(([path]) => !taken.has(path))
    .map(([fileName, source]) => ({ id: newId(), source, updatedAt: now(), fileName }));
  return added.length ? { ...state, docs: [...state.docs, ...added] } : state;
}

export function addDoc(state: DocumentState, source: string, now: Clock = defaultClock, newId: IdFactory = defaultIds): DocumentState {
  const doc = { id: newId(), source, updatedAt: now() };
  return { docs: nameDocs([doc, ...state.docs]), currentId: doc.id };
}

/** Adds a diagram opened from a file, remembering the file's name so imports can find it. */
export function addFile(state: DocumentState, source: string, fileName: string, now: Clock = defaultClock, newId: IdFactory = defaultIds): DocumentState {
  const next = addDoc(state, source, now, newId);
  return { ...next, docs: next.docs.map((d) => (d.id === next.currentId ? { ...d, fileName } : d)) };
}

/** Renames a diagram's file; `.proschi` is added when missing. Imports of the old name stop resolving. */
export function renameFile(state: DocumentState, id: string, fileName: string): DocumentState {
  const clean = fileName.trim().replace(/^\/+/, '');
  if (!clean) return state;
  const name = clean.endsWith('.proschi') ? clean : `${clean}.proschi`;
  return { ...state, docs: state.docs.map((d) => (d.id === id ? { ...d, fileName: name } : d)) };
}

export function selectDoc(state: DocumentState, id: string): DocumentState {
  return state.docs.some((d) => d.id === id) ? { ...state, currentId: id } : state;
}

/** Deletes a diagram; deleting the last one leaves a blank diagram behind. */
export function removeDoc(state: DocumentState, id: string, now: Clock = defaultClock, newId: IdFactory = defaultIds): DocumentState {
  const docs = state.docs.filter((d) => d.id !== id);
  if (docs.length === 0) return addDoc({ docs: [], currentId: '' }, BLANK_SOURCE, now, newId);
  return { docs, currentId: state.currentId === id ? docs[0].id : state.currentId };
}

/** Nothing but a title, comments and blank lines: a diagram that has not been started. */
export function isBlank(source: string): boolean {
  return source.split('\n').every((line) => /^\s*(?:#.*)?$/.test(line) || /^\s*title\b/.test(line));
}

/** Diagram name from its `title` line, without parsing the whole document. */
/**
 * Opens a diagram that came from elsewhere (a short link): the saved copy
 * with the same text, or a new diagram at the top, as a `#code=` link opens.
 */
export function openShared(state: DocumentState, source: string, imports?: Record<string, string>, now: Clock = defaultClock, newId: IdFactory = defaultIds): DocumentState {
  return initialState({ stored: state, legacySource: null, sharedSource: source, sharedImports: imports, fallbackSource: source }, now, newId);
}

export function titleOf(source: string): string {
  const match = source.match(/^[ \t]*title[ \t]+(?:"((?:[^"\\]|\\.)*)"|([A-Za-z_]\w*))/m);
  const title = match ? (match[1] ?? match[2]).replace(/\\(.)/g, '$1').trim() : '';
  return title || 'Untitled';
}

/** The name imports use for a diagram: its file name, or one made from its title. */
export function fileNameOf(doc: Pick<SavedDiagram, 'source' | 'fileName'>): string {
  return doc.fileName || derivedFileName(doc.source);
}

/**
 * Gives each diagram without a file name one made from its title, unique
 * among the others (`untitled-2.proschi`). Saved diagrams from before file
 * names existed get theirs here, once.
 */
function nameDocs(docs: SavedDiagram[]): SavedDiagram[] {
  if (docs.every((d) => d.fileName)) return docs;
  const taken = new Set(docs.flatMap((d) => (d.fileName ? [d.fileName] : [])));
  return docs.map((d) => {
    if (d.fileName) return d;
    const base = derivedFileName(d.source).slice(0, -'.proschi'.length);
    let name = `${base}.proschi`;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}.proschi`;
    taken.add(name);
    return { ...d, fileName: name };
  });
}

function derivedFileName(source: string): string {
  const slug = titleOf(source)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${slug || 'diagram'}.proschi`;
}
