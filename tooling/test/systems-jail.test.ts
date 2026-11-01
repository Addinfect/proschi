import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFile } from '../src/imports';

// A team file outside the project, and a project (with proschi.json) next to it.
const base = realpathSync(mkdtempSync(join(tmpdir(), 'proschi-systems-')));
writeFileSync(join(base, 'outside.proschi'), 'leaked [Redis]\nusecase "Go" {\n  a -> leaked : x\n}\n');
const project = join(base, 'project');
mkdirSync(join(project, 'org'), { recursive: true });
writeFileSync(join(project, 'proschi.json'), '{}');
writeFileSync(join(project, 'orders.proschi'), 'api [REST API]\ndb [PostgreSQL]\nusecase "Place order" {\n  api -> db : INSERT order\n}\n');

describe('system team files', () => {
  it('load through the project resolver, with its reasons for refusing one', () => {
    const file = join(project, 'org', 'org.proschi');
    writeFileSync(
      file,
      [
        'system orders {',
        '  from "../orders.proschi"',
        '  expose api',
        '}',
        'system leak {',
        '  from "../../outside.proschi"',
        '  expose go',
        '}',
        'system remote {',
        '  from "git:github.com/acme/feed//feed.proschi@v1"',
        '  expose x',
        '}',
      ].join('\n'),
    );
    const result = parseFile(file);
    const systems = result.diagram.systems!;
    expect(systems[0].diagram?.nodes.map((n) => n.id)).toEqual(['api', 'db']);
    expect(systems[1].diagram).toBeUndefined();
    expect(result.diagnostics.map((d) => [d.line, d.message])).toEqual([
      [6, expect.stringMatching(/^'\.\.\/\.\.\/outside\.proschi' is outside the project root/)],
      [10, expect.stringMatching(/is a remote import and there is no proschi\.lock; run proschi imports sync$/)],
    ]);
  });
});
