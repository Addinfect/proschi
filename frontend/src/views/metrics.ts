import type { LayoutBox, Point, ScopeLayout } from './layout';

/**
 * How bad a drawing is, as numbers.
 *
 * "This picture is a mess" is not something a change can be argued with, and not
 * something a test can hold. The counts below are: each one names a single way a
 * drawing costs its reader. Each one can be lowered, argued about, and pinned before
 * and after a change, which is the difference between improving a picture and moving
 * it around.
 *
 * What is counted, and why exactly this:
 *
 * - `throughBox` -- an arrow drawn through a box says something about that box that
 *   the model does not say. There is no threshold here; the target is zero.
 * - `shared` -- two arrows on one line read as one arrow, and the reader loses one.
 * - `crossings` -- a crossing has to be traced by eye to know which line goes where.
 *   Lines that merely touch do not count: a corner is not a crossing.
 * - `crowding` -- two parallel lines closer than `TOGETHER` are one thick line at a
 *   glance, which is a shared line with extra steps.
 * - `bends` -- every corner is a place to lose the thread. A straight run through a
 *   gap costs nothing, however far it goes.
 * - `labelsOnBox` -- a label written over a box is a label nobody reads.
 * - `labelsTogether` -- two labels closer than `LABEL_REACH` read as one word.
 * - `diagonal` -- a leg that is neither vertical nor horizontal. The counts above are
 *   about right angles, so a diagonal leg is invisible to them; it is counted on its
 *   own, and anything but zero means the counts beside it are incomplete.
 * - `area` -- the canvas the drawing asks for. A picture can be clean and still be too
 *   big to hold in the head.
 *
 * Two thresholds are assumptions about eyes, not truths: `TOGETHER` and `LABEL_REACH`.
 * They are constants so that changing one assumption moves every number at once, and so
 * that a test can say which assumption it is testing.
 *
 * Nothing here is a promise about the model. A clean drawing of a confused model is
 * still a confused model; these numbers only say whether the drawing got in the way.
 */

/** Parallel lines closer than this many pixels read as a single line. */
const TOGETHER = 8;

/** Two labels closer than this, in both directions, read as a single label. */
const LABEL_REACH = 12;

/** What a drawing costs its reader. Every field is a count, except `area`. */
export interface LayoutMetrics {
  /** Legs whose line runs through the inside of a box. A leg along a wall is free. */
  readonly throughBox: number;
  /** Pairs of legs from different arrows that lie on one line and overlap. */
  readonly shared: number;
  /** Pairs of legs from different arrows that cross. Lines that touch are free. */
  readonly crossings: number;
  /** Pairs of parallel legs from different arrows too close to be told apart. */
  readonly crowding: number;
  /** Corners in all routes together. */
  readonly bends: number;
  /** Labels placed on top of a box. */
  readonly labelsOnBox: number;
  /** Pairs of labels too close to each other to be read as two. */
  readonly labelsTogether: number;
  /** Legs that are neither vertical nor horizontal, which the counts above cannot see. */
  readonly diagonal: number;
  /** The canvas the layout asks for, in square pixels. */
  readonly area: number;
}

/** Counts how the drawing in `layout` treats its reader. */
export function measure(layout: ScopeLayout): LayoutMetrics {
  const { legs, diagonal } = legsOf(layout);
  return {
    throughBox: countThroughBoxes(legs, layout.boxes),
    shared: countPairs(legs, sameLine),
    crossings: countPairs(legs, crossing),
    crowding: countPairs(legs, crowded),
    bends: layout.edges.reduce((total, edge) => total + Math.max(0, edge.path.length - 2), 0),
    labelsOnBox: countLabelsOnBoxes(layout),
    labelsTogether: countLabelsTogether(layout),
    diagonal,
    area: layout.width * layout.height,
  };
}

/** One straight run of one arrow. Its own shape is the only thing that matters here. */
interface Leg {
  /** Which arrow it belongs to, so that an arrow is never measured against itself. */
  readonly owner: number;
  readonly vertical: boolean;
  /** Where the leg starts and ends along its own direction. */
  readonly from: number;
  readonly to: number;
  /** The coordinate it sits at: its x when it is vertical, its y when it is horizontal. */
  readonly at: number;
}

/**
 * Every straight run in the drawing, with the arrows that have a corner in them kept
 * apart. A diagonal leg is not a run this file can reason about, so it is handed back
 * as a count of its own instead of being folded into the others.
 */
