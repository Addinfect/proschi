import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis';
import { MAX_IMPORT_BYTES, MAX_IMPORT_DEPTH, fileResolver, parseFile, projectRoot } from '../src/imports';
import { parse } from '../src/proschi';

// A secret outside the project, and a project (with proschi.json) next to it.
const base = realpathSync(mkdtempSync(join(tmpdir(), 'proschi-jail-')));
const secret = join(base, 'secret.proschi');
writeFileSync(secret, 'leaked [Redis]\n');
const project = join(base, 'project');
mkdirSync(join(project, 'teams', 'a'), { recursive: true });
writeFileSync(join(project, 'proschi.json'), '{}');
writeFileSync(join(project, 'shared.proschi'), 'db [PostgreSQL]\n');

const messages = (file: string) => parseFile(file).diagnostics.map((d) => d.message);
const doc = (name: string, text: string) => {
  const file = join(project, name);
  writeFileSync(file, text);
  return file;
};

describe('the project root', () => {
  it('is the folder of proschi.json, else the git root, else the entry folder', () => {
    expect(projectRoot(join(project, 'teams', 'a', 'x.proschi'))).toBe(project);
    const repo = join(base, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'sub'));
    expect(projectRoot(join(repo, 'sub', 'x.proschi'))).toBe(repo);
    const loose = join(base, 'loose');
    mkdirSync(loose);
    expect(projectRoot(join(loose, 'x.proschi'))).toBe(loose);
  });
});

describe('imports confined to the project root', () => {
  it('allows ../ inside the root (monorepos)', () => {
    const file = doc('teams/a/svc.proschi', 'import "../../shared.proschi"\napi -> db\n');
    expect(parseFile(file).diagnostics).toEqual([]);
  });

  it('refuses ../ that leaves the root, without reading the file', () => {
    const file = doc('escape.proschi', 'import "../secret.proschi"\nimport "../../../../../../../../etc/passwd"\n');
    const result = parseFile(file);
    expect(result.diagram.nodes.map((n) => n.id)).not.toContain('leaked');
    expect(messages(file)).toEqual([
      expect.stringMatching(/^'\.\.\/secret\.proschi' is outside the project root .*; imports must stay inside the folder of proschi\.json/),
      expect.stringMatching(/^'\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/etc\/passwd' is outside the project root/),
    ]);
  });

  it('refuses absolute paths', () => {
    const file = doc('abs.proschi', `import "${secret.split(sep).join('/')}"\nimport "/etc/passwd"\n`);
    expect(messages(file)).toEqual([expect.stringMatching(/is an absolute path; imports must be relative/), "'/etc/passwd' is an absolute path; imports must be relative to the importing file"]);
  });

  it('treats percent-encoding literally, so it cannot climb', () => {
    const file = doc('encoded.proschi', 'import "%2e%2e/secret.proschi"\nimport "..%2fsecret.proschi"\n');
    expect(messages(file)).toEqual(["Cannot find '%2e%2e/secret.proschi'", "Cannot find '..%2fsecret.proschi'"]);
  });

  it('refuses a symlink whose real path leaves the root', () => {
    symlinkSync(secret, join(project, 'link.proschi'));
    symlinkSync(base, join(project, 'linkdir'));
    const file = doc('symlink.proschi', 'import "link.proschi"\nimport "linkdir/secret.proschi"\n');
    const result = parseFile(file);
    expect(result.diagram.nodes.map((n) => n.id)).not.toContain('leaked');
    expect(result.diagnostics.map((d) => d.message)).toEqual([
      expect.stringMatching(/^'link\.proschi' is a symlink to a file outside the project root/),
      expect.stringMatching(/^'linkdir\/secret\.proschi' is outside the project root/),
    ]);
  });

  it('applies to text the editor supplies too, and to the language server analysis', () => {
    const entry = join(project, 'editor.proschi');
    const resolve = fileResolver({ entry, read: (p) => (p === secret ? 'leaked [Redis]' : undefined) });
    const a = analyze(`import "${relative(project, secret).split(sep).join('/')}"`, { path: entry, resolve });
    resolve.explain(a.result);
    expect(a.diagram.nodes).toEqual([]);
    expect(a.diagnostics[0].message).toMatch(/is outside the project root/);
  });

  it('refuses files over the size limit', () => {
    doc('huge.proschi', `# ${'x'.repeat(MAX_IMPORT_BYTES)}\n`);
    const file = doc('big.proschi', 'import "huge.proschi"\n');
    expect(messages(file)).toEqual(["'huge.proschi' is larger than 1 MB"]);
  });

  it('limits how deep imports nest, and still reports cycles', () => {
    for (let i = 0; i <= MAX_IMPORT_DEPTH; i++) doc(`deep${i}.proschi`, `import "deep${i + 1}.proschi"\n`);
    doc(`deep${MAX_IMPORT_DEPTH + 1}.proschi`, 'end [Redis]\n');
    expect(messages(join(project, 'deep0.proschi'))).toContain(`Imports nest more than ${MAX_IMPORT_DEPTH} files deep`);
    doc('c1.proschi', 'import "c2.proschi"\n');
    doc('c2.proschi', 'import "c1.proschi"\n');
    expect(messages(join(project, 'c1.proschi'))).toEqual(['Import cycle: c1.proschi → c2.proschi → c1.proschi']);
  });

  it('keeps the reason when the parser already reports it (no doubling)', () => {
    const entry = join(project, 'twice.proschi');
    const resolve = fileResolver({ entry });
    const result = parse('import "/etc/passwd"', { path: entry, resolve });
    resolve.explain(result);
    resolve.explain(result);
    expect(result.diagnostics.map((d) => d.message)).toEqual(["'/etc/passwd' is an absolute path; imports must be relative to the importing file"]);
  });
});
