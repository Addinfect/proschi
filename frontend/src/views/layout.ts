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
 * The space between two ranks is where the arrows live, and every horizontal leg runs
 * in one. A leg along a rank would pass through the boxes standing in it, and a line
 * drawn through a box is a claim about that box. So an arrow that has to cross two
 * ranks leaves the boxes and comes back in. Where its vertical leg runs is the one
 * question this file answers with a grid rather than a rule of thumb; see `columnX`.
 *
 * The order of the boxes within a rank is the model's, until the model's order costs a
 * crossing no route could avoid: two arrows whose ends stand in opposite order have to
 * cross wherever they run. Only then are two neighbours swapped, and only while the
 * swap pays for itself.
 *
 * Nothing here invents content. There is no node without a box, no box without a node,
 * and no order other than one the model already allows.
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
 * - `forward` — one rank down, the ordinary case;
 * - `around` — further down than one rank, so it leaves the grid out of its bottom,
 *   travels beside the boxes it skips, and comes back in at the top;
 * - `back` — to a higher rank, so it goes up out of the top and back in at the
 *   bottom of the other;
 * - `self` — both ends on one box, a loop on its right edge;
 * - `cross` — an end lies outside the scope, so it runs through the frame's wall
 *   and stops outside it.
 */
export type EdgeKind = 'forward' | 'around' | 'back' | 'self' | 'cross';

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
/** How far a self loop reaches outside its box. */
const LOOP_OUT = 20;
const LOOP_HALF = 8;
/**
 * How far apart two lanes stand.
 *
 * An arrow that cannot cross a single gap -- a back edge, or a forward one that skips
 * a rank -- needs a vertical leg of its own, and every one of them wants the gap beside
 * the box it enters. Two on one line would read as one arrow, which is the same lie as
 * two on one lane, so they stand a step apart and the gap grows to seat them.
 */
const MARGIN_STEP = 16;
/** How far off a box a detour runs while it turns, when no lane seats it. */
const TURN_IN = 16;

/** A side of a box an arrow can arrive at or leave from. Horizontals run in gaps. */
type Side = 'top' | 'bottom';

/** Which of the two lanes in one gap an arrow sits in. */
type Lane = 'out' | 'in';

