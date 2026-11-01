import { describe, expect, it } from 'vitest';
import { parse } from '../dsl';
import { BLANK_SOURCE, addDoc, addFile, addFiles, fileNameOf, initialState, renameFile, selectDoc, updateCurrent, updateDoc, type SavedDiagram } from './documents';
import { filesResolver, importableFiles, teamFileOf, usedImports } from './imports';
import { DRONE_ORG_PATH, DRONE_TEAM_FILES, droneOrgSource } from './droneStartup';

const doc = (id: string, source: string, extra: Partial<SavedDiagram> = {}): SavedDiagram => ({ id, source, updatedAt: '2026-01-01', ...extra });

describe('file names of saved diagrams', () => {
  it('uses the opened file name, or one derived from the title', () => {
    expect(fileNameOf({ source: 'title "Shared Infra"', fileName: 'infra.proschi' })).toBe('infra.proschi');
    expect(fileNameOf({ source: 'title "Shared Infra!"' })).toBe('shared-infra.proschi');
    expect(fileNameOf({ source: 'a -> b' })).toBe('untitled.proschi');
    expect(fileNameOf({ source: 'title "☕"' })).toBe('diagram.proschi');
  });

  it('names a diagram once, so editing its title does not break imports of it', () => {
    const empty = { docs: [], currentId: '' };
    let state = addDoc(empty, 'title "Shop Infra"', () => 't', () => 'infra');
    state = addDoc(state, 'title "Shop"\nimport "shop-infra.proschi"\nusecase "U" {\n  api -> db\n}', () => 't', () => 'shop');
    state = updateCurrent(selectDoc(state, 'infra'), 'title "Platform"\napi [REST API]\ndb [Redis]\napi -> db');
    expect(state.docs.map((d) => d.fileName)).toEqual(['shop.proschi', 'shop-infra.proschi']);

    const shop = state.docs[0];
    const files = importableFiles(state.docs, shop);
    const result = parse(shop.source, { path: fileNameOf(shop), resolve: filesResolver(files, fileNameOf(shop)) });
    expect(result.diagnostics).toEqual([]);
    expect(result.diagram.nodes.map((n) => n.loc.file)).toEqual(['shop-infra.proschi', 'shop-infra.proschi']);
  });

  it('keeps derived names unique and assigns them to diagrams saved before names existed', () => {
    const stored = {
      docs: [
        { id: 'a', source: 'title "Untitled"', updatedAt: 't' },
        { id: 'b', source: 'x -> y', updatedAt: 't' },
        { id: 'c', source: 'title "Named"', updatedAt: 't', fileName: 'mine.proschi' },
      ],
      currentId: 'a',
    };
    const state = initialState({ stored, legacySource: null, sharedSource: null, fallbackSource: 'x' });
    expect(state.docs.map((d) => d.fileName)).toEqual(['untitled.proschi', 'untitled-2.proschi', 'mine.proschi']);
    expect(addDoc(state, BLANK_SOURCE).docs[0].fileName).toBe('untitled-3.proschi');
  });

  it('renames a file on request', () => {
    const state = addDoc({ docs: [], currentId: '' }, 'title "A"', () => 't', () => 'a');
    expect(renameFile(state, 'a', ' teams/payments ').docs[0].fileName).toBe('teams/payments.proschi');
    expect(renameFile(state, 'a', 'x.proschi').docs[0].fileName).toBe('x.proschi');
    expect(renameFile(state, 'a', '   ')).toBe(state);
  });

  it('remembers the name of an opened file', () => {
    const state = addFile(initialState({ stored: null, legacySource: null, sharedSource: null, fallbackSource: 'x' }), 'y', 'infra.proschi');
    expect(state.docs[0]).toMatchObject({ source: 'y', fileName: 'infra.proschi' });
  });
});

