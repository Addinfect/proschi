import { describe, expect, it } from 'vitest';
import type { Graph } from '../engine';
import { readScope, type ScopeView } from './scope';

/**
 * One level of a tree, drawn.
 *
 * The fixture is deliberately lopsided: `a` holds `b` and `c`, `b` holds `d`, and
 * the dependencies run in every direction a scope has to cope with -- inside one
 * box, from one box into another, out of the scope, and two of them leaving the
 * same way so that collapsing can be checked against what it collapsed.
 *
 * Neither the types nor the relation names mean anything to the view: it takes the
 * tree relation and the drawn relations as data, the same way the engine takes an
 * ontology. `module` is only here so the nodes have a type to be.
 */

const model: Graph = {
  nodes: [
    { id: 'a', type: 'module' },
    { id: 'b', type: 'module' },
    { id: 'c', type: 'module' },
    { id: 'd', type: 'module' },
    { id: 'e', type: 'module' },
    { id: 'x', type: 'module' },
  ],
  edges: [
    { id: 'a-holds-b', relation: 'composes', source: 'a', target: 'b' },
    { id: 'a-holds-c', relation: 'composes', source: 'a', target: 'c' },
    { id: 'b-holds-d', relation: 'composes', source: 'b', target: 'd' },
    { id: 'd-needs-e', relation: 'depends-on', source: 'd', target: 'e' },
    { id: 'c-needs-e', relation: 'depends-on', source: 'c', target: 'e' },
    { id: 'c-needs-d', relation: 'depends-on', source: 'c', target: 'd' },
    { id: 'd-needs-b', relation: 'depends-on', source: 'd', target: 'b' },
    { id: 'e-needs-x', relation: 'depends-on', source: 'e', target: 'x' },
    { id: 'b-needs-x', relation: 'depends-on', source: 'b', target: 'x' },
  ],
};

const spec = { nests: 'composes', draws: ['depends-on'] } as const;

/** One level, top or opened, as the fixture above reads it. */
function level(root?: string): ScopeView {
  return readScope(model, root === undefined ? spec : { ...spec, root });
}

/** The boxes of a level, in the order they are drawn. */
function boxesOf(view: ScopeView): string[] {
  return view.boxes.map((box) => box.id);
}

/** The edges of a level as `relation from -> to`, with `(out)` and a count. */
function edgesOf(view: ScopeView): string[] {
  return view.edges.map(
    (edge) =>
      `${edge.relation} ${edge.from} -> ${edge.to}` +
      (edge.crosses ? ' (out)' : '') +
      (edge.count > 1 ? ` x${edge.count}` : ''),
  );
}

/** The edges of the model one drawn edge stands for. */
function membersOf(view: ScopeView, from: string, to: string): string[] {
  const edge = view.edges.find((drawn) => drawn.from === from && drawn.to === to);
  return edge ? [...edge.members] : [];
}

describe('a scope drawing one level of a tree', () => {
  it('draws the top level: the nodes that nothing holds', () => {
    const view = level();
    expect(view.issues).toEqual([]);
    expect(boxesOf(view)).toEqual(['a', 'e', 'x']);
    expect(view.boxes.map((box) => box.children)).toEqual([['b', 'c'], [], []]);
    expect(edgesOf(view)).toEqual([
      'depends-on a -> e x2',
      'depends-on e -> x',
      'depends-on a -> x',
    ]);
  });

  it('folds what sits inside a box into the box, and lifts what leaves the scope', () => {
    // `d-needs-e` and `b-needs-x` leave `a`; `c-needs-e` too. `c-needs-d` stays
    // inside and runs from one box to another, so it is drawn as written.
    expect(edgesOf(level('a'))).toEqual([
      'depends-on b -> a (out) x2',
      'depends-on c -> a (out)',
      'depends-on c -> b',
      'depends-on b -> b',
    ]);
  });

  it('draws an edge that touches a box at the level of that box', () => {
    // `d-needs-b` is inside `b` and points at `b`: at the level of `a` that is a loop
    // on the box, and hiding it would mean a box that looks quiet while it is not.
    const view = level('a');
    expect(edgesOf(view)).toContain('depends-on b -> b');
    // Opened, it is drawn from `d` to `b` -- and shares that lift with `d-needs-e`,
    // which leaves `d` for the outside, so the box does not gain a second arrow.
    expect(membersOf(level('b'), 'd', 'b')).toEqual(['d-needs-e', 'd-needs-b']);
  });

  it('does not draw the relation that makes the tree', () => {
    for (const view of [level(), level('a'), level('b')]) {
      expect(view.edges.map((edge) => edge.relation)).not.toContain('composes');
    }
  });

  it('collapses edges lifted the same way, and keeps what they were', () => {
    // `d-needs-e` and `c-needs-e` both lift to `a -> e` at the top, and are two edges.
    expect(membersOf(level(), 'a', 'e')).toEqual(['d-needs-e', 'c-needs-e']);
    // One level down, the same two edges part company: `d-needs-e` still leaves the
    // scope with `b-needs-x` beside it, which it did not meet at the top.
    expect(membersOf(level('a'), 'b', 'a')).toEqual(['d-needs-e', 'b-needs-x']);
    expect(membersOf(level('a'), 'c', 'a')).toEqual(['c-needs-e']);
  });

  it('gives every collapsed edge back with its own id when the box is opened', () => {
    // Nothing is thrown away to draw a level: the ids a level collapses are exactly
    // the ids the levels below draw one by one.
    for (const view of [level(), level('a'), level('b')]) {
      for (const edge of view.edges) {
        expect(edge.count).toBe(edge.members.length);
        expect(new Set(edge.members).size).toBe(edge.members.length);
      }
    }
    // At the top everything is drawn except the two edges that stay inside a box.
    const drawn = level()
      .edges.flatMap((edge) => edge.members)
      .sort();
    expect(drawn).toEqual(['b-needs-x', 'c-needs-e', 'd-needs-e', 'e-needs-x']);
  });

  it('says so when the scope opens a node that is not there', () => {
    const view = level('nowhere');
    expect(view.boxes).toEqual([]);
    expect(view.edges).toEqual([]);
    expect(view.issues.map((issue) => issue.code)).toEqual(['unknown-root']);
  });

  it('reads the same graph twice into the same answer', () => {
    // A view owns no data: the model is an argument, so two readings cannot differ.
    expect(level('a')).toEqual(level('a'));
  });
});
