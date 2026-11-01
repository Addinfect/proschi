import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import { run } from '../src/cli';
import { openApiDiagnostics } from '../src/openapi/config';
import { analyze, declaration, hover, outline } from '../src/analysis';
import { checkFiles, displayPath, fileResolver, importLinks, ownDiagnostics, parseFile } from '../src/imports';

function capture(argv: string[]) {
  const out: string[] = [];
  const code = run(argv, (s) => out.push(s), (s) => out.push(s));
  return { code, out: out.join('\n') };
}

const dir = mkdtempSync(join(tmpdir(), 'proschi-imports-'));
mkdirSync(join(dir, 'teams'));
// The project root, so teams/ may import ../infra.proschi.
writeFileSync(join(dir, 'proschi.json'), '{}');
const infra = join(dir, 'infra.proschi');
const checkout = join(dir, 'teams', 'checkout.proschi');
const payments = join(dir, 'teams', 'payments.proschi');
writeFileSync(infra, 'title "Infra"\ngateway [AWS API Gateway]\norders [REST API]\nlegacy [Cobol]\ngateway -> orders\n');
writeFileSync(checkout, 'title "Checkout"\nimport "../infra.proschi"\n\nusecase "Place order" {\n  gateway -> orders : POST /orders\n}\n');
writeFileSync(payments, 'import "../infra.proschi"\nimport "missing.proschi"\nusecase "Pay" {\n  orders -> psp : POST /charge\n}\n');

