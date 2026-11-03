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
 * - `cross` — an end lies outside the scope, so it runs through the frame's wall
 *   and stops outside it.
 */
export type EdgeKind = 'forward' | 'back' | 'self' | 'cross';

/** An edge from a scope, routed. `path` is a polyline; the last point is where it ends. */
export interface LayoutEdge {
  readonly relation: string;
  readonly from: Id;
  readonly to: Id;
  readonly kind: EdgeKind;
  readonly count: number;
  readonly members: readonly Id[];
  readonly crosses: boolean;
  /**
   * Whether the path ends on a box. An arrow that leaves the scope has nothing to
   * point at out there, so it draws no head: a point on the wall would say the
   * wall is the destination, and it is not.
   */
  readonly head: boolean;
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
/**
 * How much canvas is left outside the frame. An arrow that leaves the scope has to
 * be seen crossing the wall, so the picture is wider than the frame by this much.
 */
const FRAME_INSET = 28;
/** How far past the wall a crossing runs -- and how far a wall only tick reaches in. */
const CROSS_OUT = 22;
const CROSS_IN = 8;
/**
 * The least space between two arrows that share a gap: one line of their label, and
 * a little air. A gap grows to this when more arrows cross it than the default one
 * can seat.
 */
const LANE_STEP = 16;
/** How far a self loop and a back edge reach outside their box. */
const LOOP_OUT = 20;
const LOOP_HALF = 8;
const BACK_OUT = 16;

/** A side of a box an arrow can arrive at or leave from. */
type Side = 'top' | 'bottom' | 'left';

/** One end of one arrow, and the anchor it gets along the side it uses. */
interface Attachment {
  readonly edge: ScopeEdge;
  readonly end: 'from' | 'to';
  readonly side: Side;
  /** Where along the side it sits, filled in once every arrow on that side is known. */
  at: number;
}

/** The two ends of one arrow, if they land on boxes at this level. */
interface Ends {
  from?: Attachment;
  to?: Attachment;
}

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

