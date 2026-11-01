import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ecommerceExample, parse } from '../dsl';
import { FIRST_RUN_SOURCE } from '../playground/exampleLink';
import { nameTarget } from './nameTarget';
import { ARROWS, CHEAT_SECTIONS, cheatSheetDocument } from './cheatSheetSections';
import { STARTER_TEMPLATE } from './template';

const docsDir = new URL('../../../docs/', import.meta.url);
const site = JSON.parse(readFileSync(new URL('site.json', docsDir), 'utf8')) as { pages: { slug: string; source: string }[] };
const grammarMd = readFileSync(new URL('GRAMMAR.md', docsDir), 'utf8');

/** GitHub's heading anchors: lowercase, punctuation dropped, spaces to dashes. */
function anchors(markdown: string): Set<string> {
  return new Set(
    [...markdown.matchAll(/^#{1,6} +(.+)$/gm)].map(
      (m) =>
        '#' +
        m[1]
          .trim()
          .toLowerCase()
          .replace(/[^\w\- ]/g, '')
          .replace(/ /g, '-'),
    ),
  );
}

describe('syntax cheat-sheet', () => {
  it('is one valid document for the real parser: no errors, no warnings', () => {
    const { diagram, diagnostics } = parse(cheatSheetDocument());
    expect(diagnostics).toEqual([]);
    expect(diagram.useCases.map((u) => u.name)).toEqual(['Place order', 'Get order']);
    expect(diagram.tests?.length ?? 0).toBeGreaterThan(0);
  });

  it('links to docs pages and sections that exist', () => {
    for (const section of CHEAT_SECTIONS) {
      const [, slug, anchor] = /^([a-z-]+)\/(#.+)?$/.exec(section.ref) ?? [];
      const page = site.pages.find((p) => p.slug === slug);
      expect(page, `${section.id} → ${section.ref}`).toBeDefined();
      if (anchor) expect(anchors(readFileSync(new URL(page!.source, docsDir), 'utf8')), `${section.id} → ${section.ref}`).toContain(anchor);
    }
  });

  it('lists exactly the arrows of the grammar', () => {
    const production = grammarMd.match(/^arrow\s*=(.*);/m);
    expect(production).not.toBeNull();
    const grammar = [...production![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(ARROWS.map((a) => a.arrow).sort()).toEqual(grammar.sort());
  });

  it('uses every arrow it lists', () => {
    const doc = cheatSheetDocument();
    for (const { arrow } of ARROWS) expect(doc).toMatch(new RegExp(` ${arrow.replace(/[->]/g, '\\$&')} `));
  });
});

describe('tour name target', () => {
  it('picks a service of the first-run document and points inside its quotes', () => {
    const { diagram } = parse(FIRST_RUN_SOURCE);
    const found = nameTarget(FIRST_RUN_SOURCE, diagram.nodes);
    expect(found?.id).toBe('api');
    const line = FIRST_RUN_SOURCE.split('\n')[found!.line - 1];
    expect(line.slice(found!.col - 1, found!.col - 1 + found!.name.length)).toBe(found!.name);
  });

  it('picks a service of the e-commerce example', () => {
    expect(nameTarget(ecommerceExample, parse(ecommerceExample).diagram.nodes)?.id).toBe('orders');
  });

  it('finds nothing to rename in a document without quoted names', () => {
    expect(nameTarget('api -> db\n', parse('api -> db\n').diagram.nodes)).toBeUndefined();
  });
});

describe('starter template', () => {
  it('parses without errors or warnings and can be played', () => {
    const { diagram, diagnostics } = parse(STARTER_TEMPLATE);
    expect(diagnostics).toEqual([]);
    expect(diagram.title).toBe('My system');
    expect(diagram.nodes.length).toBeGreaterThanOrEqual(3);
    expect(diagram.useCases[0]?.scenarios[0]?.steps.length).toBeGreaterThan(0);
  });
});
