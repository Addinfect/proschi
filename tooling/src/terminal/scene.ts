import type { Layout, Point } from '../../../frontend/src/dsl/autoLayout';
import { fallbackRoute, labelPoint } from '../../../frontend/src/dsl/edgePath';
import type { Diagram, DiagramEdge, DiagramNode } from '../../../frontend/src/dsl/types';
import { E, N, S, W } from './grid';

/**
 * The diagram in character cells: the browser's ELK layout (autoLayout.ts),
 * scaled so a 240px card is about 30 columns wide and 5 rows tall, and
 * squeezed sideways when it would not fit the terminal (`buildScene`). Edge routes become
 * runs of cells, each with the directions its line leaves in. The empty
 * rows and columns ELK's spacing leaves are then squeezed out (`compact`).
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Cell {
  x: number;
  y: number;
}

export interface SceneNode {
  node: DiagramNode;
  rect: Rect;
  depth: number;
}

export interface Path {
  /** In travel order, ends outside both boxes; the last cell holds the arrowhead. */
  cells: Cell[];
  /** Line directions of each cell. */
  dirs: number[];
  /** Direction the arrowhead points. */
  head: number;
}

export interface SceneEdge {
  edge: DiagramEdge;
  path: Path;
  label?: Cell;
}

export interface Scene {
  diagram: Diagram;
  columns: number;
  rows: number;
  nodes: Map<string, SceneNode>;
  edges: SceneEdge[];
  /** The first row below the drawing, where the legend goes. */
  legendRow: number;
}

/** Pixels per cell at full size: cells are about twice as tall as wide. */
const SX = 8;
const SY = 12;
/** Narrower than this (in pixels per column) and names stop being readable. */
const MAX_SX = 16;
/** How far a diagram that does not fit at MAX_SX is squeezed further, its names cut short, before it is drawn wider than asked. */
const SQUEEZE_SX = 20;
const MARGIN = 1;
/** Rows of a collapsed system box (paint.ts drawSystem). */
export const SYSTEM_ROWS = 6;

/**
 * The scene at the widest scale that fits `maxColumns`. Compaction, and the
 * cells that cards, gaps, labels and the legend take at any scale, keep the
 * width from following the scale, so a scene that comes out too wide is
 * redrawn narrower, past MAX_SX up to SQUEEZE_SX, until it fits. One that
 * fits at no scale comes out wider than asked (`columns > maxColumns`); the
 * caller says so rather than cutting it off.
 */
export function buildScene(diagram: Diagram, layout: Layout, maxColumns = 160): Scene {
  const widthPx = layoutWidth(diagram, layout);
  let sx = Math.min(MAX_SX, Math.max(SX, widthPx / Math.max(1, maxColumns - 2 * MARGIN - 1)));
  let scene = sceneAt(diagram, layout, sx);
  for (let tries = 0; tries < 8 && scene.columns > maxColumns && sx < SQUEEZE_SX; tries++) {
    sx = Math.min(SQUEEZE_SX, sx * Math.max(1.05, (scene.columns + 2) / maxColumns));
    const narrower = sceneAt(diagram, layout, sx);
    if (narrower.columns < scene.columns) scene = narrower;
  }
  return scene;
}

/** The layout's width in pixels, from the left edge of the drawing (or 0) to its right. */
function layoutWidth(diagram: Diagram, layout: Layout): number {
  const { xs, minX } = extent(diagram, layout);
  return Math.max(1, ...xs) - minX;
}

function extent(diagram: Diagram, layout: Layout) {
  const boxes = new Map(layout.nodes.map((b) => [b.id, b]));
  const absolute = (id: string): Point => {
    const b = boxes.get(id);
    if (!b) return { x: 0, y: 0 };
    const parent = b.parent ? absolute(b.parent) : { x: 0, y: 0 };
    return { x: parent.x + b.position.x, y: parent.y + b.position.y };
  };

  const px = diagram.nodes.filter((n) => boxes.has(n.id)).map((node) => ({ node, at: absolute(node.id), box: boxes.get(node.id)! }));
  const bends = Object.values(layout.routes).flatMap((r) => r.points);
  const xs = [...px.flatMap((p) => [p.at.x, p.at.x + p.box.width]), ...bends.map((p) => p.x)];
  const ys = [...px.flatMap((p) => [p.at.y, p.at.y + p.box.height]), ...bends.map((p) => p.y)];
  return { px, xs, minX: Math.min(0, ...xs), minY: Math.min(0, ...ys) };
}

