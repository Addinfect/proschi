import { describe, expect, it } from 'vitest';
import { COMPOSES, DEPENDS_ON, USES } from '../ontology/architecture';
import { layoutScope, type EdgeKind, type Point, type ScopeLayout } from './layout';
import { costSplit, measure, type LayoutMetrics } from './metrics';
import { readScope } from './scope';
import { labelOf, SHOP } from './spike/model';

/**
 * What the measure counts.
 *
 * `layout.test.ts` says where the boxes go; this says what the picture costs the
 * reader. Two halves, for two reasons. The fixtures below are counted by hand, so a
 * wrong count is caught in the metric rather than in a picture. The spike model is
 * measured as the spike page draws it, because a number is only worth quoting if it
 * is about the drawing somebody complained about.
 */

/** A box of a fixture: placed, with the size a fixture could not be bothered to give. */
interface Placed {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width?: number;
  readonly height?: number;
}

/** An arrow of a fixture: a route, and where its label goes. */
interface Routed {
  readonly path: readonly Point[];
  readonly label?: Point;
  /** What the router thought it was doing. A fixture that says nothing drew a grid arrow. */
  readonly kind?: EdgeKind;
}

/**
 * A layout assembled by hand, so that every count can be checked with a pencil. The
 * canvas is always the same one: these fixtures are about lines, and `clean` pins what
 * the canvas costs.
 */
function drawing(boxes: readonly Placed[], edges: readonly Routed[]): ScopeLayout {
  return {
    boxes: boxes.map((box) => ({
      id: box.id,
      label: box.id,
      x: box.x,
      y: box.y,
      width: box.width ?? 60,
      height: box.height ?? 30,
      children: [],
    })),
    edges: edges.map((edge, at) => ({
      relation: 'depends-on',
      from: `from-${at}`,
      to: `to-${at}`,
      kind: edge.kind ?? 'forward',
      count: 1,
      members: [],
      crosses: false,
      head: true,
      path: edge.path,
      // A label nobody asked for goes outside the canvas, and each one away from the
      // next, so that a fixture saying nothing about labels counts none.
      label: edge.label ?? { x: -1000 - at * 100, y: -1000 },
    })),
    width: 400,
    height: 300,
    issues: [],
  };
}

/** A drawing with nothing wrong with it, on the canvas `drawing` hands out. */
const clean: LayoutMetrics = {
  throughBox: 0,
  shared: 0,
  crossings: 0,
  crowding: 0,
  bends: 0,
  labelsOnBox: 0,
  labelsTogether: 0,
  diagonal: 0,
  area: 400 * 300,
};

