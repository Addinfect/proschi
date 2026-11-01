import { describe, expect, it } from 'vitest';
import { fileNameOf, renameFile, titleOf, type DocumentState, type SavedDiagram } from './documents';
import { addDocIn, allFolders, brokenImports, buildTree, cleanFolder, docsInFolder, duplicateDoc, folderOf, matchesQuery, moveDoc, removeFolder, renameFolder } from './folders';

const clock = () => '2026-01-01T00:00:00.000Z';
const ids = () => {
  let n = 0;
  return () => `n${++n}`;
};
const doc = (id: string, fileName: string, title = id): SavedDiagram => ({ id, source: `title "${title}"\n`, updatedAt: clock(), fileName });
const state = (...docs: SavedDiagram[]): DocumentState => ({ docs, currentId: docs[0].id });
const names = (s: DocumentState) => Object.fromEntries(s.docs.map((d) => [d.id, fileNameOf(d)]));

describe('cleanFolder and folderOf', () => {
  it('normalises typed folder paths', () => {
    expect(cleanFolder(' /a// b /./../c/ ')).toBe('a/b/c');
    expect(cleanFolder('')).toBe('');
  });

  it('reads the folder of a file name', () => {
    expect(folderOf('a/b/x.proschi')).toBe('a/b');
    expect(folderOf('x.proschi')).toBe('');
  });
});

describe('moveDoc', () => {
  it('moves a diagram into a folder and back to the top', () => {
    const s = moveDoc(state(doc('a', 'api.proschi')), 'a', 'payments');
    expect(names(s)).toEqual({ a: 'payments/api.proschi' });
    expect(names(moveDoc(s, 'a', ''))).toEqual({ a: 'api.proschi' });
  });

  it('numbers the name when the folder has one already', () => {
    const s = moveDoc(state(doc('a', 'api.proschi'), doc('b', 'pay/api.proschi')), 'a', 'pay');
    expect(names(s).a).toBe('pay/api-2.proschi');
  });

  it('leaves the state alone when nothing moves', () => {
    const s = state(doc('a', 'pay/api.proschi'));
    expect(moveDoc(s, 'a', 'pay/')).toBe(s);
    expect(moveDoc(s, 'missing', 'x')).toBe(s);
  });
});

describe('addDocIn', () => {
  it('adds an opened diagram inside the folder', () => {
    const s = addDocIn(state(doc('a', 'a.proschi')), 'title "New"\n', 'team', clock, ids());
    expect(s.currentId).toBe('n1');
    expect(names(s).n1).toBe('team/new.proschi');
  });
});

describe('duplicateDoc', () => {
  it('copies next to the original with a "copy" title, and opens it', () => {
    const original = { ...doc('a', 'pay/api.proschi', 'API'), imports: { 'x.proschi': 'title "X"' } };
    const s = duplicateDoc(state(original), 'a', clock, ids());
    const copy = s.docs.find((d) => d.id === s.currentId)!;
    expect(titleOf(copy.source)).toBe('API copy');
    expect(copy.fileName).toBe('pay/api-copy.proschi');
    expect(copy.imports).toEqual(original.imports);
    expect(s.docs).toHaveLength(2);
  });

  it('adds a title line when the diagram has none', () => {
    const s = duplicateDoc(state({ id: 'a', source: 'a -> b\n', updatedAt: clock(), fileName: 'x.proschi' }), 'a', clock, ids());
    expect(s.docs.find((d) => d.id === s.currentId)!.source).toBe('title "Untitled copy"\na -> b\n');
  });
});

describe('renameFolder', () => {
  it('renames a folder with its subfolders', () => {
    const s = renameFolder(state(doc('a', 'pay/api.proschi'), doc('b', 'pay/db/x.proschi'), doc('c', 'payroll.proschi')), 'pay', 'billing');
    expect(names(s)).toEqual({ a: 'billing/api.proschi', b: 'billing/db/x.proschi', c: 'payroll.proschi' });
  });

  it('merges into an existing folder, numbering clashes', () => {
    const s = renameFolder(state(doc('a', 'pay/api.proschi'), doc('b', 'billing/api.proschi')), 'pay', 'billing');
    expect(names(s).a).toBe('billing/api-2.proschi');
  });

  it('never moves a folder into itself', () => {
    const s = state(doc('a', 'pay/api.proschi'));
    expect(renameFolder(s, 'pay', 'pay/sub')).toBe(s);
  });

  it('refuses a name that cleans to nothing', () => {
    const s = state(doc('a', 'pay/api.proschi'));
    expect(renameFolder(s, 'pay', '..')).toBe(s);
    expect(renameFolder(s, 'pay', '/')).toBe(s);
  });
});