describe('imports in the browser', () => {
  const infra = doc('i', 'title "Infra"\napi [REST API]\ndb [Redis]\napi -> db', { fileName: 'infra.proschi' });
  const root = doc('root', 'title "Shop"\nimport "infra.proschi"\nusecase "U" {\n  api -> db : GET /x\n}');

  it('resolves imports against the other saved diagrams', () => {
    const files = importableFiles([root, infra], root);
    expect(Object.keys(files)).toEqual(['infra.proschi']);
    const result = parse(root.source, { path: fileNameOf(root), resolve: filesResolver(files, fileNameOf(root)) });
    expect(result.diagnostics).toEqual([]);
    expect(result.diagram.nodes.map((n) => n.id)).toEqual(['api', 'db']);
    expect(usedImports(result, files, fileNameOf(root))).toEqual({ 'infra.proschi': infra.source });
  });

  it('lets the most recently changed diagram win a name clash', () => {
    const older = doc('o', 'old', { fileName: 'infra.proschi', updatedAt: '2025-01-01' });
    expect(importableFiles([root, infra, older], root)['infra.proschi']).toBe(infra.source);
  });

  it('prefers files carried by a share link', () => {
    const shared = { ...root, imports: { 'infra.proschi': 'api [GraphQL]\ndb [Redis]' } };
    const files = importableFiles([shared, infra], shared);
    const result = parse(root.source, { path: 'shop.proschi', resolve: filesResolver(files, 'shop.proschi') });
    expect(result.diagram.nodes[0].techStack).toBe('GraphQL');
  });

  it('reports a cycle back to the document being edited', () => {
    const src = 'title "Shop"\nimport "loop.proschi"';
    const loop = doc('l', 'import "shop.proschi"', { fileName: 'loop.proschi' });
    const files = importableFiles([doc('root', src), loop], doc('root', src));
    const result = parse(src, { path: 'shop.proschi', resolve: filesResolver(files, 'shop.proschi') });
    expect(result.diagnostics.map((d) => [d.file, d.message])).toEqual([['loop.proschi', 'Import cycle: shop.proschi → loop.proschi → shop.proschi']]);
  });
});

describe('opening a share link with imports', () => {
  const base = { stored: null, legacySource: null, fallbackSource: 'x' };
  const imports = { 'infra.proschi': 'api [REST API]' };

  it('keeps the shared imports with the opened diagram', () => {
    const state = initialState({ ...base, sharedSource: 'import "infra.proschi"', sharedImports: imports });
    expect(state.docs[0]).toMatchObject({ source: 'import "infra.proschi"', imports });
  });

  it('attaches them to an identical saved diagram', () => {
    const stored = { docs: [{ id: 'a', source: 'same', updatedAt: 't' }], currentId: 'a' };
    const state = initialState({ ...base, stored, sharedSource: 'same', sharedImports: imports });
    expect(state.docs).toEqual([{ id: 'a', source: 'same', updatedAt: 't', imports, fileName: 'untitled.proschi' }]);
  });
});

describe('team files in the browser', () => {
  it('counts the team files of systems as used, so a share link carries them', () => {
    const files = { ...DRONE_TEAM_FILES, 'unused.proschi': 'x' };
    const result = parse(droneOrgSource(), { path: DRONE_ORG_PATH, resolve: filesResolver(files, DRONE_ORG_PATH) });
    expect(Object.keys(usedImports(result, files, DRONE_ORG_PATH)).sort()).toEqual(Object.keys(DRONE_TEAM_FILES).sort());
  });

  it('opens the team files of an example as diagrams, once', () => {
    let n = 0;
    const ids = () => `d${n++}`;
    let state = addFiles(addDoc({ docs: [], currentId: '' }, droneOrgSource(), () => 't', ids), DRONE_TEAM_FILES, () => 't', ids);
    expect(state.docs.map((d) => d.fileName)).toEqual([DRONE_ORG_PATH, ...Object.keys(DRONE_TEAM_FILES)]);
    expect(state.currentId).toBe('d0');
    // Again: a second org diagram, the same team files.
    state = addFiles(addDoc(state, droneOrgSource(), () => 't', ids), DRONE_TEAM_FILES, () => 't', ids);
    expect(state.docs.length).toBe(2 + Object.keys(DRONE_TEAM_FILES).length);
  });

  it('edits a team file saved in this browser, and only reads one that came with a link or from a remote source', () => {
    const org = doc('org', droneOrgSource());
    const orders = doc('o', 'title "Orders"', { fileName: 'teams/orders.proschi' });
    const team = teamFileOf([org, orders], org, 'teams/orders.proschi');
    expect(team).toEqual({ path: 'teams/orders.proschi', source: 'title "Orders"', docId: 'o' });
    const edited = updateDoc({ docs: [org, orders], currentId: 'org' }, 'o', 'title "Orders v2"', () => 'later');
    expect(edited.docs[1]).toMatchObject({ source: 'title "Orders v2"', updatedAt: 'later' });
    expect(edited.currentId).toBe('org');

    const shared = { ...org, imports: { 'teams/orders.proschi': 'title "Shared"', 'git:github.com/acme/orders//team.proschi@v1': 'title "Remote"' } };
    expect(teamFileOf([shared, orders], shared, 'teams/orders.proschi')).toMatchObject({ source: 'title "Shared"', readOnly: expect.stringContaining('link') });
    expect(teamFileOf([shared], shared, 'git:github.com/acme/orders//team.proschi@v1')).toMatchObject({ readOnly: expect.stringContaining('remote') });
    expect(teamFileOf([org], org, 'teams/missing.proschi')).toBeUndefined();
    // A version fetched from the account never changes.
    expect(teamFileOf([org], org, 'cloud:orders:v1', { 'cloud:orders:v1': 'title "V1"' })).toMatchObject({ source: 'title "V1"', readOnly: expect.stringContaining('saved version') });
  });
});