/** One place in a gap's order, held until the gap has been measured. */
interface Seat {
  readonly index: number;
  readonly end: Lane;
}

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
    const climb = (rank.get(to.id) ?? 0) - (rank.get(from.id) ?? 0);
    if (climb === 1) return 'forward';
    // Down two ranks or more is not one elbow: the vertical would run through every
    // box in the ranks it skips, and a line through a box is a claim about it.
    if (climb > 1) return 'around';
    return 'back';
  });

  // Every arrow that leaves the grid, shortest span first. Where each one travels is
  // decided later, once the boxes have positions; the order is fixed here because it
  // decides who gets the channel nearest the boxes. That is a reading aid, not a
  // promise: two detours whose rank ranges overlap can still cross each other.
  const detours = scope.edges
    .map((edge, index) => ({
      index,
      span: Math.abs((rank.get(edge.to) ?? 0) - (rank.get(edge.from) ?? 0)),
    }))
    .filter(({ index }) => kinds[index] === 'back' || kinds[index] === 'around')
    .sort((left, right) => left.span - right.span || left.index - right.index);

  // One row per rank, in model order first, because that is the order anyone reading the
  // source will recognise; `orderRows` then takes a swap wherever it counts fewer
  // crossings. A rank that gains nothing keeps the model's order untouched.
  const rows = new Map<number, Draft[]>();
  for (const draft of drafts) {
    const key = rank.get(draft.id) ?? 0;
    const row = rows.get(key);
    if (row) row.push(draft);
    else rows.set(key, [draft]);
  }
  const keys = [...rows.keys()].sort((a, b) => a - b);
  orderRows(rows, keys, scope.edges, rank);
  // One grid of columns for the whole picture, shared by every rank. Not tidiness: it is
  // what makes a lane between two boxes possible at all. A rank centred on its own puts
  // its boxes wherever its own count leaves them, so the gap between two boxes of one
  // rank falls on a box of the next -- and a detour that needs a lane through both is
  // out of luck, which is why every detour used to travel outside all the boxes, also
  // outside its own destination. A shared column is free between the columns in every
  // rank at once, because no box ever leaves its column. The price is that a narrow rank
  // no longer sits in the middle: it hugs the left edge of its widest column.
  // Which column a box stands in is a reading of where its sources stand, not of how far
  // along its rank it happens to sit. The position put every rank of one box in column
  // zero -- a default rather than a decision -- so a sink fed from column one was dragged
  // across the picture to reach it, while the one box that could have run straight stood
  // at the wall. A box therefore wishes for the column most of its sources stand in; one
  // box, one vote, because two relations drawn between the same pair leave one place. A
  // tie is no verdict -- no column has a majority -- so such a box keeps its position, and
  // a rank the model leaves alone is not rearranged by two sources pulling apart.
  //
  // The order `orderRows` settled on is not up for negotiation: two boxes swapping places
  // to please their sources would pay for a crossing somewhere else. So the wishes are made
  // to climb -- a box whose column is taken moves one to the right -- and a rank may leave
  // a column empty rather than fold two boxes into one line. A box whose sources are not
  // placed yet keeps its position, so a rank the model leaves alone still reads as written.
  const sourcesOf = new Map<Id, Id[]>();
  for (const edge of scope.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    const into = sourcesOf.get(edge.to);
    if (into === undefined) sourcesOf.set(edge.to, [edge.from]);
    else if (!into.includes(edge.from)) into.push(edge.from);
  }
  const columnOf = new Map<string, number>();
  for (const key of keys) {
    const row = rows.get(key) ?? [];
    let last = -1;
    row.forEach((draft, at) => {
      // Strictly climbing, never equal: two boxes of one rank may not share a column, and
      // the order `orderRows` chose has to survive even when a source pulls a box left.
      const wanted = commonColumn(sourcesOf.get(draft.id) ?? [], columnOf);
      const column = Math.max(wanted ?? at, last + 1);
      columnOf.set(draft.id, column);
      last = column;
    });
  }
  // A rank that pushed a box to the right now stands wider than any rank is long.
  let columnCount = 0;
  for (const at of columnOf.values()) columnCount = Math.max(columnCount, at + 1);
  // A column is as wide as its widest box, so a narrow one leaves room on its right
  // instead of pushing its neighbours around.
  const columnWidth: number[] = [];
  for (const draft of drafts) {
    const at = columnOf.get(draft.id) ?? 0;
    columnWidth[at] = Math.max(columnWidth[at] ?? 0, draft.width);
  }
  const laneGap: number[] = [];
  // What a gap needs when no lane uses it: between two columns the boxes beside it have to
  // stand apart, which is `gapX`; at the two edges of the picture there are no two boxes
  // and the padding already is the air. Charging `gapX` there too would widen every
  // picture by two gaps for lanes that may never come.
  const airAt = (lane: number): number => (lane > 0 && lane < columnCount ? gapX : 0);
  for (let lane = 0; lane <= columnCount; lane += 1) laneGap.push(airAt(lane));
  /** Left edge of a column; the gap in front of it included, so the first is past the wall. */
  const columnX = (at: number): number => {
    let x = laneGap[0] ?? 0;
    for (let column = 0; column < at; column += 1) {
      x += (columnWidth[column] ?? 0) + (laneGap[column + 1] ?? 0);
    }
    return x;
  };
  const contentExtent = (): number => {
    const last = columnCount - 1;
    if (last < 0) return 0;
    return columnX(last) + (columnWidth[last] ?? 0) + (laneGap[columnCount] ?? 0);
  };

  // Arrows that cross one gap used to run along one horizontal line, with their
  // labels written on top of each other. Each one gets its own lane now, seated by
  // where it lands, so a fan reads as a fan and every count has room.
  // An `around` arrow runs through two gaps -- the one below the box it leaves and
  // the one above the box it enters -- so it is seated in both. A `back` arrow runs
  // through the one above its own rank and the one below the rank it enters.
  const laneOrder = new Map<number, Seat[]>();
  const seat = (key: number, index: number, end: Lane): void => {
    if (rows.has(key)) push(laneOrder, key, { index, end });
  };
  scope.edges.forEach((edge, index) => {
    const kind = kinds[index];
    const from = rank.get(edge.from);
    const to = rank.get(edge.to);
    if (from === undefined || to === undefined) return;
    if (kind === 'forward') seat(from, index, 'out');
    else if (kind === 'around') {
      seat(from, index, 'out');
      seat(to - 1, index, 'in');
    } else if (kind === 'back') {
      // It climbs, so it leaves through the gap above its own box -- the one below the
      // rank it climbs out of. In the top rank there is no such gap.
      seat(from > 0 ? from - 1 : from, index, 'out');
      seat(to, index, 'in');
    }
  });
  const root = scope.root;
  const framed = root !== undefined;
  // Inside a frame the boxes start past the wall, the header and the frame's own
  // padding; outside one, the canvas padding is all there is. Sideways too: the lanes
  // live inside the grid now, so the first gap is already wide enough for them and
  // nothing has to be shifted right after the fact.
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
  // Where a detour's lane goes, and why this is not the coin toss it used to be: the
  // lane belongs in the gap beside the box it enters. The leg that leaves the source is
  // long wherever the lane stands -- it has to cross the picture either way. The entry
  // leg is the one that pays for the lane's position, because it crosses every lane
  // standing between it and its anchor; and n lanes on one side of one anchor cost
  // n*(n-1)/2 crossings, whatever order they stand in, because for any pair of them one
  // lane lies between the other and the anchor. Split them over the two gaps and the
  // same n cost m*(m-1)/2 + k*(k-1)/2, with m + k = n: at six, six instead of fifteen.
  const laneOf = new Map<number, number>();
  const laneSeat = new Map<number, number>();
  const laneUse: number[] = new Array<number>(columnCount + 1).fill(0);
  const groups = new Map<string, number[]>();
  for (const { index } of detours) {
    const edge = scope.edges[index];
    // Keyed by the side it enters, because two detours into the same box share the
    // anchors of one side, and only those.
    push(groups, `${edge.to}:${kinds[index] === 'back' ? 'bottom' : 'top'}`, index);
  }
  // Same order the anchors are seated in further down, and for the same reason: what
  // counts is where the other end stands, not where this one does.
  const near = (index: number): number => {
    const from = byId.get(scope.edges[index].from);
    if (from === undefined) return 0;
    return columnX(columnOf.get(from.id) ?? 0) + from.width / 2;
  };
  /**
   * How deep the arrow lands: the one measure that separates two ends that stand in one
   * column. Not how far it travels. Two arrows out of different ranks can skip the same
   * number of rows and still enter at different heights, and the gaps between the ranks
   * are not equally tall -- so a travel distance compares two starts as if where they
   * started were the same question. What decides a crossing is the entry line: the outer
   * channel's arrow runs across it, and it only meets the channels standing inside.
   *
   * Read from the rank's height, not from the box: the boxes are placed further down, so
   * their `y` still holds the initial value here -- and a measure that comes out equal for
   * every arrow sorts nothing at all, which is exactly what it did until now.
   */
  const entryLine = (index: number): number => {
    const to = rank.get(scope.edges[index].to);
    return to === undefined ? offsetY : (place.get(to) ?? offsetY);
  };
  // Which gap a detour picks is a question about columns. Which seat it gets *inside*
  // that gap is what puts one channel outside another, and that decides crossings --
  // two detours into two boxes that stand in one column share a gap, and until now
  // their seats fell out of the order the source happens to declare them in.
  const berths: { lane: number; index: number; outward: number }[] = [];
  for (const members of groups.values()) {
    members.sort((left, right) => near(left) - near(right));
    members.forEach((index, at) => {
      const to = byId.get(scope.edges[index].to);
      if (to === undefined) return;
      const column = columnOf.get(to.id) ?? 0;
      // The side follows where the arrow comes from, not which half of the group it fell
      // in. A source standing left of its target has nothing to gain from the right gap:
      // it would have to march across the target's whole column first, and the crossing
      // budget below does not count that march -- it only counts the lanes at the anchor.
      // Splitting is only a choice when the sources share one column, because then no side
      // is cheaper; that is the case the halving was written for. The exact seat inside
      // the box would need the anchors, and those are seated further down; but they are
      // seated in this same order, so `at` is still the right split of the anchors.
      const source = columnOf.get(scope.edges[index].from) ?? 0;
      const onLeft = source < column || (source === column && at * 2 < members.length);
      // Both gaps grow away from the columns they flank, so the outer seat is the lowest
      // one on the left and the highest one on the right.
      berths.push({
        lane: onLeft ? column : column + 1,
        index,
        outward: onLeft ? -entryLine(index) : entryLine(index),
      });
    });
  }
  // The outer seat goes to the arrow that lands deepest. Every channel inside it has
  // already come to rest above that entry line, so the outer one turns in without
  // crossing anything. A left gap grows away from its columns with every seat, a right
  // one towards them -- hence the sign.
  berths.sort((left, right) => left.lane - right.lane || left.outward - right.outward);
  for (const berth of berths) {
    const seat = laneUse[berth.lane] ?? 0;
    laneUse[berth.lane] = seat + 1;
    laneOf.set(berth.index, berth.lane);
    laneSeat.set(berth.index, seat);
  }
  for (let lane = 0; lane < laneGap.length; lane += 1) {
    // A step of clearance to the box on either side, so a lane never rubs against one.
    // An unused gap keeps its floor -- and a gap at the edge of the picture has none.
    const used = laneUse[lane] ?? 0;
    laneGap[lane] = Math.max(airAt(lane), used === 0 ? 0 : MARGIN_STEP * (used + 1));
  }
  // Every box stands on its column now, with the gaps the lanes asked for. Two passes,
  // because a gap's width decides where the next column starts: the lanes pick their
  // side first -- which is a question about columns, not about pixels -- and the pixels
  // follow once.
  for (const key of keys) {
    const y = place.get(key) ?? offsetY;
    for (const draft of rows.get(key) ?? []) {
      draft.x = offsetX + columnX(columnOf.get(draft.id) ?? 0);
      draft.y = y;
    }
  }
  const contentWidth = contentExtent();

  // Lanes within one gap run against each other: an arrow that leaves a box runs down
  // from the box and stops on its lane, one that enters the box below starts on its lane
  // and runs on down. Interleaved, every incoming vertical crosses every outgoing lane
  // beneath it, so the two groups stay apart. Which one goes on top follows from where
  // they end: the outgoing lane sits just under its box, so its leg is short there, and
  // the incoming lane sits just above the rank it enters, so its leg is short at the
  // bottom. Outgoing above, incoming below -- then no leg of one group reaches a lane of
  // the other.
  // Within a group the order is where the other end stands, left to right, which is the
  // measure the anchors use further down too. A seat inside the row would not do: it says
  // where a box stands in *its own* rank, so two arrows into two different ranks would be
  // compared as if that number were a place in the picture -- and a box in the middle of a
  // narrow rank would sort as far left as one at the edge of a wide rank.
  // A detour takes the outer edge of the whole run, at either end. Its leg does not stop
  // on the lane but runs on across the gap, so it must not sit among legs that end there.
  const farX = (index: number): number => {
    const edge = scope.edges[index];
    const far = edge === undefined ? undefined : byId.get(edge.to);
    return far === undefined ? 0 : far.x + far.width / 2;
  };
  const group = (index: number, lane: Lane): number => {
    const kind = kinds[index];
    const detour = kind === 'around' || kind === 'back';
    if (lane === 'out') return detour ? 0 : 1;
    return detour ? 3 : 2;
  };
  for (const seats of laneOrder.values()) {
    seats.sort(
      (left, right) =>
        group(left.index, left.end) - group(right.index, right.end) ||
        farX(left.index) - farX(right.index),
    );
  }

  // A lane sits in the gap below a rank, one per arrow, half a lane clear of either
  // end. A detour has one at each end of its travel: the gap it dives into, and the
  // gap it comes back through.
  const laneOut = new Map<number, number>();
  const laneIn = new Map<number, number>();
  for (const [key, seats] of laneOrder) {
    const bottom = (place.get(key) ?? offsetY) + boxHeight;
    const gap = gaps.get(key) ?? gapY;
    seats.forEach((seat, at) => {
      const y = Math.round(bottom + (gap * (at + 1)) / (seats.length + 1));
      (seat.end === 'out' ? laneOut : laneIn).set(seat.index, y);
    });
  }

  // The two horizontal lines a detour runs on: the one it leaves its box by, and the
  // one it comes back in on. Written down once, because two readers need them -- the
  // path, and the question of which boxes its vertical leg really passes.
  const lines = new Map<number, { leave: number; land: number }>();
  for (const { index } of detours) {
    const from = byId.get(scope.edges[index].from);
    const to = byId.get(scope.edges[index].to);
    if (from === undefined || to === undefined) continue;
    if (kinds[index] === 'around') {
      lines.set(index, {
        leave: laneOut.get(index) ?? Math.round(from.y + from.height + gapY / 2),
        land: laneIn.get(index) ?? Math.round(to.y - TURN_IN),
      });
    } else {
      // A back edge climbs, so it leaves past the top of its box -- unless the box is
      // in the top rank, where there is no gap above it.
      const climbs = (rank.get(from.id) ?? 0) > 0;
      const edge = climbs ? from.y : from.y + from.height;
      lines.set(index, {
        leave: laneOut.get(index) ?? Math.round(climbs ? edge - TURN_IN : edge + TURN_IN),
        land: laneIn.get(index) ?? Math.round(to.y + to.height + gapY / 2),
      });
    }
  }

  /** The lane a detour travels in: in the gap beside the box it enters, a step off it. */
  const channelX = (index: number): number => {
    const lane = laneOf.get(index);
    if (lane === undefined) return offsetX;
    const seat = laneSeat.get(index) ?? 0;
    // Counted from the left edge of the gap, so the lanes of one gap stand in the order
    // they were seated and the last one keeps a step of clearance to the box beside it.
    return offsetX + columnX(lane) - (laneGap[lane] ?? gapX) + MARGIN_STEP * (seat + 1);
  };

  const lastRow = keys.at(-1);
  const contentHeight =
    lastRow === undefined ? 0 : (place.get(lastRow) ?? offsetY) + boxHeight - offsetY;
  // Past the last box: the frame's own padding, then the wall, then the room a
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
  // The order along that side is the order of the far ends, not the order the source
  // declares them in: two arrows out of one box onto two targets that stand the other
  // way round cross right behind the box, and no route can separate them there.
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
    if (kind === 'forward' || kind === 'around') {
      addSlot(index, 'from', 'bottom');
      addSlot(index, 'to', 'top');
    } else if (kind === 'back') {
      // Up out of the top and back in at the bottom, so its horizontals run in gaps
      // and not through the boxes standing beside it in its own rank.
      addSlot(index, 'from', (rank.get(edge.from) ?? 0) > 0 ? 'top' : 'bottom');
      addSlot(index, 'to', 'bottom');
    } else if (kind === 'cross') {
      // The end outside this level is the root's id, which is no box here.
      if (byId.has(edge.from)) addSlot(index, 'from', 'bottom');
      else if (byId.has(edge.to)) addSlot(index, 'to', 'top');
    }
  });
  for (const side of sides.values()) {
    // Where the other end stands, which is what the anchor has to line up with. An end
    // outside this level has no place to line up with, so it takes the last anchor of
    // the side rather than shoving an arrow that does land out of line.
    const beyond = Number.POSITIVE_INFINITY;
    const farEnd = new Map<Attachment, number>();
    const travel = new Map<Attachment, number>();
    for (const slot of side) {
      const far = byId.get(slot.end === 'from' ? slot.edge.to : slot.edge.from);
      const here = byId.get(slot.end === 'from' ? slot.edge.from : slot.edge.to);
      farEnd.set(slot, far === undefined ? beyond : far.x + far.width / 2);
      travel.set(slot, far === undefined || here === undefined ? 0 : Math.abs(far.y - here.y));
    }
    // Where the far ends line up the far centre says nothing: three arrows into three
    // boxes that stand in one column all land on one x, and a plain sort would then let
    // the order the model declares them in decide where each arrow leaves its box. The
    // tie goes to the arrow with the longer run -- it takes the outer seat, so its leg
    // clears the shorter ones' turns instead of crossing them.
    const ordered = [...side].sort(
      (left, right) =>
        (farEnd.get(left) ?? 0) - (farEnd.get(right) ?? 0) ||
        (travel.get(right) ?? 0) - (travel.get(left) ?? 0),
    );
    ordered.forEach((slot, i) => {
      const box = byId.get(slot.end === 'from' ? slot.edge.from : slot.edge.to);
      if (box === undefined) return;
      const along = (i + 1) / (ordered.length + 1);
      slot.at = Math.round(box.x + box.width * along);
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

  /**
   * An arrow that skips a rank. Its vertical cannot run down at the x it lands on:
   * that is where the boxes of the ranks in between are. So it dives into the gap
   * below its box, crosses to its lane beside the box it enters, comes down there --
   * past every rank it skips -- and turns in through the gap above that box.
   */
  const around = (from: Draft, to: Draft, leave: number, land: number, index: number): Point[] => {
    const line = lines.get(index);
    const down = line?.leave ?? Math.round(from.y + from.height + gapY / 2);
    const turn = line?.land ?? Math.round(to.y - TURN_IN);
    const out = channelX(index);
    return simplify([
      { x: leave, y: from.y + from.height },
      { x: leave, y: down },
      { x: out, y: down },
      { x: out, y: turn },
      { x: land, y: turn },
      { x: land, y: to.y },
    ]);
  };

  /**
   * An arrow to a higher rank. It cannot leave its box sideways: that horizontal would
   * lie inside its own rank and pass through every box standing beside it. So it goes
   * out of the top, crosses sideways inside the gap above its own rank to the lane
   * beside the box it points at, climbs, and comes back into the bottom of that box --
   * which is the direction it points.
   */
  const back = (
    from: Draft,
    to: Draft,
    leave: number,
    land: number,
    index: number,
    climbs: boolean,
  ): Point[] => {
    const line = lines.get(index);
    const a = { x: leave, y: climbs ? from.y : from.y + from.height };
    const b = { x: land, y: to.y + to.height };
    const up = line?.leave ?? Math.round(climbs ? a.y - TURN_IN : a.y + TURN_IN);
    const into = line?.land ?? Math.round(b.y + gapY / 2);
    const out = channelX(index);
    return simplify([
      a,
      { x: a.x, y: up },
      { x: out, y: up },
      { x: out, y: into },
      { x: b.x, y: into },
      b,
    ]);
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
        path = forward(from, to, leave ?? centerX(from), land ?? centerX(to), laneOut.get(index));
      } else if (kind === 'around') {
        path = around(from, to, leave ?? centerX(from), land ?? centerX(to), index);
      } else {
        path = back(
          from,
          to,
          leave ?? centerX(from),
          land ?? centerX(to),
          index,
          ends[index].from?.side === 'top',
        );
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
 * Sorts every rank into an order that crosses less than the model's, and leaves a rank
 * alone when its own order is already as good.
 *
 * Two arrows between two neighbouring ranks cross when their two ends stand in opposite
 * order: one leaves further left and lands further right. That is not a routing fault --
 * wherever the two are drawn they have to cross -- so the only fix is the order of the
 * boxes themselves. The order tried first is the model's, because that is the one anyone
 * reading the source recognises, and every step below has to count fewer crossings to be
 * kept. Nothing here is moved for looking better.
 *
 * The count only sees arrows between neighbouring ranks. An arrow that skips a rank
 * leaves the grid to do it, so its crossings are the router's business -- until it gets a
 * place of its own in the rows it passes, which is a later step. Two arrows out of one box
 * count as no crossing here, and that is only true because an anchor is placed by where the
 * far end stands: a fan that left in the source's order would cross behind its own box.
 */
function orderRows(
  rows: Map<number, Draft[]>,
  keys: readonly number[],
  edges: readonly ScopeEdge[],
  rank: ReadonlyMap<Id, number>,
): void {
  /** The arrows the grid draws: one rank down, so both their ends stand in a row. */
  const links: { readonly from: Id; readonly to: Id; readonly upper: number }[] = [];
  for (const edge of edges) {
    const upper = rank.get(edge.from);
    const lower = rank.get(edge.to);
    if (upper === undefined || lower === undefined || lower - upper !== 1) continue;
    links.push({ from: edge.from, to: edge.to, upper });
  }
  if (links.length === 0) return;

  /** Where each box stands in its row, kept true through every swap below. */
  const place = new Map<Id, number>();
  const reseat = (): void => {
    for (const key of keys) {
      (rows.get(key) ?? []).forEach((draft, index) => place.set(draft.id, index));
    }
  };
  reseat();

  /** How many arrow pairs trade sides between `upper` and the rank below it. */
  const crossingBelow = (upper: number): number => {
    const here = links.filter((link) => link.upper === upper);
    let count = 0;
    here.forEach((one, at) => {
      for (let further = at + 1; further < here.length; further += 1) {
        const two = here[further];
        if (two === undefined) continue;
        const lefts = (place.get(one.from) ?? 0) - (place.get(two.from) ?? 0);
        const rights = (place.get(one.to) ?? 0) - (place.get(two.to) ?? 0);
        // Opposite ends, opposite order: these two have to cross.
        if (lefts * rights < 0) count += 1;
      }
    });
    return count;
  };

  /** Both sides of one rank: a box sits between two gaps, and both of them count. */
  const crossingAt = (key: number): number => crossingBelow(key - 1) + crossingBelow(key);

  /**
   * One rank ordered by the mean place of its neighbours in the rank above or below. A
   * box with no arrow to that rank keeps the place it has, so a rank nothing points at
   * does not shuffle for nothing.
   */
  const sortByNeighbours = (key: number, reference: number): void => {
    const row = rows.get(key);
    if (row === undefined || row.length < 2) return;
    const sum = new Map<Id, number>();
    const many = new Map<Id, number>();
    for (const link of links) {
      let here: Id | undefined;
      let there: Id | undefined;
      if (rank.get(link.from) === key) {
        here = link.from;
        there = link.to;
      } else if (rank.get(link.to) === key) {
        here = link.to;
        there = link.from;
      }
      if (here === undefined || there === undefined || rank.get(there) !== reference) continue;
      const at = place.get(there);
      if (at === undefined) continue;
      sum.set(here, (sum.get(here) ?? 0) + at);
      many.set(here, (many.get(here) ?? 0) + 1);
    }
    // Read into its own map before sorting: the comparator must not look at a map the
    // sort is itself changing.
    const wanted = new Map<Id, number>(
      row.map((draft) => {
        const count = many.get(draft.id) ?? 0;
        const mean = count === 0 ? place.get(draft.id) ?? 0 : (sum.get(draft.id) ?? 0) / count;
        return [draft.id, mean] as const;
      }),
    );
    row.sort((left, right) => (wanted.get(left.id) ?? 0) - (wanted.get(right.id) ?? 0));
    reseat();
  };

  /** Neighbours swapped while a swap pays: a mean can be right for the wrong reason. */
  const untangle = (key: number): void => {
    const row = rows.get(key);
    if (row === undefined || row.length < 2) return;
    for (let pass = 0; pass < 4; pass += 1) {
      let swapped = false;
      for (let at = 0; at + 1 < row.length; at += 1) {
        const left = row[at];
        const right = row[at + 1];
        if (left === undefined || right === undefined) continue;
        const before = crossingAt(key);
        row[at] = right;
        row[at + 1] = left;
        reseat();
        if (crossingAt(key) < before) swapped = true;
        else {
          row[at] = left;
          row[at + 1] = right;
          reseat();
        }
      }
      if (!swapped) return;
    }
  };

  // Down, then up, four times: each sweep orders one rank against a neighbour that is
  // already settled, and the next sweep has one more rank to read. More rounds cost the
  // same and stop changing anything.
  for (let round = 0; round < 4; round += 1) {
    for (const key of keys) sortByNeighbours(key, key - 1);
    for (const key of [...keys].reverse()) sortByNeighbours(key, key + 1);
    for (const key of keys) untangle(key);
  }
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

/**
 * The column a majority of a box's sources stand in, or `undefined` when no column has one.
 *
 * The ranks are walked from the top, so a box reading this sees every arrow that enters it
 * from above and none from below -- which is why a box with no such source has to fall back
 * on its position in the rank instead of inventing a column.
 *
 * A majority and not a middle: the sources of one box need not agree, and a middle value
 * would then move a box whose sources are spread evenly, rearranging a rank on no evidence.
 * Two sources standing in two columns say nothing about where the box belongs.
 */
function commonColumn(
  sources: readonly Id[],
  columnOf: ReadonlyMap<string, number>,
): number | undefined {
  const counted: number[] = [];
  for (const source of sources) {
    const at = columnOf.get(source);
    if (at === undefined) continue;
    counted[at] = (counted[at] ?? 0) + 1;
  }
  let best: number | undefined;
  let most = 0;
  let tied = false;
  counted.forEach((count, column) => {
    if (count > most) {
      best = column;
      most = count;
      tied = false;
    } else if (count === most) tied = true;
  });
  // A tie is no verdict: no column has a majority, so the box stays where its rank put it
  // rather than picking a side the picture could not defend.
  return tied ? undefined : best;
}