describe('a drawing, counted', () => {
  it('counts two arrows crossing, and not two arrows touching', () => {
    // One arrow runs down between the boxes, the other across through that line.
    const crossing = drawing(
      [
        { id: 'a', x: 0, y: 0 },
        { id: 'b', x: 0, y: 200 },
        { id: 'c', x: -100, y: 130 },
        { id: 'd', x: 100, y: 130 },
      ],
      [
        { path: [{ x: 30, y: 30 }, { x: 30, y: 200 }] },
        { path: [{ x: -40, y: 145 }, { x: 100, y: 145 }] },
      ],
    );
    expect(measure(crossing)).toEqual({ ...clean, crossings: 1 });

    // The same two arrows, but the vertical stops where the horizontal passes: a
    // landing, and a landing is not a crossing.
    const touching = drawing(
      [],
      [
        { path: [{ x: 30, y: 0 }, { x: 30, y: 145 }] },
        { path: [{ x: -40, y: 145 }, { x: 100, y: 145 }] },
      ],
    );
    expect(measure(touching)).toEqual(clean);
  });

  it('counts two arrows on one line, and not two that end where another starts', () => {
    const oneLine = drawing(
      [],
      [
        { path: [{ x: 0, y: 145 }, { x: 200, y: 145 }] },
        { path: [{ x: 100, y: 145 }, { x: 300, y: 145 }] },
      ],
    );
    expect(measure(oneLine)).toEqual({ ...clean, shared: 1 });

    // End to end on one line is a touch, not a shared stretch: each arrow still has
    // its own length of ink.
    const endToEnd = drawing(
      [],
      [
        { path: [{ x: 0, y: 145 }, { x: 100, y: 145 }] },
        { path: [{ x: 100, y: 145 }, { x: 200, y: 145 }] },
      ],
    );
    expect(measure(endToEnd)).toEqual(clean);
  });

  it('counts an arrow through a box, and not one along its wall or onto it', () => {
    const box = { id: 'box', x: 100, y: 100 };
    const through = drawing([box], [{ path: [{ x: 130, y: 0 }, { x: 130, y: 200 }] }]);
    expect(measure(through)).toEqual({ ...clean, throughBox: 1 });

    // Down the wall, and down onto the top edge: neither one enters the box.
    const along = drawing([box], [{ path: [{ x: 100, y: 0 }, { x: 100, y: 200 }] }]);
    expect(measure(along)).toEqual(clean);

    const onto = drawing([box], [{ path: [{ x: 130, y: 0 }, { x: 130, y: 100 }] }]);
    expect(measure(onto)).toEqual(clean);
  });

  it('counts two parallel arrows a hair apart, and forgives one threshold apart', () => {
    // Four pixels apart is one thick line; `TOGETHER` is eight, so this is the
    // assumption being tested, not the drawing.
    const tight = drawing(
      [],
      [
        { path: [{ x: 100, y: 0 }, { x: 100, y: 200 }] },
        { path: [{ x: 104, y: 0 }, { x: 104, y: 200 }] },
      ],
    );
    expect(measure(tight)).toEqual({ ...clean, crowding: 1 });

    const apart = drawing(
      [],
      [
        { path: [{ x: 100, y: 0 }, { x: 100, y: 200 }] },
        { path: [{ x: 108, y: 0 }, { x: 108, y: 200 }] },
      ],
    );
    expect(measure(apart)).toEqual(clean);
  });

  it('counts corners rather than legs', () => {
    const bent = drawing(
      [],
      [
        {
          // Six points, so four corners: a route is paid for in corners.
          path: [
            { x: 0, y: 0 },
            { x: 0, y: 100 },
            { x: 50, y: 100 },
            { x: 50, y: 0 },
            { x: 100, y: 0 },
            { x: 100, y: 100 },
          ],
        },
        { path: [{ x: 0, y: 200 }, { x: 100, y: 200 }] },
      ],
    );
    expect(measure(bent)).toEqual({ ...clean, bends: 4 });
  });

  it('splits the cost between the arrows that leave the grid and the rest', () => {
    const mixed = drawing(
      [],
      [
        // Round the outside and back: two corners, both paid for by this one detour.
        {
          path: [
            { x: 0, y: 0 },
            { x: 0, y: 50 },
            { x: 100, y: 50 },
            { x: 100, y: 0 },
          ],
          kind: 'back',
        },
        { path: [{ x: 50, y: -20 }, { x: 50, y: 80 }] },
      ],
    );
    // The one crossing is a detour meeting a grid arrow, which is what `mixed` is for:
    // neither half can fix it alone.
    expect(costSplit(mixed)).toEqual({
      bends: { detour: 2, grid: 0 },
      crossings: { detour: 0, mixed: 1, grid: 0 },
    });
  });

  it('counts labels that sit on a box or on each other', () => {
    const labels = drawing(
      [{ id: 'box', x: 200, y: 200 }],
      [
        { path: [{ x: 0, y: 0 }, { x: 0, y: 100 }], label: { x: 10, y: 10 } },
        // Five pixels away from the first: one word, not two.
        { path: [{ x: 40, y: 0 }, { x: 40, y: 100 }], label: { x: 15, y: 10 } },
        { path: [{ x: 80, y: 0 }, { x: 80, y: 100 }], label: { x: 220, y: 210 } },
      ],
    );
    expect(measure(labels)).toEqual({ ...clean, labelsOnBox: 1, labelsTogether: 1 });
  });
});

/** The shop at the top level, exactly as the spike page draws it. */
function spike(): ScopeLayout {
  const scope = readScope(SHOP, { nests: COMPOSES, draws: [USES, DEPENDS_ON] });
  return layoutScope(scope, { labelOf });
}

describe('the spike model, measured', () => {
  it('draws no arrow through a box', () => {
    // The one promise a route keeps or breaks outright: round the boxes, or nowhere.
    expect(measure(spike()).throughBox).toBe(0);
  });

  it('draws no line that is not a right angle', () => {
    expect(measure(spike()).diagonal).toBe(0);
  });

  it('says where the cost sits', () => {
    // The total above says how bad it is; this says which half of the router to change.
    expect(costSplit(spike())).toMatchInlineSnapshot();
  });

  it('says what the rest of the picture costs', () => {
    const metrics = measure(spike());
    // The numbers below are the picture as it is, not as it should be: `shared` counts
    // the two loops on one box that are drawn in the same place. Lowering them is what
    // the next change is for, and this is where it has to show.
    expect({
      shared: metrics.shared,
      crossings: metrics.crossings,
      crowding: metrics.crowding,
      bends: metrics.bends,
      labelsOnBox: metrics.labelsOnBox,
      labelsTogether: metrics.labelsTogether,
      area: metrics.area,
    }).toMatchInlineSnapshot(`
      {
        "area": 554944,
        "bends": 50,
        "crossings": 56,
        "crowding": 2,
        "labelsOnBox": 0,
        "labelsTogether": 0,
        "shared": 1,
      }
    `);
  });
});
