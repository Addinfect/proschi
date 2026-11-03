import type { LayoutEdge, Point } from './layout';

/**
 * The last step before a `<svg>`: a placed level in, attribute strings out.
 *
 * Everything here returns a string or a number that a component writes straight
 * into an element -- `d` for a polyline, `d` for the head, the text on a box --
 * because a string is what a renderer needs and what a test can read. No DOM, no
 * React, no colour: how an arrow is styled is the stylesheet's business, and
 * this file only decides where the ink goes.
 *
 * Two things get decided here that the layout could not:
 *
 * - the head is a filled triangle, so the line has to stop at its base, or the
 *   stroke pokes out past the point -- and an arrow that leaves the scope has no
 *   head at all, so its line runs all the way to where it ends;
 * - a box has a width, and a label longer than that width has to be shortened,
 *   because a box that grows with its label would undo the ranks.
 *
 * Numbers are rounded to hundredths on the way out. Floating point at a third of
 * a pixel helps nobody, and rounded output is comparable in a test.
 */

/** How long the arrow head is, and how wide at its base. */
const HEAD = 8;
const HEAD_HALF = 4;

/** What a box keeps free left and right of its label. `layoutScope` adds the same. */
const LABEL_PAD = 20;

/** One character's width at the drawn font size, and the head the arrows get. */
export interface InkSpec {
  /** Defaults to 7, the width `layoutScope` assumes when it sizes a box. */
  readonly charWidth?: number;
  /** Defaults to 8. */
  readonly head?: number;
}

/**
 * A polyline as SVG path data: `M x y L x y L …`.
 *
 * Fewer than two points is nothing to draw, so it is the empty string rather
 * than a lone `M`: an element with no `d` draws no stroke, and a stray `M` still
 * paints a line cap.
 */
export function pathData(points: readonly Point[]): string {
  const first = points.at(0);
  const rest = points.slice(1);
  if (first === undefined || rest.length === 0) return '';
  return `M ${num(first.x)} ${num(first.y)}${rest.map((point) => ` L ${num(point.x)} ${num(point.y)}`).join('')}`;
}

/**
 * The arrow's line, stopped at the base of its head -- so the line does not run
 * out of the point. A leg shorter than the head is not drawn at all: the head
 * covers it end to end, and a line under a filled triangle only thickens it.
 *
 * An edge with no head keeps its whole path: there is nothing to stop short of.
 */
export function drawnPath(edge: LayoutEdge, spec: InkSpec = {}): string {
  const head = spec.head ?? HEAD;
  return pathData(edge.head ? headBase(edge.path, head) : edge.path);
}

/**
 * The head: a filled triangle whose point is the last point of the path, turned
 * into the direction the last leg runs. Nothing at all when the arrow does not
 * end on a box -- a head is a claim about where the arrow goes.
 */
export function headPath(edge: LayoutEdge, spec: InkSpec = {}): string {
  if (!edge.head) return '';
  const head = spec.head ?? HEAD;
  const tip = edge.path.at(-1);
  const base = headBase(edge.path, head).at(-1);
  if (tip === undefined || base === undefined) return '';
  const turn = direction(base, tip);
  if (turn === undefined) return '';
  const across = { x: -turn.y * HEAD_HALF, y: turn.x * HEAD_HALF };
  const left = { x: base.x + across.x, y: base.y + across.y };
  const right = { x: base.x - across.x, y: base.y - across.y };
  return `M ${num(tip.x)} ${num(tip.y)} L ${num(left.x)} ${num(left.y)} L ${num(right.x)} ${num(right.y)} Z`;
}

/**
 * What an arrow says: the relation, and how many model edges it stands for when
 * a scope lifted several onto one line. One edge shows no count -- a `1` on every
 * arrow would be noise.
 */
export function edgeText(edge: LayoutEdge): string {
  return edge.count > 1 ? `${edge.relation} \u00d7${edge.count}` : edge.relation;
}

/**
 * A label shortened to a box, with an ellipsis: the box keeps the width the
 * layout gave it. `charWidth` is the same estimate the layout sizes with, so a
 * label that exactly filled its box comes back whole.
 */
export function fitLabel(label: string, width: number, spec: InkSpec = {}): string {
  const charWidth = spec.charWidth ?? 7;
  const room = Math.floor((width - LABEL_PAD) / charWidth);
  if (label.length <= room) return label;
  if (room < 2) return '';
  return `${label.slice(0, room - 1)}\u2026`;
}

/** The members of a lifted arrow, for a tooltip; `''` when there is nothing to say. */
export function membersText(edge: LayoutEdge): string {
  return edge.members.length > 1 ? edge.members.join(', ') : '';
}

/** The path with its last point pulled back to where the head starts. */
function headBase(points: readonly Point[], head: number): Point[] {
  const tip = points.at(-1);
  const before = points.at(-2);
  if (tip === undefined || before === undefined) return [];
  const turn = direction(before, tip);
  // A point that repeats is no leg at all; the head sits on the corner it shares.
  if (turn === undefined) return points.slice(0, -1);
  // A leg shorter than the head: stop at the corner, which is where its base is.
  if (!shorten(before, tip, head)) return points.slice(0, -1);
  const base = { x: tip.x - turn.x * head, y: tip.y - turn.y * head };
  return [...points.slice(0, -1), base];
}

/** Whether the leg is at least `head` long, so the base still sits on it. */
function shorten(from: Point, to: Point, head: number): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= head;
}

/** The unit vector from one point to another, or nothing when they coincide. */
function direction(from: Point, to: Point): Point | undefined {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (length === 0) return undefined;
  return { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
}

function num(value: number): number {
  return Math.round(value * 100) / 100;
}