describe('proschi check with imports', () => {
  it('reports problems under the file they occur in, once per file', () => {
    const results = checkFiles([checkout, payments]);
    expect(results.map((r) => [r.file, r.diagnostics.map((d) => `${d.line}:${d.severity}:${d.message}`)])).toEqual([
      [checkout, []],
      [infra, ["4:warning:Unknown tech stack 'Cobol'; simulated as a generic service, like [Service]"]],
      // gateway -> orders is connected in infra.proschi, so only orders -> psp warns.
      [payments, ["2:error:Cannot find 'missing.proschi'", "4:warning:No connection between 'orders' and 'psp' in the architecture; add 'orders -> psp'"]],
    ]);
    // Grouped by file, so the diagnostics themselves carry no file.
    expect(results[1].diagnostics[0]).not.toHaveProperty('file');
  });

  it('prints file:line:col for imported files and fails on their errors', () => {
    const r = capture(['check', checkout, payments]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${infra}:4:8: warning: Unknown tech stack 'Cobol'`);
    expect(r.out).toContain(`${payments}:2:8: error: Cannot find 'missing.proschi'`);
    expect(r.out.match(/Cobol/g)).toHaveLength(1);
  });

  it('parses with imports resolved', () => {
    const result = JSON.parse(capture(['parse', checkout]).out);
    expect(result.diagram.title).toBe('Checkout');
    expect(result.diagram.nodes.map((n: { id: string }) => n.id)).toEqual(['gateway', 'orders', 'legacy']);
    expect(result.imports).toEqual([{ path: '../infra.proschi', resolved: infra, loc: { line: 2, col: 8, length: 18 } }]);
    const schema = JSON.parse(readFileSync(new URL('../schema/proschi-diagram.schema.json', import.meta.url), 'utf8'));
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
  });

  it('reports cycles with file names', () => {
    const a = join(dir, 'a.proschi');
    writeFileSync(a, 'import "b.proschi"\n');
    writeFileSync(join(dir, 'b.proschi'), 'import "a.proschi"\n');
    expect(parseFile(a).diagnostics).toEqual([
      expect.objectContaining({ message: 'Import cycle: a.proschi → b.proschi → a.proschi', file: join(dir, 'b.proschi') }),
    ]);
  });

  it('checks steps against OpenAPI specs and reports findings under the file of the step', () => {
    const api = join(dir, 'api');
    mkdirSync(api);
    const ordersSpec = fileURLToPath(new URL('./fixtures/openapi/specs/orders-api.yaml', import.meta.url));
    writeFileSync(join(api, 'proschi.json'), JSON.stringify({ openapi: { orders: ordersSpec } }));
    writeFileSync(join(api, 'infra.proschi'), 'gateway [AWS API Gateway]\norders [REST API]\ngateway -> orders\n');
    const flows = join(api, 'flows.proschi');
    writeFileSync(flows, 'import "infra.proschi"\nusecase "Typo" {\n  gateway -> orders : GET /ordres\n}\n');
    const root = join(api, 'all.proschi');
    writeFileSync(root, 'import "flows.proschi"\nusecase "Fine" {\n  gateway -> orders : GET /orders\n}\n');

    const typo = /^3:warning:GET \/ordres: 'orders-api\.yaml' has no path \/ordres/;
    const own = checkFiles([flows], (file, diagram) => openApiDiagnostics(file, diagram));
    expect(own.map((r) => [r.file, r.diagnostics.map((d) => `${d.line}:${d.severity}:${d.message}`)])).toEqual([[flows, [expect.stringMatching(typo)]]]);
    // Checked through a file that imports it, and directly: reported once, under flows.proschi.
    const both = checkFiles([root, flows], (file, diagram) => openApiDiagnostics(file, diagram));
    expect(both.map((r) => [r.file, r.diagnostics.length])).toEqual([
      [root, 0],
      [flows, 1],
    ]);
    expect(capture(['check', root]).out).toMatch(new RegExp(`${flows.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:3:3: warning: GET /ordres`));
  });

  it('formats files with imports without touching the import lines', () => {
    const file = join(dir, 'fmt.proschi');
    writeFileSync(file, '  import   "infra.proschi"\n\n\napi->db\n');
    expect(capture(['fmt', file]).code).toBe(0);
    const once = readFileSync(file, 'utf8');
    expect(once.split('\n')[0]).toBe('import "infra.proschi"');
    expect(capture(['fmt', '--check', file]).code).toBe(0);
  });

  it('spells paths inside the working directory relative to it', () => {
    expect(displayPath(join(process.cwd(), 'x', 'y.proschi'))).toBe(join('x', 'y.proschi'));
    expect(displayPath(infra)).toBe(infra);
  });
});

describe('import analysis for editors', () => {
  const text = readFileSync(payments, 'utf8');
  const a = analyze(text, { path: payments, resolve: fileResolver({ entry: payments }) });

  it('turns errors in imported files into one error on the import line', () => {
    const broken = join(dir, 'broken.proschi');
    writeFileSync(broken, 'x [REST API]\nx [Redis]\ngroup g {\n');
    const src = 'import "broken.proschi"\nimport "infra.proschi"\n';
    const result = analyze(src, { path: join(dir, 'root.proschi'), resolve: fileResolver({ entry: join(dir, 'root.proschi') }) }).result;
    expect(ownDiagnostics(result)).toEqual([{ severity: 'error', message: "'broken.proschi' has 2 errors", line: 1, col: 8, length: 16 }]);
  });

  it('prefers text supplied by the editor over the disk', () => {
    const resolve = fileResolver({ entry: payments, read: (p) => (p === infra ? 'orders [Redis]' : undefined) });
    expect(analyze(text, { path: payments, resolve }).diagram.nodes.find((n) => n.id === 'orders')?.techStack).toBe('Redis');
  });

  it('finds declarations and hover text in imported files, and links import paths', () => {
    const line = text.split('\n').findIndex((l) => l.includes('orders -> psp'));
    expect(declaration(a, { line, character: 4 })).toEqual({ file: infra, range: { start: { line: 2, character: 0 }, end: { line: 2, character: 6 } } });
    expect(hover(a, { line, character: 4 })?.markdown).toContain('_Declared in infra.proschi_');
    expect(importLinks(a.result)).toEqual([{ target: infra, range: { start: { line: 0, character: 8 }, end: { line: 0, character: 24 } } }]);
  });

  it('outlines only what the document itself declares', () => {
    expect(outline(a).map((s) => s.name)).toEqual(['Pay']);
  });
});