/** The scene at `sx` pixels per column. */
function sceneAt(diagram: Diagram, layout: Layout, sx: number): Scene {
  const { px, minX, minY } = extent(diagram, layout);
  const cx = (x: number) => Math.round((x - minX) / sx) + MARGIN;
  const cy = (y: number) => Math.round((y - minY) / SY) + MARGIN;

  const depthOf = (n: DiagramNode): number => {
    const parent = n.parent ? diagram.nodes.find((p) => p.id === n.parent) : undefined;
    return parent ? depthOf(parent) + 1 : 0;
  };
  const nodes = new Map<string, SceneNode>();
  for (const { node, at, box } of px) {
    const x = cx(at.x);
    const y = cy(at.y);
    const w = Math.max(node.kind === 'group' ? 8 : 6, cx(at.x + box.width) - x);
    // A card is five rows whatever its box; a system box six: its name, team, promise and load.
    const h = node.kind === 'component' ? 5 : node.kind === 'system' ? SYSTEM_ROWS : Math.max(node.kind === 'group' ? 3 : 4, cy(at.y + box.height) - y);
    nodes.set(node.id, { node, rect: { x, y, w, h }, depth: depthOf(node) });
  }

  const edges: SceneEdge[] = [];
  for (const edge of diagram.edges) {
    const s = nodes.get(edge.source);
    const t = nodes.get(edge.target);
    if (!s || !t || s === t) continue;
    const route = layout.routes[edge.id];
    const points = route ? route.points.map((p) => ({ x: cx(p.x), y: cy(p.y) })) : undefined;
    const path = points ? routePath(points, s.rect, t.rect) : fallbackPath(s.rect, t.rect);
    if (!path) continue;
    const at = route?.label ? { x: cx(route.label.x), y: cy(route.label.y) } : labelPoint(path.cells);
    edges.push({ edge, path, ...(edge.label ? { label: { x: Math.round(at.x), y: Math.round(at.y) } } : {}) });
  }

  compact(nodes, edges);

  let right = 0;
  let bottom = 0;
  for (const { node, rect } of nodes.values()) {
    // A card with replicas has a second card behind it, one cell right and down.
    const cast = stacked(node) ? 1 : 0;
    right = Math.max(right, rect.x + rect.w + cast);
    bottom = Math.max(bottom, rect.y + rect.h + cast);
  }
  for (const { path } of edges)
    for (const c of path.cells) {
      right = Math.max(right, c.x + 1);
      bottom = Math.max(bottom, c.y + 1);
    }
  for (const e of edges) if (e.label && e.edge.label) right = Math.max(right, e.label.x + Math.ceil(e.edge.label.length / 2) + 1);
  // The legend: a framed panel below the drawing, a row per entry.
  const legend = diagram.legend ?? [];
  const legendRows = legend.length ? legend.length + 3 : 0;
  if (legend.length) right = Math.max(right, MARGIN + legendWidth(legend.map((e) => e.label)));
  return {
    diagram,
    columns: Math.min(512, Math.max(1, right + MARGIN)),
    rows: Math.min(256, Math.max(1, bottom + MARGIN + legendRows)),
    nodes,
    edges,
    legendRow: bottom + MARGIN,
  };
}

/** Whether a card is drawn with a second card behind it: it runs more than one replica. */
export function stacked(node: DiagramNode, replicas?: number): boolean {
  return node.kind === 'component' && (replicas ?? node.replicas ?? 1) > 1;
}

/** The legend panel's width: a border, a padding cell, the swatch and a gap, the longest label, a padding cell and a border. */
export function legendWidth(labels: string[]): number {
  return Math.max(10, 1 + 1 + 3 + 1 + Math.max(0, ...labels.map((l) => l.length)) + 1 + 1);
}

const contains = (r: Rect, c: Cell) => c.x >= r.x && c.x < r.x + r.w && c.y >= r.y && c.y < r.y + r.h;

/** Moves an end that the scaling left off its box back onto the box's border, along the segment it starts. */
function attach(end: Cell, next: Cell, r: Rect): Cell {
  const vertical = end.x === next.x;
  if (vertical && end.x >= r.x && end.x < r.x + r.w) {
    if (end.y >= r.y + r.h) return { x: end.x, y: r.y + r.h - 1 };
    if (end.y < r.y) return { x: end.x, y: r.y };
  }
  if (!vertical && end.y >= r.y && end.y < r.y + r.h) {
    if (end.x >= r.x + r.w) return { x: r.x + r.w - 1, y: end.y };
    if (end.x < r.x) return { x: r.x, y: end.y };
  }
  return end;
}

