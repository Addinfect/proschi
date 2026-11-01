import { describe, expect, it } from 'vitest';
import { joinImportPath, mapResolver, parse } from './index';
import { ImportError, cloudDocumentName, cloudSpecsOf, isImportKey, parseRemoteSpec, resolveImportPath } from './imports';
import { format } from './format';

const infra = `title "Infra"
gateway "API Gateway" [AWS API Gateway]
orders [REST API]
db [PostgreSQL]
gateway -> orders
orders -> db
`;

const checkout = `title "Checkout"
import "infra.proschi"

usecase "Place order" {
  gateway -> orders : POST /orders
  orders -> db : INSERT order
  orders --> gateway : 201
}
`;

const parseWith = (files: Record<string, string>, root: string) =>
  parse(files[root], { path: root, resolve: mapResolver(files) });

describe('import', () => {
  it('merges what the imported file declares, keeping the root title', () => {
    const { diagram, diagnostics, imports } = parseWith({ 'infra.proschi': infra, 'checkout.proschi': checkout }, 'checkout.proschi');
    expect(diagnostics).toEqual([]);
    expect(diagram.title).toBe('Checkout');
    expect(diagram.nodes.map((n) => n.id)).toEqual(['gateway', 'orders', 'db']);
    expect(diagram.nodes.every((n) => !n.implicit && n.loc.file === 'infra.proschi')).toBe(true);
    expect(diagram.edges.map((e) => e.id)).toEqual(['gateway->orders', 'orders->db']);
    expect(diagram.useCases[0]).toMatchObject({ id: 'place-order', entryServiceId: 'gateway', loc: { line: 4 } });
    expect(diagram.useCases[0].loc.file).toBeUndefined();
    expect(diagram.useCases[0].steps[0]).toMatchObject({ protocol: 'REST', statusCode: 201 });
    expect(imports).toEqual([{ path: 'infra.proschi', resolved: 'infra.proschi', loc: { line: 2, col: 8, length: 15 } }]);
  });

  it('leaves imports out of the result when there are none', () => {
    expect(parse('a -> b')).not.toHaveProperty('imports');
  });

  it('creates implicit nodes only after every file is read', () => {
    const files = { 'a.proschi': 'import "b.proschi"\nx -> y', 'b.proschi': 'y [Redis]' };
    const { diagram } = parseWith(files, 'a.proschi');
    expect(diagram.nodes.map((n) => [n.id, !!n.implicit])).toEqual([
      ['y', false],
      ['x', true],
    ]);
  });

  it('resolves paths relative to the importing file', () => {
    const files = {
      'teams/shop.proschi': 'import "../infra/base.proschi"\nusecase "U" {\n  a -> b\n}',
      'infra/base.proschi': 'import "./nodes.proschi"\na -> b',
      'infra/nodes.proschi': 'a [REST API]\nb [Redis]',
    };
    const { diagram, diagnostics } = parseWith(files, 'teams/shop.proschi');
    expect(diagnostics).toEqual([]);
    expect(diagram.nodes.map((n) => n.loc.file)).toEqual(['infra/nodes.proschi', 'infra/nodes.proschi']);
  });

  it('includes a file imported along several paths once', () => {
    const files = {
      'root.proschi': 'import "a.proschi"\nimport "b.proschi"',
      'a.proschi': 'import "shared.proschi"\na -> s',
      'b.proschi': 'import "shared.proschi"\nb -> s',
      'shared.proschi': 's [Redis]',
    };
    const { diagram, diagnostics } = parseWith(files, 'root.proschi');
    expect(diagnostics).toEqual([]);
    expect(diagram.nodes.filter((n) => n.id === 's')).toHaveLength(1);
  });

  it('reports import cycles on the import line', () => {
    const files = { 'a.proschi': 'import "b.proschi"\na [Redis]', 'b.proschi': 'import "a.proschi"\nb [Redis]' };
    const { diagram, diagnostics } = parseWith(files, 'a.proschi');
    expect(diagnostics).toEqual([
      { severity: 'error', message: 'Import cycle: a.proschi → b.proschi → a.proschi', line: 1, col: 8, length: 11, file: 'b.proschi' },
    ]);
    expect(diagram.nodes.map((n) => n.id)).toEqual(['b', 'a']);
    expect(parseWith({ 'self.proschi': 'import "self.proschi"' }, 'self.proschi').diagnostics[0].message).toBe(
      'Import cycle: self.proschi → self.proschi',
    );
  });

  it('reports files it cannot find', () => {
    const { diagnostics } = parseWith({ 'a.proschi': 'import "nope.proschi"' }, 'a.proschi');
    expect(diagnostics).toEqual([{ severity: 'error', message: "Cannot find 'nope.proschi'", line: 1, col: 8, length: 14 }]);
    const throwing = parse('import "x.proschi"', {
      resolve: () => {
        throw new Error('disk on fire');
      },
    });
    expect(throwing.diagnostics[0].message).toBe("Cannot find 'x.proschi'");
  });

  it('only warns when imports cannot be resolved in this context', () => {
    const { diagnostics, imports } = parse('import "infra.proschi"\na -> b');
    expect(diagnostics).toEqual([
      { severity: 'warning', message: "Imports are not resolved in this context; 'infra.proschi' was not loaded", line: 1, col: 8, length: 15 },
    ]);
    expect(imports).toEqual([{ path: 'infra.proschi', loc: { line: 1, col: 8, length: 15 } }]);
  });

  it('reports duplicate ids across files with the file and line of the first', () => {
    const files = { 'root.proschi': 'import "infra.proschi"\norders [Redis]', 'infra.proschi': '\norders [REST API]' };
    const { diagnostics } = parseWith(files, 'root.proschi');
    expect(diagnostics).toEqual([
      { severity: 'error', message: "Duplicate id 'orders' (first declared in infra.proschi on line 2)", line: 2, col: 1, length: 6 },
    ]);
    const later = parseWith({ 'root.proschi': 'orders [Redis]\nimport "infra.proschi"', 'infra.proschi': 'orders [REST API]' }, 'root.proschi');
    expect(later.diagnostics[0]).toMatchObject({ message: "Duplicate id 'orders' (first declared in root.proschi on line 1)", file: 'infra.proschi' });
  });

  it('keeps use case ids unique across files', () => {
    const files = { 'root.proschi': 'import "more.proschi"\nusecase "Pay" {\n  a -> b\n}', 'more.proschi': 'usecase "Pay" {\n  a -> c\n}' };
    expect(parseWith(files, 'root.proschi').diagram.useCases.map((u) => u.id)).toEqual(['pay', 'pay-2']);
  });

  it('marks problems from imported files with the file, after the root document', () => {
    const files = { 'root.proschi': 'import "infra.proschi"\nz [Nope]', 'infra.proschi': 'x [Nope]\ngroup g {' };
    const { diagnostics } = parseWith(files, 'root.proschi');
    expect(diagnostics.map((d) => [d.file, d.line, d.severity])).toEqual([
      [undefined, 2, 'warning'],
      ['infra.proschi', 1, 'warning'],
      ['infra.proschi', 2, 'error'],
    ]);
  });

  it('only allows imports at the top level, with a string path', () => {
    const errs = (src: string) => parse(src, { resolve: () => undefined }).diagnostics.map((d) => d.message);
    expect(errs('group g {\n  import "x.proschi"\n}')).toEqual(['import is only allowed at the top level']);
    expect(errs('usecase "U" {\n  import "x.proschi"\n}')).toEqual(['import is only allowed at the top level']);
    expect(errs('import infra')).toEqual(['Expected a file path, e.g. import "infra.proschi"']);
    expect(errs('import "x.proschi" extra')).toEqual(["Cannot find 'x.proschi'", "Unexpected 'extra'"]);
  });
});

