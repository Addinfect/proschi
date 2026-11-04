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
    expect(costSplit(spike())).toMatchInlineSnapshot(`
      {
        "bends": {
          "detour": 28,
          "grid": 20,
        },
        "crossings": {
          "detour": 23,
          "grid": 5,
          "mixed": 11,
        },
      }
    `);
  });

  it('says what the rest of the picture costs', () => {
    const metrics = measure(spike());
    // The numbers below are the picture as it is, not as it should be. Ordering the ranks
    // was worth 2 crossings; spreading the anchors by where they land was worth 8 more, and
    // `shared` fell to 0 with them -- no two arrows are pushed onto one pixel any more.
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
        "bends": 48,
        "crossings": 39,
        "crowding": 1,
        "labelsOnBox": 0,
        "labelsTogether": 0,
        "shared": 1,
      }
    `);
  });
});

/*
 * TEMPORARY -- delete once it has answered its question.
 *
 * The counts above say how many crossings there are, and `costSplit` says whether a
 * detour stands on one side of them. Neither says *which leg* does the crossing, and
 * that is the only thing that decides what to change next: a crossing made by the
 * channel run is a channel problem, one made by an entry run is a lane problem, and
 * they are fixed in different parts of the router.
 *
 * The runs below are read exactly the way `metrics.ts` reads them -- same rule for what
 * counts as a crossing -- so that the total here and the promise up there cannot drift
 * apart. What is added is a name for each run: where it sits in its own route. The name
 * is read off the shape, not off the path index, so a point `simplify` dropped does not
 * shift the answer.
 */

/** One straight run of one arrow, named by its part in that arrow. */
interface Run {
  /** Which arrow it belongs to, so that an arrow is never measured against itself. */
  readonly owner: number;
  /** The arrow in full, as `from->to[kind]`, so a line of output can be read alone. */
  readonly own: string;
  /** Which leg of the route this is: `exit`, `channel`, `across-in`, and so on. */
  readonly role: string;
  readonly vertical: boolean;
  readonly from: number;
  readonly to: number;
  /** The coordinate it sits at: its x when it is vertical, its y when it is horizontal. */
  readonly at: number;
}

/**
 * What a run is doing, in the words the router already uses. A route drawn by
 * `forward` has one vertical run on each side of one horizontal one, so the first and
 * last vertical are the leaving and the arriving run; a detour has a third vertical in
 * between, which is the channel. Counted per direction rather than by index, because
 * `simplify` is free to drop a point and a name must not depend on that.
 */
function roleOf(kind: EdgeKind, vertical: boolean, index: number, count: number): string {
  if (kind === 'cross') return 'wall';
  if (kind === 'self') return vertical ? 'loop-riser' : index === 0 ? 'loop-out' : 'loop-in';
  if (vertical) {
    if (count === 1) return 'riser';
    if (index === 0) return 'exit';
    if (index === count - 1) return 'entry';
    return 'channel';
  }
  if (count === 1) return 'lane';
  if (index === 0) return 'across-out';
  if (index === count - 1) return 'across-in';
  return 'across';
}

/** Every run in the drawing, named. Diagonal legs are left out: no count here sees them. */
function runs(layout: ScopeLayout): Run[] {
  const out: Run[] = [];
  layout.edges.forEach((edge, owner) => {
    const own = `${edge.from}->${edge.to}[${edge.kind}]`;
    const legs: { vertical: boolean; from: number; to: number; at: number }[] = [];
    for (let at = 1; at < edge.path.length; at += 1) {
      const a: Point | undefined = edge.path[at - 1];
      const b: Point | undefined = edge.path[at];
      if (a === undefined || b === undefined) continue;
      if (a.x !== b.x && a.y !== b.y) continue;
      const vertical = a.x === b.x;
      const first = vertical ? a.y : a.x;
      const second = vertical ? b.y : b.x;
      legs.push({
        vertical,
        from: Math.min(first, second),
        to: Math.max(first, second),
        at: vertical ? a.x : a.y,
      });
    }
    const verticals = legs.filter((leg) => leg.vertical);
    const horizontals = legs.filter((leg) => !leg.vertical);
    for (const leg of legs) {
      const peers = leg.vertical ? verticals : horizontals;
      out.push({
        owner,
        own,
        role: roleOf(edge.kind, leg.vertical, peers.indexOf(leg), peers.length),
        vertical: leg.vertical,
        from: leg.from,
        to: leg.to,
        at: leg.at,
      });
    }
  });
  return out;
}

/** The same test `metrics.ts` makes: both coordinates strictly inside the other run. */
function hits(first: Run, second: Run): boolean {
  if (first.vertical === second.vertical) return false;
  const vertical = first.vertical ? first : second;
  const horizontal = first.vertical ? second : first;
  return (
    vertical.at > horizontal.from &&
    vertical.at < horizontal.to &&
    horizontal.at > vertical.from &&
    horizontal.at < vertical.to
  );
}

/** A run as one token: what it belongs to, what it is, and where it sits. */
function named(run: Run): string {
  return `${run.role} ${run.vertical ? 'x' : 'y'}=${run.at} of ${run.own}`;
}

/** Every crossing, each as the pair of runs that make it. */
function crossingsOf(layout: ScopeLayout): [Run, Run][] {
  const all = runs(layout);
  const found: [Run, Run][] = [];
  all.forEach((first, at) => {
    for (let further = at + 1; further < all.length; further += 1) {
      const second = all[further];
      if (second === undefined || second.owner === first.owner) continue;
      if (hits(first, second)) found.push([first, second]);
    }
  });
  return found;
}

describe('the spike model, crossing by crossing', () => {
  it('reads the crossings the measure counts', () => {
    // If these ever disagree, every line below is about a different picture than the
    // numbers above, and the diagnosis is worth nothing.
    const layout = spike();
    expect(crossingsOf(layout).length).toBe(measure(layout).crossings);
  });

  it('names the leg on each side of every crossing', () => {
    const found = crossingsOf(spike());
    const groups = new Map<string, string[]>();
    for (const [first, second] of found) {
      const pair = [first.role, second.role].sort().join(' x ');
      const lines = groups.get(pair) ?? [];
      lines.push(`${named(first)}  with  ${named(second)}`);
      groups.set(pair, lines);
    }
    const ranked = [...groups]
      .map(([pair, lines]) => ({ pair, count: lines.length, lines: [...lines].sort() }))
      .sort((left, right) => right.count - left.count || left.pair.localeCompare(right.pair));
    expect({ total: found.length, ranked }).toMatchInlineSnapshot(`
      {
        "ranked": [
          {
            "count": 14,
            "lines": [
              "across-in y=344 of storefront->catalog[around]  with  channel x=168 of backoffice->ledger[around]",
              "across-in y=344 of storefront->catalog[around]  with  channel x=184 of backoffice->bus[around]",
              "across-in y=344 of storefront->catalog[around]  with  channel x=209 of checkout->ledger[around]",
              "across-in y=344 of storefront->catalog[around]  with  channel x=225 of checkout->bus[around]",
              "across-in y=488 of backoffice->bus[around]  with  channel x=209 of checkout->ledger[around]",
              "across-in y=488 of backoffice->bus[around]  with  channel x=225 of checkout->bus[around]",
              "across-in y=488 of backoffice->bus[around]  with  channel x=289 of payments->ledger[around]",
              "across-in y=488 of backoffice->bus[around]  with  channel x=305 of payments->ledger[around]",
              "across-in y=504 of checkout->bus[around]  with  channel x=289 of payments->ledger[around]",
              "across-in y=504 of checkout->bus[around]  with  channel x=305 of payments->ledger[around]",
              "across-in y=600 of backoffice->ledger[around]  with  channel x=209 of checkout->ledger[around]",
              "across-in y=600 of backoffice->ledger[around]  with  channel x=289 of payments->ledger[around]",
              "across-in y=600 of backoffice->ledger[around]  with  channel x=305 of payments->ledger[around]",
              "across-in y=632 of checkout->ledger[around]  with  channel x=289 of payments->ledger[around]",
            ],
            "pair": "across-in x channel",
          },
          {
            "count": 7,
            "lines": [
              "exit x=226 of backoffice->checkout[forward]  with  across-out y=104 of backoffice->bus[around]",
              "exit x=226 of backoffice->checkout[forward]  with  across-out y=120 of backoffice->ledger[around]",
              "exit x=267 of checkout->catalog[forward]  with  across-out y=280 of checkout->bus[around]",
              "exit x=267 of checkout->catalog[forward]  with  across-out y=296 of checkout->ledger[around]",
              "exit x=305 of catalog->bus[forward]  with  across-out y=440 of payments->ledger[around]",
              "exit x=465 of payments->bus[forward]  with  across-out y=440 of payments->ledger[around]",
              "exit x=83 of storefront->checkout[forward]  with  across-out y=88 of storefront->catalog[around]",
            ],
            "pair": "across-out x exit",
          },
          {
            "count": 6,
            "lines": [
              "entry x=342 of backoffice->ledger[around]  with  across-in y=616 of payments->ledger[around]",
              "entry x=342 of backoffice->ledger[around]  with  across-in y=632 of checkout->ledger[around]",
              "entry x=342 of backoffice->ledger[around]  with  across-in y=648 of payments->ledger[around]",
              "entry x=347 of backoffice->bus[around]  with  across-in y=504 of checkout->bus[around]",
              "entry x=364 of checkout->ledger[around]  with  across-in y=648 of payments->ledger[around]",
              "entry x=406 of payments->ledger[around]  with  across-in y=648 of payments->ledger[around]",
            ],
            "pair": "across-in x entry",
          },
          {
            "count": 3,
            "lines": [
              "channel x=184 of backoffice->bus[around]  with  across-out y=120 of backoffice->ledger[around]",
              "channel x=225 of checkout->bus[around]  with  across-out y=296 of checkout->ledger[around]",
              "channel x=305 of payments->ledger[around]  with  across-out y=440 of payments->ledger[around]",
            ],
            "pair": "across-out x channel",
          },
          {
            "count": 3,
            "lines": [
              "entry x=273 of storefront->checkout[forward]  with  lane y=152 of backoffice->checkout[forward]",
              "entry x=305 of backoffice->checkout[forward]  with  lane y=184 of backoffice->identity[forward]",
              "lane y=184 of backoffice->identity[forward]  with  entry x=337 of partner-integration-gateway->checkout[forward]",
            ],
            "pair": "entry x lane",
          },
          {
            "count": 2,
            "lines": [
              "across-in y=616 of payments->ledger[around]  with  riser x=385 of bus->ledger[forward]",
              "across-in y=648 of payments->ledger[around]  with  riser x=385 of bus->ledger[forward]",
            ],
            "pair": "across-in x riser",
          },
          {
            "count": 2,
            "lines": [
              "lane y=136 of storefront->checkout[forward]  with  channel x=168 of backoffice->ledger[around]",
              "lane y=136 of storefront->checkout[forward]  with  channel x=184 of backoffice->bus[around]",
            ],
            "pair": "channel x lane",
          },
          {
            "count": 2,
            "lines": [
              "lane y=136 of storefront->checkout[forward]  with  exit x=226 of backoffice->checkout[forward]",
              "lane y=152 of backoffice->checkout[forward]  with  exit x=302 of backoffice->identity[forward]",
            ],
            "pair": "exit x lane",
          },
        ],
        "total": 39,
      }
    `);
  });
});

