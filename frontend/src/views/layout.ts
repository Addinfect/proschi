import type { Id, Issue } from '../engine';
import type { ScopeEdge, ScopeView } from './scope';

/**
 * Where a scope's boxes go on the page, and how the arrows between them run.
 *
 * A renderer has two jobs: decide positions, and put ink on a canvas. Only the
 * first one is a reading of the model, so only the first one lives here -- plain
 * numbers, no SVG, no React, nothing that needs a DOM to check. `ScopeView` says
 * *what* is at this level; this says *where*, and a `<svg>` is then a loop over
 * the result.
 *
 * The layout is a grid of ranks, because the model already has a direction:
 * `depends-on`, `uses`, `realizes` all point somewhere. Ranks come from the
 * longest path along the drawn edges, so a box sits below everything it points
 * at and the arrows mostly run downhill. When the model has a cycle the cap stops
 * the walk, the cycle's closing edge is routed around the outside as a `back`
 * edge, and the picture still terminates -- a cycle is the checker's finding, not
 * a reason to draw nothing.
 *
 * Nothing here invents content. There is no node without a box, no box without a
 * node, and the order within a rank is the order the model declares.
 */

/** A point in the drawing, in pixels, origin top left. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A box, placed. `children` says whether opening it shows anything. */
export interface LayoutBox {
  readonly id: Id;
  /** What to write on the box; the caller's `labelOf`, or the id. */
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly children: readonly Id[];
}