describe('imports and other checks', () => {
  it('counts connections from imported files for the missing-connection warning', () => {
    const files = { 'infra.proschi': infra, 'checkout.proschi': `${checkout}usecase "Audit" {\n  gateway -> db : GET /audit\n}\n` };
    const { diagnostics } = parseWith(files, 'checkout.proschi');
    // gateway -> orders and orders -> db are declared in infra.proschi; gateway -> db is not.
    expect(diagnostics.map((d) => [d.file, d.line, d.message])).toEqual([
      [undefined, 10, "No connection between 'gateway' and 'db' in the architecture; add 'gateway -> db'"],
    ]);
  });

  it('formats a document with imports idempotently, keeping the import lines', () => {
    const src = 'title "X"\n   import   "infra.proschi"  # base\nimport "teams/a b.proschi"\n\n\n\napi->db\nusecase "U" {\n  api -> db : GET /x\n}\n';
    const once = format(src);
    expect(once.split('\n').slice(1, 3)).toEqual(['import "infra.proschi" # base', 'import "teams/a b.proschi"']);
    expect(format(once)).toBe(once);
    expect(parse(once).imports?.map((i) => i.path)).toEqual(['infra.proschi', 'teams/a b.proschi']);
  });
});

describe('joinImportPath', () => {
  it('joins relative paths and normalises . and ..', () => {
    expect(joinImportPath('teams/shop.proschi', '../infra.proschi')).toBe('infra.proschi');
    expect(joinImportPath('a/b/c.proschi', './d/e.proschi')).toBe('a/b/d/e.proschi');
    expect(joinImportPath(undefined, 'x.proschi')).toBe('x.proschi');
    expect(joinImportPath('a.proschi', '../up.proschi')).toBe('../up.proschi');
  });

  it('falls back to the only file with the same name', () => {
    const resolve = mapResolver({ 'infra.proschi': 'a', 'x/other.proschi': 'b', 'y/other.proschi': 'c' });
    expect(resolve('lib/infra.proschi', 'root.proschi')).toEqual({ path: 'infra.proschi', source: 'a' });
    expect(resolve('other.proschi', 'root.proschi')).toBeUndefined();
  });
});