function legsOf(layout: ScopeLayout): { legs: Leg[]; diagonal: number } {
  const legs: Leg[] = [];
  let diagonal = 0;
  layout.edges.forEach((edge, owner) => {
    for (let at = 1; at < edge.path.length; at += 1) {
      const a: Point | undefined = edge.path[at - 1];
      const b: Point | undefined = edge.path[at];
      if (a === undefined || b === undefined) continue;
      if (a.x !== b.x && a.y !== b.y) {
        diagonal += 1;
        continue;
      }
      const vertical = a.x === b.x;
      const first = vertical ? a.y : a.x;
      const second = vertical ? b.y : b.x;
      legs.push({
        owner,
        vertical,
        from: Math.min(first, second),
        to: Math.max(first, second),
        at: vertical ? a.x : a.y,
      });
    }
  });
  return { legs, diagonal };
}

/**
 * How many pairs of legs meet `meets`. Pairs from one arrow are skipped: its own legs
 * share an end at every corner by construction, and two things claiming the same ink
 * is a confusion the reader has to undo, which one arrow cannot cause.
 */
function countPairs(legs: readonly Leg[], meets: (first: Leg, second: Leg) => boolean): number {
  let count = 0;
  legs.forEach((first, at) => {
    for (let further = at + 1; further < legs.length; further += 1) {
      const second = legs[further];
      if (second === undefined || second.owner === first.owner) continue;
      if (meets(first, second)) count += 1;
    }
  });
  return count;
}

/** Two legs on one line, sharing more than the point where they meet. */
function sameLine(first: Leg, second: Leg): boolean {
  return first.vertical === second.vertical && first.at === second.at && overlap(first, second) > 0;
}

/**
 * Two legs crossing each other. Both coordinates have to fall inside the other leg
 * strictly: an arrow that lands on another one touches it, and a touch is not a place
 * where the reader can lose the thread.
 */
function crossing(first: Leg, second: Leg): boolean {
  if (first.vertical === second.vertical) return false;
  const vertical = first.vertical ? first : second;
  const horizontal = first.vertical ? second : first;
  return (
    inside(vertical.at, horizontal.from, horizontal.to) &&
    inside(horizontal.at, vertical.from, vertical.to)
  );
}

/** Two parallel legs too close to be seen as two, where they run beside each other. */
function crowded(first: Leg, second: Leg): boolean {
  if (first.vertical !== second.vertical) return false;
  const apart = Math.abs(first.at - second.at);
  return apart > 0 && apart < TOGETHER && overlap(first, second) > 0;
}

/** How much two legs on one line share. Zero means they only touch, negative means apart. */
function overlap(first: Leg, second: Leg): number {
  return Math.min(first.to, second.to) - Math.max(first.from, second.from);
}

/** Strictly between: a line on a wall touches a box, it does not enter it. */
function inside(value: number, low: number, high: number): boolean {
  return low < value && value < high;
}

function countThroughBoxes(legs: readonly Leg[], boxes: readonly LayoutBox[]): number {
  let count = 0;
  for (const leg of legs) {
    for (const box of boxes) if (passesThrough(leg, box)) count += 1;
  }
  return count;
}

/**
 * Whether a leg runs through the inside of a box. The line has to sit strictly between
 * the walls it measures across, and the run has to reach past the wall it meets -- so a
 * leg along a wall is free, and so is the leg that lands on one. The same rule the path
 * tests use, so a route and its count cannot disagree.
 */
function passesThrough(leg: Leg, box: LayoutBox): boolean {
  if (leg.vertical) {
    return (
      inside(leg.at, box.x, box.x + box.width) &&
      leg.from < box.y + box.height &&
      leg.to > box.y
    );
  }
  return (
    inside(leg.at, box.y, box.y + box.height) && leg.from < box.x + box.width && leg.to > box.x
  );
}

function countLabelsOnBoxes(layout: ScopeLayout): number {
  let count = 0;
  for (const edge of layout.edges) {
    for (const box of layout.boxes) {
      const onBox =
        inside(edge.label.x, box.x, box.x + box.width) &&
        inside(edge.label.y, box.y, box.y + box.height);
      if (onBox) count += 1;
    }
  }
  return count;
}

function countLabelsTogether(layout: ScopeLayout): number {
  let count = 0;
  layout.edges.forEach((first, at) => {
    for (let further = at + 1; further < layout.edges.length; further += 1) {
      const second = layout.edges[further];
      if (second === undefined) continue;
      const across = Math.abs(first.label.x - second.label.x);
      const down = Math.abs(first.label.y - second.label.y);
      if (Math.max(across, down) < LABEL_REACH) count += 1;
    }
  });
  return count;
}
