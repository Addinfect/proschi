import { describe, expect, it } from 'vitest';
import type { Graph } from '../engine';
import { readScope, type ScopeView } from './scope';
import { layoutScope, type LayoutBox, type ScopeLayout } from './layout';

/**
 * Where the boxes go.
 *
 * `scope.test.ts` checks what a level *is*; this checks that it can be drawn --
 * positions, arrow routes, and the two things a picture has to get right: an
 * arrow leaves the box it belongs to, and a level that was opened is framed.
 *
 * The numbers are pinned to the default sizes on purpose. A layout is arithmetic,
 * and arithmetic that drifts silently is worth noticing; when a default really has
 * to change, the failures below say which picture changed with it.
 *
 * Nothing here needs a DOM, which is the point: placing boxes is a reading of the
 * model, and only painting them is the renderer's business.
 */

/** Five modules, no nesting: every node is at the top level. */
const model: Graph = {
  nodes: [
    { id: 'a', type: 'module' },
    { id: 'b', type: 'module' },
    { id: 'c', type: 'module' },
    { id: 'd', type: 'module' },
    { id: 'e', type: 'module' },
  ],
  edges: [
    { id: 'a-needs-b', relation: 'depends-on', source: 'a', target: 'b' },
    { id: 'a-needs-c', relation: 'depends-on', source: 'a', target: 'c' },
    { id: 'b-needs-d', relation: 'depends-on', source: 'b', target: 'd' },
    { id: 'c-needs-d', relation: 'depends-on', source: 'c', target: 'd' },
  ],
};

const draws = { nests: 'composes', draws: ['depends-on'] } as const;

function level(graph: Graph = model, root?: string): ScopeView {
  return readScope(graph, root === undefined ? draws : { ...draws, root });
}

function lay(graph: Graph = model, root?: string): ScopeLayout {
  return layoutScope(level(graph, root));
}

/** A box, placed, or a loud failure -- a missing box is the point of most tests. */
function boxOf(layout: ScopeLayout, id: string): LayoutBox {
  const box = layout.boxes.find((drawn) => drawn.id === id);
  if (box === undefined) throw new Error(`the layout has no box "${id}"`);
  return box;
}

/** The edge between two boxes, as routed. */
function edgeOf(layout: ScopeLayout, from: string, to: string) {
  const edge = layout.edges.find((drawn) => drawn.from === from && drawn.to === to);
  if (edge === undefined) throw new Error(`the layout has no edge ${from} -> ${to}`);
  return edge;
}

/** Top left corner of every box, in the order the model declares them. */
function cornersOf(layout: ScopeLayout): string[] {
  return layout.boxes.map((box) => `${box.id} ${box.x},${box.y}`);
}