/** Every cell from `a` to `b`, turning once where rounding made the segment diagonal. */
function segment(a: Cell, b: Cell, out: Cell[]): void {
  const corner = Math.abs(b.y - a.y) >= Math.abs(b.x - a.x) ? { x: a.x, y: b.y } : { x: b.x, y: a.y };
  for (const [from, to] of [
    [a, corner],
    [corner, b],
  ]) {
    const dx = Math.sign(to.x - from.x);
    const dy = Math.sign(to.y - from.y);
    let { x, y } = from;
    while (x !== to.x || y !== to.y) {
      x += dx;
      y += dy;
      out.push({ x, y });
    }
  }
}

const dirTo = (a: Cell, b: Cell): number => (b.x > a.x ? E : b.x < a.x ? W : b.y > a.y ? S : N);
const opposite = (d: number): number => (d === N ? S : d === S ? N : d === E ? W : E);

/**
 * Drops a short sideways step just before the end (`│` then `╰──╮` then `▼`):
 * at this scale a few pixels of offset between a group's port and its member
 * become a jog of a few cells. When the line already runs over the box, it
 * goes straight in.
 */
function unjog(pts: Cell[], box: Rect): Cell[] {
  const n = pts.length;
  if (n < 3) return pts;
  const [a, b, c] = [pts[n - 3], pts[n - 2], pts[n - 1]];
  const sideways = a.y === b.y && Math.abs(b.x - a.x) <= 4 && b.x === c.x && Math.abs(c.y - b.y) <= 3;
  if (!sideways || a.x < box.x + 1 || a.x > box.x + box.w - 2) return pts;
  return [...pts.slice(0, n - 2), { x: a.x, y: c.y }];
}

/**
 * Drops a short step out and back (`│` then `╰──╮`, `▼──╯`): ELK routes an
 * edge into a group through a port on its border, and at this scale the few
 * pixels between that port and the line become a detour of a few cells,
 * right where the line crosses an expanded system's title. Where the line
 * comes back to the column (or row) it left, it goes straight through.
 */
function undetour(pts: Cell[]): Cell[] {
  const out = pts.slice();
  for (let i = 0; i + 3 < out.length; i++) {
    const [a, b, c, d] = out.slice(i, i + 4);
    const down = a.y === b.y && b.x === c.x && c.y === d.y && a.x === d.x && Math.abs(b.x - a.x) <= 6 && Math.abs(c.y - b.y) <= 4;
    const across = a.x === b.x && b.y === c.y && c.x === d.x && a.y === d.y && Math.abs(b.y - a.y) <= 3 && Math.abs(c.x - b.x) <= 8;
    if (down || across) out.splice(i + 1, 2);
  }
  return out;
}

/** The cells of a polyline between two boxes, outside both. */
export function routePath(points: Cell[], from: Rect, to: Rect): Path | undefined {
  if (points.length < 2) return undefined;
  const pts = unjog(unjog(undetour(points), to).reverse(), from).reverse();
  pts[0] = attach(pts[0], pts[1], from);
  pts[pts.length - 1] = attach(pts[pts.length - 1], pts[pts.length - 2], to);
  const all: Cell[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) segment(pts[i - 1], pts[i], all);
  // Drop repeats and the cells inside either box (the line runs from border to border).
  const run: Cell[] = [];
  for (const c of all) {
    const last = run[run.length - 1];
    if (last && last.x === c.x && last.y === c.y) continue;
    run.push(c);
  }
  let start = 0;
  while (start < run.length && contains(from, run[start])) start++;
  let end = run.length - 1;
  while (end >= start && contains(to, run[end])) end--;
  const cells = run.slice(start, end + 1);
  if (cells.length === 0) return undefined;
  // The cells just inside each box say which way the line leaves and enters.
  const before = run[start - 1] ?? undefined;
  const after = run[end + 1] ?? undefined;
  const dirs = cells.map((c, i) => {
    let d = 0;
    const prev = i > 0 ? cells[i - 1] : before;
    const next = i < cells.length - 1 ? cells[i + 1] : undefined;
    if (prev) d |= dirTo(c, prev);
    if (next) d |= dirTo(c, next);
    return d;
  });
  const last = cells[cells.length - 1];
  const head = after ? dirTo(last, after) : cells.length > 1 ? opposite(dirTo(last, cells[cells.length - 2])) : S;
  return { cells, dirs, head };
}

/** A route between two boxes that the layout did not connect (a use case step without an edge). */
export function fallbackPath(from: Rect, to: Rect): Path | undefined {
  const box = (r: Rect) => ({ x: r.x, y: r.y, width: r.w - 1, height: r.h - 1 });
  const points = fallbackRoute(box(from), box(to)).map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  return routePath(points, from, to);
}