describe('import paths and remote sources', () => {
  const reason = (from: string | undefined, path: string) => {
    try {
      resolveImportPath(from, path);
    } catch (e) {
      expect(e).toBeInstanceOf(ImportError);
      expect((e as Error).name).toBe('ImportError');
      return (e as Error).message;
    }
    return undefined;
  };

  it('refuses absolute paths and NUL characters', () => {
    expect(reason('a.proschi', '/etc/passwd')).toMatch(/absolute path/);
    expect(reason('a.proschi', '\\server\\share.proschi')).toMatch(/absolute path/);
    expect(reason('a.proschi', 'C:/x.proschi')).toMatch(/absolute path/);
    expect(reason('a.proschi', 'x\0.proschi')).toMatch(/NUL/);
    expect(joinImportPath('a.proschi', '/etc/passwd')).toBeUndefined();
    // Percent signs are literal file names, never decoded into '..'.
    expect(joinImportPath('a.proschi', '%2e%2e/%2e%2e/etc/passwd')).toBe('%2e%2e/%2e%2e/etc/passwd');
  });

  it('parses git sources strictly', () => {
    expect(parseRemoteSpec('git:github.com/acme/infra//shared/base.proschi@v1.2.0')).toEqual({
      kind: 'git',
      repo: 'github.com/acme/infra',
      path: 'shared/base.proschi',
      ref: 'v1.2.0',
    });
    expect(parseRemoteSpec('git:gitlab.com/group/sub/repo//a.proschi@feature/x')).toMatchObject({ repo: 'gitlab.com/group/sub/repo', ref: 'feature/x' });
    expect(parseRemoteSpec('infra.proschi')).toBeUndefined();
    expect(reason(undefined, 'git:github.com/acme/infra//../../etc/passwd@main')).toMatch(/without '..'/);
    expect(reason(undefined, 'git:github.com/acme/infra//a.proschi@--upload-pack=touch /tmp/x')).toMatch(/whitespace/);
    expect(reason(undefined, 'git:github.com/acme/infra//a.proschi@--upload-pack=x')).toMatch(/invalid ref/);
    expect(reason(undefined, 'git:github.com/acme/infra//a.proschi@-x')).toMatch(/invalid ref/);
    expect(reason(undefined, 'git:github.com/acme/infra//a.proschi@a..b')).toMatch(/invalid ref/);
    expect(reason(undefined, 'git:github.com/acme/infra//a.proschi@main.lock')).toMatch(/invalid ref/);
    expect(reason(undefined, 'git:-oProxyCommand=x/acme/infra//a.proschi@main')).toMatch(/invalid repository/);
    expect(reason(undefined, 'git:github.com/acme//a.proschi@main')).toMatch(/invalid repository/);
    expect(reason(undefined, 'git:github.com/acme/infra/a.proschi@main')).toMatch(/not a git source/);
  });

  it('accepts https only, without credentials', () => {
    expect(resolveImportPath(undefined, 'https://example.com/a/b.proschi')).toBe('https://example.com/a/b.proschi');
    expect(reason(undefined, 'http://example.com/a.proschi')).toMatch(/only https:\/\//);
    expect(reason(undefined, 'https://user:token@example.com/a.proschi')).toMatch(/credentials/);
    expect(reason(undefined, 'file:///etc/passwd')).toMatch(/not a supported import source/);
    expect(reason(undefined, 'ftp://example.com/a.proschi')).toMatch(/not a supported/);
  });

  it('resolves relative imports within the same remote source', () => {
    const git = 'git:github.com/acme/infra//shared/base.proschi@v1';
    expect(resolveImportPath(git, 'nodes.proschi')).toBe('git:github.com/acme/infra//shared/nodes.proschi@v1');
    expect(resolveImportPath(git, '../top.proschi')).toBe('git:github.com/acme/infra//top.proschi@v1');
    expect(reason(git, '../../escape.proschi')).toMatch(/leaves the repository github.com\/acme\/infra/);
    expect(reason(git, '/etc/passwd')).toMatch(/absolute/);
    const https = 'https://example.com/lib/base.proschi';
    expect(resolveImportPath(https, 'nodes.proschi')).toBe('https://example.com/lib/nodes.proschi');
    expect(reason(https, '//evil.example/x.proschi')).toMatch(/absolute/);
  });

  it('tells which keys an imports map may hold', () => {
    expect(isImportKey('teams/a.proschi')).toBe(true);
    expect(isImportKey('../shared/base.proschi')).toBe(true);
    expect(isImportKey('git:github.com/acme/infra//a.proschi@v1')).toBe(true);
    expect(isImportKey('/etc/passwd')).toBe(false);
    expect(isImportKey('http://example.com/a.proschi')).toBe(false);
  });

  it('matches bundled remote files only by their exact spec', () => {
    const spec = 'git:github.com/acme/infra//base.proschi@v1';
    const files = { [spec]: 'import "nodes.proschi"\napi -> db', 'git:github.com/acme/infra//nodes.proschi@v1': 'api [REST API]\ndb [Redis]', 'base.proschi': 'x [Redis]' };
    const { diagram, diagnostics } = parse(`import "${spec}"`, { path: 'root.proschi', resolve: mapResolver(files) });
    expect(diagnostics).toEqual([]);
    expect(diagram.nodes.map((n) => n.id)).toEqual(['api', 'db']);
    // A missing remote file never falls back to a local file of the same name.
    const missing = parse('import "git:github.com/other/repo//base.proschi@v1"', { path: 'root.proschi', resolve: mapResolver(files) });
    expect(missing.diagnostics).toHaveLength(1);
    expect(missing.diagnostics[0].severity).toBe('error');
  });
});

describe('cloud sources', () => {
  const reason = (from: string | undefined, path: string) => {
    try {
      resolveImportPath(from, path);
    } catch (e) {
      expect((e as Error).name).toBe('ImportError');
      return (e as Error).message;
    }
    return undefined;
  };

  it('parses cloud:<name>[:<tag>], latest by default', () => {
    expect(parseRemoteSpec('cloud:orders')).toEqual({ kind: 'cloud', name: 'orders', tag: 'latest' });
    expect(parseRemoteSpec('cloud:teams/orders.proschi:2026-11-01')).toEqual({ kind: 'cloud', name: 'teams/orders', tag: '2026-11-01' });
    expect(parseRemoteSpec('CLOUD:orders:v2')).toEqual({ kind: 'cloud', name: 'orders', tag: 'v2' });
    expect(parseRemoteSpec('cloud:orders:v1//teams/db.proschi')).toEqual({ kind: 'cloud', name: 'orders', tag: 'v1', path: 'teams/db.proschi' });
    expect(cloudDocumentName({ kind: 'cloud', name: 'teams/orders', tag: 'latest' })).toBe('teams/orders.proschi');
  });

  it('has one canonical spelling, so cloud:x and cloud:x:latest are the same file', () => {
    expect(resolveImportPath('root.proschi', 'cloud:orders')).toBe('cloud:orders:latest');
    expect(resolveImportPath('root.proschi', 'cloud:orders.proschi:latest')).toBe('cloud:orders:latest');
    expect(resolveImportPath(undefined, 'cloud:orders:2026-11-01')).toBe('cloud:orders:2026-11-01');
    expect(isImportKey('cloud:orders:latest')).toBe(true);
    expect(isImportKey('cloud:orders')).toBe(false);
    const files = { 'cloud:orders:latest': 'api [REST API]', 'orders.proschi': 'draft [Redis]' };
    for (const spec of ['cloud:orders', 'cloud:orders:latest']) {
      const { diagram, diagnostics } = parse(`import "${spec}"`, { path: 'root.proschi', resolve: mapResolver(files) });
      expect(diagnostics).toEqual([]);
      expect(diagram.nodes.map((n) => n.id)).toEqual(['api']);
    }
    // A version that was not fetched never falls back to the draft of the same name.
    const missing = parse('import "cloud:orders:v9"', { path: 'root.proschi', resolve: mapResolver(files) });
    expect(missing.diagnostics.map((d) => d.severity)).toEqual(['error']);
  });

  it('refuses bad names and tags with a reason', () => {
    expect(reason(undefined, 'cloud:')).toMatch(/invalid diagram ''/);
    expect(reason(undefined, 'cloud::v1')).toMatch(/invalid diagram/);
    expect(reason(undefined, 'cloud:my orders')).toMatch(/whitespace/);
    expect(reason(undefined, 'cloud:../secrets')).toMatch(/invalid diagram/);
    expect(reason(undefined, 'cloud:a//../b.proschi')).toMatch(/without '..'/);
    expect(reason(undefined, 'cloud:-rf')).toMatch(/invalid diagram/);
    expect(reason(undefined, 'cloud:orders:a:b')).toMatch(/write cloud:<name> or cloud:<name>:<tag>/);
    expect(reason(undefined, 'cloud:orders:')).toMatch(/invalid version tag ''/);
    expect(reason(undefined, 'cloud:orders:-x')).toMatch(/invalid version tag/);
    expect(reason(undefined, 'cloud:orders:a/b')).toMatch(/invalid version tag/);
    expect(reason(undefined, `cloud:orders:${'x'.repeat(65)}`)).toMatch(/invalid version tag/);
    expect(resolveImportPath(undefined, `cloud:orders:${'x'.repeat(64)}`)).toMatch(/^cloud:orders:x+$/);
  });

  it('resolves relative imports within the files saved with the version', () => {
    expect(resolveImportPath('cloud:orders:v1', 'db.proschi')).toBe('cloud:orders:v1//db.proschi');
    expect(resolveImportPath('cloud:orders:v1//teams/a.proschi', '../b.proschi')).toBe('cloud:orders:v1//b.proschi');
    expect(resolveImportPath('cloud:orders:v1', 'git:github.com/acme/infra//a.proschi@v1')).toBe('git:github.com/acme/infra//a.proschi@v1');
    expect(resolveImportPath('cloud:orders:v1', 'cloud:billing')).toBe('cloud:billing:latest');
    expect(reason('cloud:orders:v1', '../escape.proschi')).toMatch(/leaves the files saved with cloud:orders:v1/);
  });

  it('is refused inside git and https files, which belong to no account', () => {
    expect(reason('git:github.com/acme/infra//a.proschi@v1', 'cloud:orders')).toMatch(/only work from your own diagrams/);
    expect(reason('https://example.com/a.proschi', 'cloud:orders:v1')).toMatch(/only work from your own diagrams/);
  });

  it('lists the versions a document needs, through imports, systems and fetched files', () => {
    const root = 'import "cloud:shared"\nimport "local.proschi"\nsystem orders {\n  from "cloud:orders:2026-11-01"\n  expose api\n}\n';
    const files = { 'local.proschi': 'import "cloud:billing:v1"\nx [Redis]' };
    expect(cloudSpecsOf(root, { path: 'root.proschi', files })).toEqual(['cloud:billing:v1', 'cloud:orders:2026-11-01', 'cloud:shared:latest']);
    // Once a version is fetched, what it reads (its own files and other versions) is listed too.
    const fetched = { ...files, 'cloud:shared:latest': 'import "db.proschi"\nimport "cloud:base:v3"' };
    expect(cloudSpecsOf(root, { path: 'root.proschi', files: fetched })).toEqual(['cloud:base:v3', 'cloud:billing:v1', 'cloud:orders:2026-11-01', 'cloud:shared:latest']);
    expect(cloudSpecsOf('a -> b')).toEqual([]);
    expect(cloudSpecsOf('import "cloud:bad name"')).toEqual([]);
  });
});
