import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeShareLink } from '../../frontend/src/playground/share';
import { filesResolver } from '../../frontend/src/playground/imports';
import { parse } from '../src/proschi';
import { run } from '../src/cli';

function capture(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(argv, (s) => out.push(s), (s) => err.push(s));
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const dir = mkdtempSync(join(tmpdir(), 'proschi-share-'));
mkdirSync(join(dir, 'docs'));
mkdirSync(join(dir, 'shared'));
writeFileSync(join(dir, 'shared', 'base.proschi'), 'db [PostgreSQL]\n');
writeFileSync(join(dir, 'docs', 'given.proschi'), 'import "../shared/base.proschi"\nclient [Browser]\n');
const shop = 'import "given.proschi"\napi [REST API]\nclient -> api\napi -> db\n';
writeFileSync(join(dir, 'docs', 'shop.proschi'), shop);
writeFileSync(join(dir, 'alone.proschi'), 'a -> b\n');
// The project root, so docs/ may import ../shared/.
writeFileSync(join(dir, 'proschi.json'), '{}');

describe('proschi share-link', () => {
  it('prints an editor link the web editor decodes, with the imported files', () => {
    const r = capture(['share-link', join(dir, 'docs', 'shop.proschi')]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^https:\/\/proschi\.app\/app\/#code=/);
    const link = decodeShareLink(r.out.slice(r.out.indexOf('#')));
    expect(link?.source).toBe(shop);
    // Keyed as the editor resolves them: relative to the document, known by its name.
    expect(link?.imports).toEqual({
      'given.proschi': 'import "../shared/base.proschi"\nclient [Browser]\n',
      '../shared/base.proschi': 'db [PostgreSQL]\n',
    });
  });

  it('refuses imports that leave the project root, embedding nothing', () => {
    const outside = mkdtempSync(join(tmpdir(), 'proschi-secret-'));
    writeFileSync(join(outside, 'secret.proschi'), 'secret [Redis]\n');
    const project = mkdtempSync(join(tmpdir(), 'proschi-share-jail-'));
    writeFileSync(join(project, 'proschi.json'), '{}');
    const rel = relative(project, join(outside, 'secret.proschi')).split(sep).join('/');
    writeFileSync(join(project, 'doc.proschi'), `import "${rel}"\nimport "/etc/passwd"\n`);
    const r = capture(['share-link', join(project, 'doc.proschi')]);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toContain(`'${rel}' is outside the project root`);
    expect(r.err).toContain("'/etc/passwd' is an absolute path");
    expect(r.err).not.toContain('secret [Redis]');
  });

  it('round-trips a ../ import inside the root, and the link renders', () => {
    const r = capture(['share-link', join(dir, 'docs', 'given.proschi')]);
    const link = decodeShareLink(r.out.slice(r.out.indexOf('#')));
    expect(link?.imports).toEqual({ '../shared/base.proschi': 'db [PostgreSQL]\n' });
    const parsed = parse(link!.source, { path: 'given.proschi', resolve: filesResolver(link!.imports!, 'given.proschi') });
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.diagram.nodes.map((n) => n.id)).toEqual(['db', 'client']);
  });

  it('leaves imports out when there are none and takes another base', () => {
    const r = capture(['share-link', '--base', 'http://localhost:5173/app/', join(dir, 'alone.proschi')]);
    expect(r.out).toMatch(/^http:\/\/localhost:5173\/app\/#code=[^&]+$/);
  });

  it('rejects bad usage', () => {
    expect(capture(['share-link']).code).toBe(2);
    expect(capture(['share-link', '--base', 'ftp://x', 'a.proschi']).code).toBe(2);
    expect(capture(['share-link', join(dir, 'missing.proschi')]).code).toBe(2);
  });
});