/** The frame around the scope, drawn only when the scope is an opened node. */
export interface LayoutFrame {
  readonly id: Id;
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * How an arrow got where it is:
 *
 * - `forward` — to a lower rank, the ordinary case;
 * - `back` — to the same or a higher rank, so it goes around the left side;
 * - `self` — both ends on one box, a loop on its right edge;
 * - `cross` — an end lies outside the scope, so it stops at the frame (a stub).
 */
export type EdgeKind = 'forward' | 'back' | 'self' | 'cross';

/** An edge from a scope, routed. `path` is a polyline; the last point is the head. */
export interface LayoutEdge {
  readonly relation: string;
  readonly from: Id;
  readonly to: Id;
  readonly kind: EdgeKind;
  readonly count: number;
  readonly members: readonly Id[];
  readonly crosses: boolean;
  readonly path: readonly Point[];
  /** Where the count or the relation name goes: the middle of the longest leg. */
  readonly label: Point;
}

/** A whole level, ready to draw. */
export interface ScopeLayout {
  /** Present only when the scope is an opened node, and then it encloses every box. */
  readonly frame?: LayoutFrame;
  readonly boxes: readonly LayoutBox[];
  readonly edges: readonly LayoutEdge[];
  readonly width: number;
  readonly height: number;
  readonly issues: readonly Issue[];
}

/** Sizes in pixels. Everything is a knob so a test can pin the arithmetic. */
export interface LayoutSpec {
  /** What to write on a box. Defaults to the id. */
  readonly labelOf?: (id: Id) => string;
  readonly boxWidth?: number;
  readonly boxHeight?: number;
  /** Space between boxes in one rank. */
  readonly gapX?: number;
  /** Space between ranks -- where the arrows live. */
  readonly gapY?: number;
  readonly pad?: number;
  /** A long label widens its box up to this, and no further. */
  readonly maxBoxWidth?: number;
  readonly charWidth?: number;
}

const DEFAULTS = {
  boxWidth: 128,
  boxHeight: 48,
  gapX: 32,
  gapY: 64,
  pad: 24,
  maxBoxWidth: 240,
  charWidth: 7,
} as const;

/** The frame needs room for its own label and for the boxes inside it. */
const FRAME_PAD = 16;
const FRAME_HEADER = 24;
/** How far a self loop and a back edge reach outside their box. */
const LOOP_OUT = 20;
const LOOP_HALF = 8;
const BACK_OUT = 16;

/** A box while it is still being placed; it is handed out only once it has a position. */
interface Draft {
  id: Id;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  children: readonly Id[];
}

export function layoutScope(scope: ScopeView, spec: LayoutSpec = {}): ScopeLayout {
  const boxWidth = spec.boxWidth ?? DEFAULTS.boxWidth;
  const boxHeight = spec.boxHeight ?? DEFAULTS.boxHeight;
  const gapX = spec.gapX ?? DEFAULTS.gapX;
  const gapY = spec.gapY ?? DEFAULTS.gapY;
  const pad = spec.pad ?? DEFAULTS.pad;
  const maxBoxWidth = spec.maxBoxWidth ?? DEFAULTS.maxBoxWidth;
  const charWidth = spec.charWidth ?? DEFAULTS.charWidth;
  const labelOf = spec.labelOf ?? ((id: Id): string => id);

  const drafts: Draft[] = scope.boxes.map((box) => {
    const label = labelOf(box.id);
    const wanted = Math.max(boxWidth, Math.min(maxBoxWidth, label.length * charWidth + 20));
    return {
      id: box.id,
      label,
      x: 0,
      y: 0,
      // Even widths keep every anchor on a whole pixel without rounding later.
      width: even(wanted),
      height: boxHeight,
      children: box.children,
    };
  });

  const byId = new Map<Id, Draft>(drafts.map((draft) => [draft.id, draft]));
  const rank = ranksOf(drafts, scope.edges);

  // One row per rank, in model order, because that is the only order anyone
  // reading the source will recognise.
  const rows = new Map<number, Draft[]>();
  for (const draft of drafts) {
    const key = rank.get(draft.id) ?? 0;
    const row = rows.get(key);
    if (row) row.push(draft);
    else rows.set(key, [draft]);
  }
  const keys = [...rows.keys()].sort((a, b) => a - b);
  const widthOfRow = (row: readonly Draft[]): number =>
    row.reduce((sum, draft) => sum + draft.width, 0) + gapX * Math.max(0, row.length - 1);
  const contentWidth = keys.reduce(
    (widest, key) => Math.max(widest, widthOfRow(rows.get(key) ?? [])),
    0,
  );

  const root = scope.root;
  const offsetX = pad + (root === undefined ? 0 : FRAME_PAD);
  const offsetY = pad + (root === undefined ? 0 : FRAME_PAD + FRAME_HEADER);
  for (const key of keys) {
    const row = rows.get(key) ?? [];
    // Each rank is centred on its own, so a single box below a wide rank sits in
    // the middle of the picture rather than at its left edge.
    let x = Math.round(offsetX + (contentWidth - widthOfRow(row)) / 2);
    const y = Math.round(offsetY + key * (boxHeight + gapY));
    for (const draft of row) {
      draft.x = x;
      draft.y = y;
      x += draft.width + gapX;
    }
  }

  const contentHeight =
    keys.length === 0 ? 0 : (keys[keys.length - 1] ?? 0) * (boxHeight + gapY) + boxHeight;
  const extra = root === undefined ? 0 : FRAME_PAD;
  const width = Math.ceil(offsetX + contentWidth + pad + extra);
  const height = Math.ceil(offsetY + contentHeight + pad + extra);

  const frame: LayoutFrame | undefined =
    root === undefined
      ? undefined
      : {
          id: root,
          label: labelOf(root),
          x: pad / 2,
          y: pad / 2,
          width: width - pad,
          height: height - pad,
        };

  const forward = (from: Draft, to: Draft): Point[] => {
    const a = { x: centerX(from), y: from.y + from.height };
    const b = { x: centerX(to), y: to.y };
    // Down out of the box, across, down into the next one: an elbow reads better
    // than a diagonal when a dozen arrows share the gap.
    const midY = Math.round((a.y + b.y) / 2);
    return simplify([a, { x: a.x, y: midY }, { x: b.x, y: midY }, b]);
  };

  const back = (from: Draft, to: Draft): Point[] => {
    const a = { x: from.x, y: centerY(from) };
    const b = { x: to.x, y: centerY(to) };
    const out = Math.max(2, Math.round(Math.min(from.x, to.x) - BACK_OUT));
    return simplify([a, { x: out, y: a.y }, { x: out, y: b.y }, b]);
  };

  const loop = (box: Draft): Point[] => {
    const right = box.x + box.width;
    const cy = centerY(box);
    const out = right + LOOP_OUT;
    return [
      { x: right, y: cy - LOOP_HALF },
      { x: out, y: cy - LOOP_HALF },
      { x: out, y: cy + LOOP_HALF },
      { x: right, y: cy + LOOP_HALF },
    ];
  };

  const cross = (from: Draft | undefined, to: Draft | undefined): Point[] => {
    if (frame === undefined) return [];
    const frameTop = frame.y;
    const frameBottom = frame.y + frame.height;
    if (from !== undefined) {
      // Leaving the scope: the arrow stops at the frame it leaves, which is what
      // a stub is. The reader can open the frame to see where it goes.
      return [
        { x: centerX(from), y: from.y + from.height },
        { x: centerX(from), y: frameBottom },
      ];
    }
    if (to !== undefined) {
      // Coming in from outside: out of the frame, into the box.
      return [
        { x: centerX(to), y: frameTop },
        { x: centerX(to), y: to.y },
      ];
    }
    // Neither end is at this level. One stub at the frame's top says so, drawn
    // inwards: outwards it would fall outside the canvas and be clipped.
    const cx = frame.x + frame.width / 2;
    return [
      { x: cx, y: frameTop },
      { x: cx, y: frameTop + FRAME_PAD },
    ];
  };

  const route = (edge: ScopeEdge): LayoutEdge => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    let kind: EdgeKind;
    let path: Point[];
    if (from === undefined || to === undefined) {
      kind = 'cross';
      path = cross(from, to);
    } else if (from === to) {
      kind = 'self';
      path = loop(from);
    } else if ((rank.get(to.id) ?? 0) > (rank.get(from.id) ?? 0)) {
      kind = 'forward';
      path = forward(from, to);
    } else {
      kind = 'back';
      path = back(from, to);
    }
    return {
      relation: edge.relation,
      from: edge.from,
      to: edge.to,
      kind,
      count: edge.count,
      members: edge.members,
      crosses: edge.crosses,
      path,
      // A loop's middle is on the loop itself; put the count beside it instead.
      label: kind === 'self' ? loopLabel(path) : midpoint(path),
    };
  };

