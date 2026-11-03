import { describe, expect, it } from 'vitest';
import type { Graph } from '../engine';
import { readScope, type ScopeView } from './scope';
import { layoutScope, type LayoutBox, type LayoutEdge, type ScopeLayout } from './layout';

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

/** The two points an arrow really attaches to, whichever way it was routed. */
function endsOf(edge: LayoutEdge) {
  return { start: edge.path[0], end: edge.path[edge.path.length - 1] };
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

  it('leaves every arrow from the bottom of its box, and lands it on the top of the other', () => {
    const layout = lay();
    expect(layout.edges.length).toBe(4);
    for (const edge of layout.edges) {
      const from = boxOf(layout, edge.from);
      const to = boxOf(layout, edge.to);
      const { start, end } = endsOf(edge);
      expect(edge.kind).toBe('forward');
      expect(edge.head).toBe(true);
      expect(start.y).toBe(from.y + from.height);
      expect(start.x).toBeGreaterThanOrEqual(from.x);
      expect(start.x).toBeLessThanOrEqual(from.x + from.width);
      expect(end.y).toBe(to.y);
      expect(end.x).toBeGreaterThanOrEqual(to.x);
      expect(end.x).toBeLessThanOrEqual(to.x + to.width);
    }
  });

  it('gives every arrow on a shared side its own anchor, and a lone one the middle', () => {
    const layout = lay();
    // Two arrows leave `a` and two land on `d`: neither pair may share a pixel, or
    // a fan of relations reads as one line that forks halfway down.
    expect(endsOf(edgeOf(layout, 'a', 'b')).start.x).not.toBe(endsOf(edgeOf(layout, 'a', 'c')).start.x);
    expect(endsOf(edgeOf(layout, 'b', 'd')).end.x).not.toBe(endsOf(edgeOf(layout, 'c', 'd')).end.x);
    // `b` is entered by one arrow only, and that one comes down its middle.
    const b = boxOf(layout, 'b');
    expect(endsOf(edgeOf(layout, 'a', 'b')).end).toEqual({ x: b.x + b.width / 2, y: b.y });
  });

  it('gives every arrow across one gap its own line, so two labels never share a pixel', () => {
    // Three arrows out of one box and into one rank: one horizontal line each, at
    // three different heights. Stacked on one pixel they read as a single arrow
    // with three names written over it.
    const graph: Graph = {
      nodes: [
        { id: 'hub', type: 'module' },
        { id: 'left', type: 'module' },
        { id: 'middle', type: 'module' },
        { id: 'right', type: 'module' },
      ],
      edges: [
        { id: 'hub-needs-left', relation: 'depends-on', source: 'hub', target: 'left' },
        { id: 'hub-needs-middle', relation: 'depends-on', source: 'hub', target: 'middle' },
        { id: 'hub-needs-right', relation: 'depends-on', source: 'hub', target: 'right' },
      ],
    };
    const layout = lay(graph);
    const hub = boxOf(layout, 'hub');
    const lanes = ['left', 'middle', 'right'].map((to) => {
      const edge = edgeOf(layout, 'hub', to);
      // Its own height, and inside the gap: below the box it leaves, above the rank
      // it lands on. Read off the label, not the path -- an arrow whose two ends line
      // up is drawn as one straight leg, and its lane is then a point the polyline no
      // longer carries.
      expect(edge.label.y).toBeGreaterThan(hub.y + hub.height);
      expect(edge.label.y).toBeLessThan(boxOf(layout, to).y);
      return edge.label.y;
    });
    expect(new Set(lanes).size).toBe(3);
    // In the order they land, left to right, so the fan does not cross itself.
    expect(lanes[0]).toBeLessThan(lanes[1]);
    expect(lanes[1]).toBeLessThan(lanes[2]);
  });

  it('draws a vertical pair as one straight leg, not a zero width detour', () => {
    // One box above the other, one arrow: no reason to step sideways at all.
    const graph: Graph = {
      nodes: [
        { id: 'a', type: 'module' },
        { id: 'b', type: 'module' },
      ],
      edges: [{ id: 'a-needs-b', relation: 'depends-on', source: 'a', target: 'b' }],
    };
    expect(edgeOf(lay(graph), 'a', 'b').path).toEqual([
      { x: 88, y: 72 },
      { x: 88, y: 136 },
    ]);
  });

  it('puts the label on the longest leg, where nothing else is written', () => {
    const layout = lay();
    // Half way between the ranks and between the two anchors: the leg across the
    // gap is the long one, so the count sits on it.
    expect(edgeOf(layout, 'a', 'c').label).toEqual({ x: 179, y: 115 });
    expect(edgeOf(layout, 'b', 'd').label).toEqual({ x: 118, y: 205 });
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
    // Room outside the wall on every side: an arrow crossing it has to be seen
    // leaving, not be clipped by the edge of the picture.
    expect(frame?.x).toBe(28);
    expect(layout.width - ((frame?.x ?? 0) + (frame?.width ?? 0))).toBe(28);
    expect(layout.height - ((frame?.y ?? 0) + (frame?.height ?? 0))).toBe(28);
  });

  it('runs an arrow that leaves the scope through the wall and out, with no head', () => {
    const layout = lay(nested, 'core');
    const out = edgeOf(layout, 'a', 'core');
    const a = boxOf(layout, 'a');
    const wall = (layout.frame?.y ?? 0) + (layout.frame?.height ?? 0);
    const { start, end } = endsOf(out);
    expect(out.kind).toBe('cross');
    expect(out.crosses).toBe(true);
    // Nothing out there is a box, so nothing is pointed at.
    expect(out.head).toBe(false);
    expect(start.y).toBe(a.y + a.height);
    // Past the wall, so the reader sees it leave -- and still inside the picture.
    expect(end.y).toBeGreaterThan(wall);
    expect(end.y).toBeLessThan(layout.height);
  });

  it('brings an arrow in from outside the wall, and lands it on the box it enters', () => {
    const layout = lay(nested, 'core');
    const inbound = edgeOf(layout, 'core', 'b');
    const b = boxOf(layout, 'b');
    const { start, end } = endsOf(inbound);
    expect(inbound.kind).toBe('cross');
    expect(inbound.crosses).toBe(true);
    // It ends on a box, so it does point.
    expect(inbound.head).toBe(true);
    expect(start.y).toBeLessThan(layout.frame?.y ?? 0);
    expect(end).toEqual({ x: b.x + b.width / 2, y: b.y });
  });

  it('ticks through the wall when an arrow has no end at this level at all', () => {
    // `core` itself depending on something outside: neither end is drawn here.
    const graph: Graph = {
      nodes: [...nested.nodes],
      edges: [
        ...nested.edges,
        { id: 'core-needs-out', relation: 'depends-on', source: 'core', target: 'out' },
      ],
    };
    const layout = lay(graph, 'core');
    const tick = edgeOf(layout, 'core', 'core');
    const wall = layout.frame?.y ?? 0;
    expect(tick.kind).toBe('cross');
    expect(tick.head).toBe(false);
    // Through the wall, not merely up to it: outside first, then a little way in.
    expect(tick.path[0].y).toBeLessThan(wall);
    expect(tick.path[1].y).toBeGreaterThan(wall);
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