  // How every arrow is routed, read off the ranks alone: downhill, back around, in a
  // loop, or out through the wall. Known before a box has a position, because the
  // lanes and the anchors are both computed from it.
  const kinds = scope.edges.map((edge): EdgeKind => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from === undefined || to === undefined) return 'cross';
    if (from === to) return 'self';
    return (rank.get(to.id) ?? 0) > (rank.get(from.id) ?? 0) ? 'forward' : 'back';
  });

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

  // Arrows that cross one gap used to run along one horizontal line, with their
  // labels written on top of each other. Each one gets its own lane now, seated by
  // where it lands, so a fan reads as a fan and every count has room.
  const laneOrder = new Map<number, number[]>();
  scope.edges.forEach((edge, index) => {
    if (kinds[index] !== 'forward') return;
    push(laneOrder, rank.get(edge.from) ?? 0, index);
  });
  const modelIndex = new Map<Id, number>(drafts.map((draft, index) => [draft.id, index]));
  for (const seats of laneOrder.values()) {
    seats.sort(
      (left, right) =>
        (modelIndex.get(scope.edges[left].to) ?? 0) - (modelIndex.get(scope.edges[right].to) ?? 0),
    );
  }

  const root = scope.root;
  const framed = root !== undefined;
  // Inside a frame the boxes start past the wall, the header and the frame's own
  // padding; outside one, the canvas padding is all there is.
  const offsetX = framed ? FRAME_INSET + FRAME_PAD : pad;
  const offsetY = framed ? FRAME_INSET + FRAME_PAD + FRAME_HEADER : pad;
  // Rows are stacked with a gap each, and a gap widens when the arrows crossing it
  // need more room than the default one has.
  const place = new Map<number, number>();
  const gaps = new Map<number, number>();
  let top = offsetY;
  for (const key of keys) {
    place.set(key, top);
    const arrows = laneOrder.get(key)?.length ?? 0;
    const gap = Math.max(gapY, LANE_STEP * (arrows + 1));
    gaps.set(key, gap);
    top += boxHeight + gap;
  }
  for (const key of keys) {
    const row = rows.get(key) ?? [];
    // Each rank is centred on its own, so a single box below a wide rank sits in
    // the middle of the picture rather than at its left edge.
    let x = Math.round(offsetX + (contentWidth - widthOfRow(row)) / 2);
    const y = place.get(key) ?? offsetY;
    for (const draft of row) {
      draft.x = x;
      draft.y = y;
      x += draft.width + gapX;
    }
  }

  // A lane sits between the two ranks, one per arrow, half a lane clear of either.
  const lanes = new Map<number, number>();
  for (const [key, seats] of laneOrder) {
    const bottom = (place.get(key) ?? offsetY) + boxHeight;
    const gap = gaps.get(key) ?? gapY;
    seats.forEach((index, seat) => {
      lanes.set(index, Math.round(bottom + (gap * (seat + 1)) / (seats.length + 1)));
    });
  }

  const lastRow = keys.at(-1);
  const contentHeight =
    lastRow === undefined ? 0 : (place.get(lastRow) ?? offsetY) + boxHeight - offsetY;
  // Past the last box: the frame's own padding, then the wall, then the margin a
  // crossing needs to be visible outside it.
  const beyond = framed ? FRAME_PAD + FRAME_INSET : pad;
  const width = Math.ceil(offsetX + contentWidth + beyond);
  const height = Math.ceil(offsetY + contentHeight + beyond);

  const frame: LayoutFrame | undefined =
    root === undefined
      ? undefined
      : {
          id: root,
          label: labelOf(root),
          x: FRAME_INSET,
          y: FRAME_INSET,
          width: width - 2 * FRAME_INSET,
          height: height - 2 * FRAME_INSET,
        };

  // Where each arrow touches a box. Two relations out of one box used to start on
  // the same pixel and read as a single line that forks; each arrow now gets its
  // own anchor, spread evenly along the side it leaves or lands on.
  const ends = scope.edges.map((): Ends => ({}));
  const sides = new Map<string, Attachment[]>();
  const addSlot = (index: number, end: 'from' | 'to', side: Side): void => {
    const edge = scope.edges[index];
    const slot: Attachment = { edge, end, side, at: 0 };
    push(sides, `${end === 'from' ? edge.from : edge.to}:${side}`, slot);
    ends[index][end] = slot;
  };
  scope.edges.forEach((edge, index) => {
    const kind = kinds[index];
    if (kind === 'forward') {
      addSlot(index, 'from', 'bottom');
      addSlot(index, 'to', 'top');
    } else if (kind === 'back') {
      addSlot(index, 'from', 'left');
      addSlot(index, 'to', 'left');
    } else if (kind === 'cross') {
      // The end outside this level is the root's id, which is no box here.
      if (byId.has(edge.from)) addSlot(index, 'from', 'bottom');
      else if (byId.has(edge.to)) addSlot(index, 'to', 'top');
    }
  });
  for (const side of sides.values()) {
    const n = side.length;
    side.forEach((slot, i) => {
      const box = byId.get(slot.end === 'from' ? slot.edge.from : slot.edge.to);
      if (box === undefined) return;
      const along = (i + 1) / (n + 1);
      slot.at =
        slot.side === 'left'
          ? Math.round(box.y + box.height * along)
          : Math.round(box.x + box.width * along);
    });
  }

  // An arrow with no end at this level has nothing to point at: a short tick
  // through the wall, spread along it so two of them do not land on each other.
  const wall = new Map<number, number>();
  if (frame !== undefined) {
    const through = scope.edges
      .map((_edge, index) => index)
      .filter((index) => kinds[index] === 'cross' && ends[index].from === undefined && ends[index].to === undefined);
    const step = frame.width / (through.length + 1);
    through.forEach((index, i) => {
      wall.set(index, Math.round(frame.x + step * (i + 1)));
    });
  }

  const forward = (from: Draft, to: Draft, leave: number, land: number, lane?: number): Point[] => {
    const a = { x: leave, y: from.y + from.height };
    const b = { x: land, y: to.y };
    // Down out of the box, across on its own lane, down into the next one: an elbow
    // reads better than a diagonal when a dozen arrows share the gap.
    const midY = lane ?? Math.round((a.y + b.y) / 2);
    return simplify([a, { x: a.x, y: midY }, { x: b.x, y: midY }, b]);
  };

  const back = (from: Draft, to: Draft, leave: number, land: number): Point[] => {
    const a = { x: from.x, y: leave };
    const b = { x: to.x, y: land };
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

  /**
   * An arrow with an end outside the scope. It runs *through* the wall instead of
   * stopping at it: the frame is a boundary, not a destination, and a tick that
   * ends on the boundary says the opposite. Only a box gets a head.
   */
  const crossing = (edge: ScopeEdge, index: number): { path: Point[]; head: boolean } => {
    if (frame === undefined) return { path: [], head: false };
    const top = frame.y;
    const bottom = frame.y + frame.height;
    const leaving = ends[index].from;
    const landing = ends[index].to;
    const out = byId.get(edge.from);
    const into = byId.get(edge.to);
    if (out !== undefined && leaving !== undefined) {
      // Out of the box, through the wall, and it ends outside: nothing to point at.
      return {
        path: [
          { x: leaving.at, y: out.y + out.height },
          { x: leaving.at, y: bottom + CROSS_OUT },
        ],
        head: false,
      };
    }
    if (into !== undefined && landing !== undefined) {
      // In from outside the wall and down onto a box: this one lands, so it points.
      return {
        path: [
          { x: landing.at, y: top - CROSS_OUT },
          { x: landing.at, y: into.y },
        ],
        head: true,
      };
    }
    const x = wall.get(index) ?? Math.round(frame.x + frame.width / 2);
    return { path: [{ x, y: top - CROSS_OUT }, { x, y: top + CROSS_IN }], head: false };
  };

  const route = (edge: ScopeEdge, index: number): LayoutEdge => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    const kind = kinds[index];
    let path: Point[] = [];
    let head = false;
    if (kind === 'cross') {
      const crossed = crossing(edge, index);
      path = crossed.path;
      head = crossed.head;
    } else if (from !== undefined && to !== undefined) {
      // Both ends are boxes, so the arrow always lands on one.
      head = true;
      const leave = ends[index].from?.at;
      const land = ends[index].to?.at;
      if (from === to) path = loop(from);
      else if (kind === 'forward') {
        path = forward(from, to, leave ?? centerX(from), land ?? centerX(to), lanes.get(index));
      } else {
        path = back(from, to, leave ?? centerY(from), land ?? centerY(to));
      }
    }
    return {
      relation: edge.relation,
      from: edge.from,
      to: edge.to,
      kind,
      head,
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

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
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