describe('a layout of one level', () => {
  it('draws nothing of an empty level, and still has a canvas', () => {
    const layout = layoutScope(readScope({ nodes: [], edges: [] }, draws));
    expect(layout.boxes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect([layout.width, layout.height]).toEqual([48, 48]);
    expect(layout.frame).toBeUndefined();
  });

  it('puts a box below everything it points at, in model order within a rank', () => {
    const layout = lay();
    // Model order, not rank order: a reader who knows the source can find a box.
    expect(cornersOf(layout)).toEqual([
      'a 24,24',
      'b 24,136',
      'c 184,136',
      'd 104,248',
      'e 184,24',
    ]);
    expect([layout.width, layout.height]).toEqual([336, 320]);
  });

  it('centres a rank on its own, so one box below two sits in the middle', () => {
    const layout = lay();
    const d = boxOf(layout, 'd');
    expect(d.x + d.width / 2).toBe(layout.width / 2);
  });

  it('never lets two boxes in one rank overlap', () => {
    const layout = lay();
    for (const y of [24, 136]) {
      const row = layout.boxes.filter((box) => box.y === y).sort((l, r) => l.x - r.x);
      for (let i = 1; i < row.length; i += 1) {
        const left = row[i - 1];
        const right = row[i];
        if (left === undefined || right === undefined) continue;
        expect(right.x).toBeGreaterThanOrEqual(left.x + left.width);
      }
    }
  });

  it('leaves every arrow from the bottom of its box and lands on the top of the other', () => {
    const layout = lay();
    expect(layout.edges.length).toBe(4);
    for (const edge of layout.edges) {
      const from = boxOf(layout, edge.from);
      const to = boxOf(layout, edge.to);
      expect(edge.kind).toBe('forward');
      expect(edge.path[0]).toEqual({ x: from.x + from.width / 2, y: from.y + from.height });
      expect(edge.path[edge.path.length - 1]).toEqual({ x: to.x + to.width / 2, y: to.y });
    }
  });

  it('draws a shared column as one straight leg, not a zero width detour', () => {
    const layout = lay();
    expect(edgeOf(layout, 'a', 'b').path).toEqual([
      { x: 88, y: 72 },
      { x: 88, y: 136 },
    ]);
    expect(edgeOf(layout, 'a', 'c').path).toEqual([
      { x: 88, y: 72 },
      { x: 88, y: 104 },
      { x: 248, y: 104 },
      { x: 248, y: 136 },
    ]);
  });

  it('puts the label on the longest leg, where nothing else is written', () => {
    const layout = lay();
    expect(edgeOf(layout, 'a', 'c').label).toEqual({ x: 168, y: 104 });
    expect(edgeOf(layout, 'b', 'd').label).toEqual({ x: 128, y: 216 });
  });

  it('keeps what a collapsed edge stood for', () => {
    // Two dependencies, one arrow: the count and the members travel with it, so a
    // renderer can say "2" without re-reading the model.
    const scope: ScopeView = {
      boxes: [
        { id: 'a', children: [] },
        { id: 'b', children: [] },
      ],
      edges: [
        {
          relation: 'depends-on',
          from: 'a',
          to: 'b',
          count: 2,
          members: ['one', 'two'],
          crosses: false,
        },
      ],
      issues: [],
    };
    const layout = layoutScope(scope);
    expect(layout.edges[0]?.count).toBe(2);
    expect(layout.edges[0]?.members).toEqual(['one', 'two']);
    expect(layout.edges[0]?.relation).toBe('depends-on');
  });

  it('reads the same level twice into the same picture', () => {
    expect(lay()).toEqual(lay());
  });
});

describe('a layout of an opened node', () => {
  /** `core` holds `a` and `b`; `a` points at something outside, `out` points in. */
  const nested: Graph = {
    nodes: [
      { id: 'core', type: 'module' },
      { id: 'a', type: 'module' },
      { id: 'b', type: 'module' },
      { id: 'out', type: 'module' },
    ],
    edges: [
      { id: 'core-holds-a', relation: 'composes', source: 'core', target: 'a' },
      { id: 'core-holds-b', relation: 'composes', source: 'core', target: 'b' },
      { id: 'a-needs-out', relation: 'depends-on', source: 'a', target: 'out' },
      { id: 'out-needs-b', relation: 'depends-on', source: 'out', target: 'b' },
    ],
  };

  it('frames a node that was opened, and puts every box inside the frame', () => {
    const layout = lay(nested, 'core');
    const frame = layout.frame;
    expect(frame?.id).toBe('core');
    expect(frame?.label).toBe('core');
    for (const box of layout.boxes) {
      expect(box.x).toBeGreaterThanOrEqual(frame?.x ?? 0);
      expect(box.y).toBeGreaterThanOrEqual(frame?.y ?? 0);
      expect(box.x + box.width).toBeLessThanOrEqual((frame?.x ?? 0) + (frame?.width ?? 0));
      expect(box.y + box.height).toBeLessThanOrEqual((frame?.y ?? 0) + (frame?.height ?? 0));
    }
  });

  it('stops an arrow that leaves the scope at the frame, so it reads as a stub', () => {
    const layout = lay(nested, 'core');
    const out = edgeOf(layout, 'a', 'core');
    expect(out.kind).toBe('cross');
    expect(out.crosses).toBe(true);
    expect(out.path[out.path.length - 1]?.y).toBe(
      (layout.frame?.y ?? 0) + (layout.frame?.height ?? 0),
    );
  });

  it('brings an arrow in from outside down to the box it enters', () => {
    const layout = lay(nested, 'core');
    const inbound = edgeOf(layout, 'core', 'b');
    const b = boxOf(layout, 'b');
    expect(inbound.kind).toBe('cross');
    expect(inbound.crosses).toBe(true);
    expect(inbound.path[0]?.y).toBe(layout.frame?.y);
    expect(inbound.path[inbound.path.length - 1]).toEqual({ x: b.x + b.width / 2, y: b.y });
  });

  it('draws one stub when an arrow in the scope has no end in it', () => {
    // `core` itself depending on something outside: both ends are the frame.
    const graph: Graph = {
      nodes: [...nested.nodes],
      edges: [
        ...nested.edges,
        { id: 'core-needs-out', relation: 'depends-on', source: 'core', target: 'out' },
      ],
    };
    const layout = lay(graph, 'core');
    const stub = edgeOf(layout, 'core', 'core');
    expect(stub.kind).toBe('cross');
    // Inside the canvas: a stub drawn outwards would be clipped by the frame.
    expect(stub.path[0]?.y).toBe(layout.frame?.y);
    expect(stub.path[1]?.y).toBe((layout.frame?.y ?? 0) + 16);
  });
});

describe('a layout of an awkward level', () => {
  it('loops a self edge on the right of its box, clear of the box', () => {
    const graph: Graph = {
      nodes: [{ id: 'a', type: 'module' }],
      edges: [{ id: 'a-needs-a', relation: 'depends-on', source: 'a', target: 'a' }],
    };
    const layout = lay(graph);
    const loop = layout.edges[0];
    expect(loop?.kind).toBe('self');
    expect(loop?.path).toEqual([
      { x: 152, y: 40 },
      { x: 172, y: 40 },
      { x: 172, y: 56 },
      { x: 152, y: 56 },
    ]);
    expect(loop?.label).toEqual({ x: 178, y: 48 });
    expect(boxOf(layout, 'a').width).toBe(128);
  });

  it('routes a cycle back around the outside instead of through the stack', () => {
    // `a` needs `b` and `b` needs `a`: the model is broken and the checker says so,
    // but the picture still has to end. One leg goes down, the other around the left.
    const graph: Graph = {
      nodes: [
        { id: 'a', type: 'module' },
        { id: 'b', type: 'module' },
      ],
      edges: [
        { id: 'a-needs-b', relation: 'depends-on', source: 'a', target: 'b' },
        { id: 'b-needs-a', relation: 'depends-on', source: 'b', target: 'a' },
      ],
    };
    const layout = lay(graph);
    const down = edgeOf(layout, 'a', 'b');
    const back = edgeOf(layout, 'b', 'a');
    expect(down.kind).toBe('forward');
    expect(back.kind).toBe('back');
    // Out of the left edge of its box, and to the left of both boxes.
    expect(back.path[0]?.x).toBe(boxOf(layout, 'b').x);
    expect(back.path[1]?.x).toBeLessThan(boxOf(layout, 'a').x);
  });

  it('widens a box for a long label, and stops at the maximum', () => {
    const short = layoutScope(level(), { labelOf: () => 'a' });
    const long = layoutScope(level(), { labelOf: (id) => `module ${id}` });
    const huge = layoutScope(level(), { labelOf: (id) => `${'x'.repeat(40)}${id}` });
    expect(boxOf(short, 'a').width).toBe(128);
    expect(boxOf(long, 'a').width).toBe(128);
    expect(boxOf(long, 'a').label).toBe('module a');
    expect(boxOf(huge, 'a').width).toBe(240);
  });

  it('carries the issues of the level through, so a renderer can show them', () => {
    const layout = lay(model, 'nope');
    expect(layout.boxes).toEqual([]);
    expect(layout.issues.map((issue) => issue.code)).toEqual(['unknown-root']);
  });
});
