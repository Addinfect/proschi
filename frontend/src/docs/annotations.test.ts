import { describe, expect, it } from 'vitest';
import { parse } from '../dsl/parser';
import { anchorRedirect } from './anchorRedirect';
import { litByLine } from './annotations';

const source = `title "Shop"

user "Shopper" [Browser]
group backend "Backend" {
  api "API" [REST API] x2
  db  "DB"  [PostgreSQL]
}

user -> api : HTTPS
api  -> db  : SQL

usecase "Buy" {
  user  -> api : POST /orders
  api   -> db  : INSERT order
  api  --> user : 201
}

traffic {
  "Buy" 100 rps
}`;

describe('what an annotated line lights up', () => {
  const diagram = parse(source).diagram;
  const lit = (line: number) => litByLine(diagram, line);

  it('a node line lights its node, a group line its group', () => {
    expect(lit(3)).toEqual({ nodes: ['user'], edges: [] });
    expect(lit(4)).toEqual({ nodes: ['backend'], edges: [] });
    expect(lit(5)).toEqual({ nodes: ['api'], edges: [] });
  });

  it('a connection lights its arrow, and so does a step along it or its answer', () => {
    expect(lit(9)).toEqual({ nodes: [], edges: ['user->api'] });
    expect(lit(14)).toEqual({ nodes: [], edges: ['api->db'] });
    expect(lit(15)).toEqual({ nodes: [], edges: ['user->api'] });
  });

  it('any other line lights nothing', () => {
    for (const line of [1, 2, 7, 12, 18, 19]) expect(lit(line), `line ${line}`).toEqual({ nodes: [], edges: [] });
  });
});

describe('anchor redirects', () => {
  const map = { 'reads-and-writes': 'use-cases/#reads-and-writes', scenarios: 'scenarios/' };
  const docsRoot = 'https://proschi.app/docs/';

  it('sends an old anchor to its new page, relative to /docs/', () => {
    expect(anchorRedirect(map, '#reads-and-writes', docsRoot)).toBe('https://proschi.app/docs/use-cases/#reads-and-writes');
    expect(anchorRedirect(map, '#scenarios', docsRoot)).toBe('https://proschi.app/docs/scenarios/');
  });

  it('leaves anchors that are not in the map, and inherited names, alone', () => {
    expect(anchorRedirect(map, '#statements', docsRoot)).toBeUndefined();
    expect(anchorRedirect(map, '', docsRoot)).toBeUndefined();
    expect(anchorRedirect(map, '#constructor', docsRoot)).toBeUndefined();
    expect(anchorRedirect(map, '#%E0%A4%A', docsRoot)).toBeUndefined();
  });
});