describe('removeFolder', () => {
  it('deletes every diagram under it', () => {
    const s = removeFolder(state(doc('a', 'pay/api.proschi'), doc('b', 'pay/db/x.proschi'), doc('c', 'c.proschi')), 'pay', clock, ids());
    expect(s.docs.map((d) => d.id)).toEqual(['c']);
    expect(s.currentId).toBe('c');
  });

  it('leaves a blank diagram when it held them all', () => {
    const s = removeFolder(state(doc('a', 'pay/api.proschi')), 'pay', clock, ids());
    expect(s.docs).toHaveLength(1);
    expect(s.docs[0].id).toBe('n1');
  });
});

describe('trees and search', () => {
  const docs = [doc('z', 'z.proschi', 'Zeta'), doc('b', 'pay/db.proschi', 'DB'), doc('a', 'pay/api.proschi', 'API'), doc('d', 'ops/deep/x.proschi', 'X')];

  it('lists folders with their parents', () => {
    expect(allFolders(docs)).toEqual(['ops', 'ops/deep', 'pay']);
    expect(docsInFolder(docs, 'ops').map((d) => d.id)).toEqual(['d']);
  });

  it('builds a sorted tree', () => {
    const tree = buildTree(docs);
    expect(tree.folders.map((f) => f.name)).toEqual(['ops', 'pay']);
    expect(tree.folders[0].folders[0].path).toBe('ops/deep');
    expect(tree.folders[1].docs.map((d) => d.id)).toEqual(['a', 'b']);
    expect(tree.docs.map((d) => d.id)).toEqual(['z']);
  });

  it('matches every word against the title or path', () => {
    expect(matchesQuery(docs[2], 'pay api')).toBe(true);
    expect(matchesQuery(docs[2], 'API')).toBe(true);
    expect(matchesQuery(docs[2], 'ops')).toBe(false);
  });
});

describe('renameFile', () => {
  it('numbers a name another diagram has', () => {
    const s = renameFile(state(doc('a', 'pay/api.proschi'), doc('b', 'pay/db.proschi')), 'b', 'pay/api');
    expect(names(s).b).toBe('pay/api-2.proschi');
    expect(names(renameFile(s, 'a', 'pay/api.proschi')).a).toBe('pay/api.proschi');
  });
});

describe('brokenImports', () => {
  const src = (d: SavedDiagram, source: string) => ({ ...d, source });

  it('finds the importers of a moved file', () => {
    const before = [doc('a', 'pay/api.proschi'), src(doc('b', 'shop.proschi'), 'import "pay/api.proschi"\n'), src(doc('c', 'pay/x.proschi'), 'import "api.proschi"\n'), doc('d', 'other.proschi')];
    const after = moveDoc({ docs: before, currentId: 'a' }, 'a', '').docs;
    expect(brokenImports(before, after).map((d) => d.id)).toEqual(['b', 'c']);
  });

  it('finds a moved file whose own imports now point elsewhere', () => {
    const before = [src(doc('a', 'app.proschi'), 'import "infra.proschi"\n'), doc('b', 'infra.proschi')];
    const after = moveDoc({ docs: before, currentId: 'a' }, 'a', 'pay').docs;
    expect(brokenImports(before, after).map((d) => d.id)).toEqual(['a']);
  });

  it('is quiet when imports move together or were already missing, and skips remote and kept imports', () => {
    const before = [
      src(doc('a', 'pay/app.proschi'), 'import "infra.proschi"\nimport "missing.proschi"\nimport "git:github.com/a/b//x.proschi@v1"\n'),
      doc('b', 'pay/infra.proschi'),
      { ...src(doc('c', 'c.proschi'), 'import "pay/infra.proschi"\n'), imports: { 'pay/infra.proschi': 'title "Kept"' } },
    ];
    const after = renameFolder({ docs: before, currentId: 'a' }, 'pay', 'billing').docs;
    expect(brokenImports(before, after)).toEqual([]);
  });

  it('reads system from paths', () => {
    const before = [doc('a', 'teams/orders.proschi'), src(doc('b', 'b.proschi'), 'system orders [Orders]\n  from "teams/orders.proschi"\n')];
    const after = moveDoc({ docs: before, currentId: 'a' }, 'a', '').docs;
    expect(brokenImports(before, after).map((d) => d.id)).toEqual(['b']);
  });
});