/**
 * What a row or column holds, for how close its neighbours may come: a card
 * (or the card stacked behind it), a group frame's border or title, or a
 * line's bend, arrowhead or label. Anything else is blank or a straight run
 * of a line, which can go.
 */
const LINE = 1;
const FRAME = 2;
const CARD = 3;

/** Blank rows or columns kept between two kinds: cards side by side keep room to read apart, frames keep a cell of padding, lines close up. */
function gapRows(a: number, b: number): number {
  if (a === CARD || b === CARD) return 1;
  return a === FRAME && b === FRAME ? 1 : 0;
}

function gapColumns(a: number, b: number): number {
  if (a === CARD && b === CARD) return 3;
  if (a === FRAME && b === FRAME) return 2;
  return 1;
}

/**
 * The new index of each row (or column) when every run of unmarked ones is
 * cut down to the gap its marked neighbours ask for; -1 for those cut. The
 * run before the first marked one keeps the margin.
 */
function squeeze(kinds: number[], gap: (a: number, b: number) => number): number[] {
  const to = new Array<number>(kinds.length).fill(-1);
  let next = 0;
  let prev = 0;
  for (let i = 0; i < kinds.length; ) {
    if (kinds[i]) {
      prev = kinds[i];
      to[i++] = next++;
      continue;
    }
    let end = i;
    while (end < kinds.length && !kinds[end]) end++;
    if (end === kinds.length) break;
    const keep = Math.min(end - i, prev ? gap(prev, kinds[end]) : MARGIN);
    for (let k = 0; k < keep; k++) to[i + k] = next++;
    i = end;
  }
  return to;
}

/**
 * Squeezes out the rows and columns that hold only blank cells and straight
 * runs of lines, down to the gaps `gapRows` and `gapColumns` keep. Cards,
 * frames, bends, arrowheads and labels keep their rows and columns, so the
 * lines stay joined and every label stays on its line; a cut row only held
 * vertical runs, a cut column horizontal ones.
 */
function compact(nodes: Map<string, SceneNode>, edges: SceneEdge[]): void {
  const rows: number[] = [];
  const cols: number[] = [];
  const mark = (at: number[], i: number, kind: number) => {
    if (i >= 0) at[i] = Math.max(at[i] ?? 0, kind);
  };
  for (const { node, rect } of nodes.values()) {
    if (node.kind === 'group') {
      mark(rows, rect.y, FRAME);
      mark(rows, rect.y + rect.h - 1, FRAME);
      mark(cols, rect.x, FRAME);
      mark(cols, rect.x + rect.w - 1, FRAME);
      // The title chip.
      for (let x = rect.x + 1; x < Math.min(rect.x + rect.w - 1, rect.x + 4 + node.name.length + 1); x++) mark(cols, x, FRAME);
      continue;
    }
    const cast = stacked(node) ? 1 : 0;
    for (let y = rect.y; y < rect.y + rect.h + cast; y++) mark(rows, y, CARD);
    for (let x = rect.x; x < rect.x + rect.w + cast; x++) mark(cols, x, CARD);
  }
  for (const { edge, path, label } of edges) {
    path.cells.forEach((c, i) => {
      const last = i === path.cells.length - 1;
      if (last || path.dirs[i] !== (N | S)) mark(rows, c.y, LINE);
      if (last || path.dirs[i] !== (E | W)) mark(cols, c.x, LINE);
    });
    if (label && edge.label) {
      mark(rows, label.y, LINE);
      const left = label.x - Math.floor((edge.label.length + 2) / 2);
      for (let x = left; x < left + edge.label.length + 2; x++) mark(cols, x, LINE);
    }
  }
  const dense = (at: number[]) => Array.from({ length: at.length }, (_, i) => at[i] ?? 0);
  const toRow = squeeze(dense(rows), gapRows);
  const toCol = squeeze(dense(cols), gapColumns);
  const row = (y: number) => toRow[y] ?? y;
  const col = (x: number) => (x < 0 ? x : (toCol[x] ?? x));

  for (const n of nodes.values()) {
    const { x, y, w, h } = n.rect;
    n.rect = { x: col(x), y: row(y), w: col(x + w - 1) - col(x) + 1, h: row(y + h - 1) - row(y) + 1 };
  }
  for (const e of edges) {
    const cells: Cell[] = [];
    const dirs: number[] = [];
    e.path.cells.forEach((c, i) => {
      if (toRow[c.y] === -1 || toCol[c.x] === -1) return;
      cells.push({ x: col(c.x), y: row(c.y) });
      dirs.push(e.path.dirs[i]);
    });
    e.path = { cells, dirs, head: e.path.head };
    if (e.label) e.label = { x: col(e.label.x), y: row(e.label.y) };
  }
}