  return {
    frame,
    boxes: drafts,
    edges: scope.edges.map(route),
    width,
    height,
    issues: scope.issues,
  };
}

/**
 * Ranks by longest path: a box sits below everything it points at.
 *
 * `depends-on` may cycle and the checker says so; this still has to return. The
 * cap is the number of boxes, so no rank can grow without bound, and the edges
 * that would have lifted a rank further end up pointing uphill -- which is
 * exactly what a `back` edge is for.
 */
function ranksOf(drafts: readonly Draft[], edges: readonly ScopeEdge[]): Map<Id, number> {
  const rank = new Map<Id, number>(drafts.map((draft) => [draft.id, 0]));
  const top = drafts.length - 1;
  for (let pass = 0; pass < drafts.length; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      if (edge.from === edge.to) continue;
      const from = rank.get(edge.from);
      const to = rank.get(edge.to);
      if (from === undefined || to === undefined) continue;
      if (to < from + 1 && from + 1 <= top) {
        rank.set(edge.to, from + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return rank;
}

/** The middle of the longest leg -- where a label is least in the way. */
function midpoint(path: readonly Point[]): Point {
  let widest = -1;
  let at: Point = { x: 0, y: 0 };
  let prev: Point | undefined;
  for (const point of path) {
    if (prev !== undefined) {
      const length = Math.abs(point.x - prev.x) + Math.abs(point.y - prev.y);
      if (length > widest) {
        widest = length;
        at = { x: Math.round((prev.x + point.x) / 2), y: Math.round((prev.y + point.y) / 2) };
      }
    }
    prev = point;
  }
  return at;
}

/**
 * Beside the loop's right leg, halfway down: the one place near a loop where a
 * count is not written on top of an arrow.
 */
function loopLabel(path: readonly Point[]): Point {
  if (path.length === 0) return { x: 0, y: 0 };
  const xs = path.map((point) => point.x);
  const ys = path.map((point) => point.y);
  return {
    x: Math.max(...xs) + 6,
    y: Math.round((Math.min(...ys) + Math.max(...ys)) / 2),
  };
}

/**
 * Drops points that repeat or that sit in the middle of a straight run, so a leg
 * that goes straight down is two points and not four. A renderer gets a polyline,
 * not the arithmetic that produced it.
 */
function simplify(points: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const point of points) {
    const last = out.at(-1);
    if (last === undefined) {
      out.push(point);
      continue;
    }
    if (last.x === point.x && last.y === point.y) continue;
    const before = out.at(-2);
    if (before !== undefined && straight(before, last, point)) out.pop();
    out.push(point);
  }
  return out;
}

/** Whether the middle point adds nothing: all three share an x or all three a y. */
function straight(a: Point, b: Point, c: Point): boolean {
  return (a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y);
}

function centerX(box: Draft): number {
  return box.x + box.width / 2;
}

function centerY(box: Draft): number {
  return box.y + box.height / 2;
}

function even(value: number): number {
  const rounded = Math.round(value);
  return rounded % 2 === 0 ? rounded : rounded + 1;
}
