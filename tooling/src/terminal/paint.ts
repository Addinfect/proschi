import { nodeBaseColor } from '../../../frontend/src/dsl/palette';
import type { Dash, DiagramNode } from '../../../frontend/src/dsl/types';
import type { NodeOverlay } from '../../../frontend/src/sim/overlay';
import { DEFAULT, E, Grid, N, S, W, hex } from './grid';
import { iconOf, type IconStyle } from './icons';
import type { Play } from './playback';
import { legendWidth, stacked, type Path, type Rect, type Scene, type SceneNode } from './scene';
import { loadText, type SystemBadge, type SystemStatus } from './systems';

/**
 * Paints a scene into a grid the way the canvas draws it: dashed group
 * frames, then the edges with their labels, then the group names and replica
 * counts the edges would cut, then the cards on top. Colors
 * follow the canvas's palette (dsl/palette.ts): the base hue of a node's
 * `color`, tag or category for its border and icon tile, the ink (the
 * terminal's own foreground) for its text. The background stays the
 * terminal's, except under solid color (icon tiles, group names, legend
 * swatches), where the text on it is set dark so it reads on any terminal.
 */

export const COLOR = {
  muted: 0x8b8f98,
  line: 0x9ca3af,
  critical: 0xef4444,
  note: 0xeab308,
  /** Playback, as the canvas's tokens (design/tokens.css): the pink packet and lit node, the fail red. */
  pink: 0xff5da2,
  fail: 0xff3b30,
  /** Dark text on a solid palette color or the accent: readable on any of them, on any terminal. */
  onColor: 0x111111,
  /**
   * What playback fades: the scenario's path loses its colors, the rest turns
   * a mid grey drawn dotted. Mid greys sit back on dark and light terminals
   * alike, where a darker or lighter grey would stand out on one of them.
   */
  faded: 0x9ca3af,
  fadedMore: 0x7a7f88,
  good: 0x22c55e,
  warn: 0xeab308,
  bad: 0xef4444,
  /** The canvas's load overlay (utils/heat.ts): a busy card's fill, from yellow through pink to red. */
  heatWarm: 0xffd23f,
  heatHot: 0xff7ab4,
  heatOver: 0xff6b61,
};

export interface PaintOptions {
  /** Utilisation and replicas per node, from the simulation. */
  overlay?: Record<string, NodeOverlay>;
  /** A use case playing over the diagram (playback.ts). */
  play?: Play;
  /** The tech icon in each card's icon tile, as on the canvas; Nerd Font glyphs by default. */
  icons?: IconStyle;
  /** Promise, headroom and status of each system box and expanded frame (systems.ts). */
  systems?: Record<string, SystemBadge>;
  /** The system the plugin's keys act on, drawn in the accent. */
  selected?: string;
}

const HEAD: Record<number, string> = { [N]: '▲', [S]: '▼', [E]: '►', [W]: '◄' };

/** How a node looks while a use case plays: lit, failing, on the scenario's path, or off it. */
type Look = 'lit' | 'failing' | 'path' | 'off' | undefined;

function lookOf(play: Play | undefined, id: string): Look {
  if (!play) return undefined;
  if (play.failing.has(id)) return 'failing';
  if (play.active.has(id)) return 'lit';
  return play.pathNodes.has(id) ? 'path' : 'off';
}

const fade = (look: Look, color: number) => (look === 'path' ? COLOR.faded : look === 'off' ? COLOR.fadedMore : color);

export function paint(scene: Scene, options: PaintOptions = {}): Grid {
  const grid = new Grid(scene.columns, scene.rows);
  const { play } = options;
  const all = [...scene.nodes.values()];

  const frameOf = (n: SceneNode) => (isFrame(n.node) ? { badge: options.systems?.[n.node.id], selected: options.selected === n.node.id } : undefined);
  for (const g of all.filter((n) => n.node.kind === 'group').sort((a, b) => a.depth - b.depth)) drawGroup(grid, g, play ? 'path' : undefined, frameOf(g));
  // The cards behind cards with replicas, under the edges so a line leaving the front card crosses them.
  for (const n of all) drawStack(grid, scene, n, options.overlay?.[n.node.id], lookOf(play, n.node.id));

  for (const { edge, path } of scene.edges) {
    const own = edge.style?.color ? hex(edge.style.color) : COLOR.line;
    const off = !!play && !play.pathEdges.has(edge.id);
    const color = play ? (off ? COLOR.fadedMore : COLOR.faded) : own;
    drawPath(grid, path, color, off ? 'dotted' : edge.style?.dash);
  }
  // The current step's line: thick ink, red for an error, dashed for a call that never arrived; flowing once the packet is there.
  for (const active of play?.edges ?? []) {
    const color = active.error ? COLOR.fail : DEFAULT;
    const { cells, dirs, head } = active.path;
    for (let i = 0; i < cells.length - 1; i++) {
      const straight = dirs[i] === (N | S) || dirs[i] === (E | W);
      const gap = active.failed ? i % 2 === 1 : active.flowing && (i + 3 * 1000 - play!.tick) % 3 === 0;
      if (straight && gap) grid.set(cells[i].x, cells[i].y, dirs[i] === (N | S) ? '╏' : '╍', color);
      else grid.line(cells[i].x, cells[i].y, dirs[i], color, true);
    }
    const last = cells[cells.length - 1];
    grid.set(last.x, last.y, HEAD[head], color);
  }
  // A label that would land on one drawn before it moves a row or two up or down, where there is room.
  const taken = new Set<string>();
  for (const { edge, label } of scene.edges) {
    if (!label || !edge.label) continue;
    const text = ` ${edge.label} `;
    const x = label.x - Math.floor(text.length / 2);
    const free = (y: number) => y >= 0 && y < grid.rows && Array.from(text, (_, i) => `${x + i},${y}`).every((k) => !taken.has(k));
    const y = [0, -1, 1, -2, 2].map((d) => label.y + d).find(free) ?? label.y;
    const color = play && !play.pathEdges.has(edge.id) ? COLOR.fadedMore : COLOR.muted;
    for (let i = 0; i < text.length; i++) {
      taken.add(`${x + i},${y}`);
      if (!onCard(scene, x + i, y)) grid.set(x + i, y, text[i], color);
    }
  }

  // Over the edges, so a line crossing them leaves them whole: group names and descriptions, the replica counts.
  for (const g of all) if (g.node.kind === 'group') drawGroupHeading(grid, g, play ? 'path' : undefined, frameOf(g));
  for (const n of all) drawStackCount(grid, scene, n, options.overlay?.[n.node.id], lookOf(play, n.node.id));

  for (const packet of play?.packets ?? []) grid.set(packet.at.x, packet.at.y, packet.cut ? '✗' : '■', packet.error ? COLOR.fail : COLOR.pink);

  for (const n of all) {
    if (n.node.kind === 'group') continue;
    const look = lookOf(play, n.node.id);
    if (n.node.kind === 'text') drawNote(grid, n, look);
    else if (n.node.kind === 'system') drawSystem(grid, n, options.systems?.[n.node.id], look, options.selected === n.node.id);
    else drawCard(grid, scene, n, options.overlay?.[n.node.id], look, options.icons ?? 'nerd-font');
  }

  drawLegend(grid, scene);
  return grid;
}

function onCard(scene: Scene, x: number, y: number): boolean {
  for (const { node, rect } of scene.nodes.values()) {
    if (node.kind === 'group') continue;
    if (x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h) return true;
  }
  return false;
}

/** An edge's line in its dash; playback draws the edges it fades out dotted. */
function drawPath(grid: Grid, path: Path, color: number, dash: Dash | undefined): void {
  const { cells, dirs, head } = path;
  const g = dash ? LINES[dash] : undefined;
  for (let i = 0; i < cells.length - 1; i++) {
    const { x, y } = cells[i];
    const straight = dirs[i] === (N | S) || dirs[i] === (E | W);
    if (g && straight) grid.set(x, y, dirs[i] === (N | S) ? g.v : g.h, color);
    else grid.line(x, y, dirs[i], color);
  }
  const last = cells[cells.length - 1];
  grid.set(last.x, last.y, HEAD[head], color);
}

function baseColor(node: DiagramNode, fallback: number): number {
  const base = nodeBaseColor(node);
  return base ? hex(base) : fallback;
}

/**
 * Straight runs of a line by its dash (palette.ts DASH_ARRAY): dashed as two
 * long dashes a cell, dotted as four short ones, so the two tell apart.
 */
const LINES: Record<'solid' | Dash, { h: string; v: string }> = {
  solid: { h: '─', v: '│' },
  dashed: { h: '╌', v: '╎' },
  dotted: { h: '┈', v: '┊' },
};

/** The same, heavy, for the cards' borders. */
const HEAVY_LINES: Record<'solid' | Dash, { h: string; v: string }> = {
  solid: { h: '━', v: '┃' },
  dashed: { h: '╍', v: '╏' },
  dotted: { h: '┅', v: '┇' },
};

/** A frame in a dash: light with rounded corners, or heavy with square ones. */
function frame(grid: Grid, r: Rect, color: number, dash: 'solid' | Dash = 'solid', heavy = false): void {
  const right = r.x + r.w - 1;
  const bottom = r.y + r.h - 1;
  const { h, v } = (heavy ? HEAVY_LINES : LINES)[dash];
  const [tl, tr, bl, br] = heavy ? '┏┓┗┛' : '╭╮╰╯';
  for (let x = r.x + 1; x < right; x++) {
    grid.set(x, r.y, h, color);
    grid.set(x, bottom, h, color);
  }
  for (let y = r.y + 1; y < bottom; y++) {
    grid.set(r.x, y, v, color);
    grid.set(right, y, v, color);
  }
  grid.set(r.x, r.y, tl, color);
  grid.set(right, r.y, tr, color);
  grid.set(r.x, bottom, bl, color);
  grid.set(right, bottom, br, color);
}

function fill(grid: Grid, r: Rect, fg: number, bg: number): void {
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) grid.set(x, y, ' ', fg, bg);
}

const fit = (text: string, room: number) => (text.length <= room ? text : room <= 1 ? '…'.slice(0, room) : text.slice(0, room - 1) + '…');

/** The frame of an expanded system (dsl/view.ts): a group whose `system` is its own id. */
const isFrame = (node: DiagramNode) => node.kind === 'group' && node.system === node.id;

/** An expanded system's frame: its badge, and whether the plugin's keys act on it. */
interface SystemFrame {
  badge?: SystemBadge;
  selected: boolean;
}

/** A system's color by its status, as a card's under the load overlay: red past capacity or its SLA, yellow running hot. */
function statusColor(status: SystemStatus | undefined, ok: number): number {
  if (status === 'saturated' || status === 'breach') return COLOR.fail;
  if (status === 'hot') return COLOR.warn;
  return status === 'idle' ? COLOR.muted : ok;
}

/** The status word on a system's top border. */
const STATUS: Record<SystemStatus, string> = { ok: '✓ ok', hot: '▲ hot', saturated: '✗ saturated', breach: '✗ breaks SLA', idle: 'not simulated' };

/** Double lines, for system boxes and frames: a team's design, set apart from a node and a group. */
function doubleFrame(grid: Grid, r: Rect, color: number): void {
  const right = r.x + r.w - 1;
  const bottom = r.y + r.h - 1;
  for (let x = r.x + 1; x < right; x++) {
    grid.set(x, r.y, '═', color);
    grid.set(x, bottom, '═', color);
  }
  for (let y = r.y + 1; y < bottom; y++) {
    grid.set(r.x, y, '║', color);
    grid.set(right, y, '║', color);
  }
  grid.set(r.x, r.y, '╔', color);
  grid.set(right, r.y, '╗', color);
  grid.set(r.x, bottom, '╚', color);
  grid.set(right, bottom, '╝', color);
}

function drawGroup(grid: Grid, { node, rect }: SceneNode, look: Look, system?: SystemFrame): void {
  if (system) return doubleFrame(grid, rect, system.selected ? COLOR.pink : fade(look, statusColor(system.badge?.status, baseColor(node, COLOR.muted))));
  frame(grid, rect, fade(look, baseColor(node, COLOR.muted)), node.style?.dash ?? 'dashed');
}

/**
 * A group's name as a chip in its color, and its description under it, as
 * the canvas shows them; drawn over the edges so they stay whole. An
 * expanded system's chip is followed by its team, promise, load and status.
 */
function drawGroupHeading(grid: Grid, { node, rect }: SceneNode, look: Look, system?: SystemFrame): void {
  const color = system ? (system.selected ? COLOR.pink : fade(look, statusColor(system.badge?.status, baseColor(node, COLOR.muted)))) : fade(look, baseColor(node, COLOR.muted));
  const name = node.name.toUpperCase();
  const badge = system?.badge;
  // The chip and what follows it; a space and two cells of border stay before the corner.
  const room = rect.w - 5;
  let about = '';
  if (badge) {
    // Short of room, the load goes first, then the promise and the team; the name is cut only after them.
    let parts = [STATUS[badge.status], badge.team ? `@${badge.team}` : '', badge.promise ?? '', loadText(badge)];
    const width = () => name.length + 2 + parts.filter(Boolean).join(' · ').length;
    for (const drop of [3, 2, 1]) if (width() > room) parts = parts.map((p, i) => (i === drop ? '' : p));
    about = parts.filter(Boolean).join(' · ');
  }
  const chip = ` ${fit(name, badge ? Math.max(4, room - 2 - about.length) : rect.w - 6)} `;
  grid.text(rect.x + 2, rect.y, chip, COLOR.onColor, Infinity, color);
  const rest = room - chip.length;
  if (about && rest > 4) grid.text(rect.x + 2 + chip.length, rect.y, `${fit(about, rest)} `, look ? COLOR.fadedMore : color);
  if (!node.description || rect.h <= 3) return;
  grid.text(rect.x + 2, rect.y + 1, fit(node.description.replace(/\s+/g, ' '), rect.w - 4), look ? COLOR.fadedMore : COLOR.muted);
}

/**
 * A collapsed system (docs/design/team-systems-and-imports.md D3): a double
 * border, its name and @team, the team's promise, and what it is sent
 * against its headroom with a bar of how busy that makes it. The border and
 * status word go yellow running hot and red past capacity or its SLA, and the
 * box fills with its heat like a busy card; selected, the border is the accent.
 */
function drawSystem(grid: Grid, { node, rect }: SceneNode, badge: SystemBadge | undefined, look: Look, selected: boolean): void {
  const accent = look === 'failing' ? COLOR.fail : look === 'lit' || selected ? COLOR.pink : undefined;
  const status = badge?.status;
  const color = accent ?? fade(look, statusColor(status, baseColor(node, COLOR.line)));
  const heat = look || !badge || badge.utilization === undefined ? undefined : heatOf({ utilization: badge.utilization, saturated: status === 'saturated' });
  const ink = heat !== undefined ? COLOR.onColor : look === 'off' ? COLOR.fadedMore : DEFAULT;
  const muted = heat !== undefined ? COLOR.onColor : look === 'off' ? COLOR.fadedMore : COLOR.muted;
  fill(grid, rect, DEFAULT, DEFAULT);
  if (heat !== undefined) fill(grid, { x: rect.x + 1, y: rect.y + 1, w: rect.w - 2, h: rect.h - 2 }, COLOR.onColor, heat);
  doubleFrame(grid, rect, color);

  const left = rect.x + 2;
  const room = rect.w - 4;
  if (status && rect.w > 14) {
    const word = ` ${fit(STATUS[status], rect.w - 8)} `;
    grid.text(rect.x + rect.w - 2 - word.length, rect.y, word, look ? muted : statusColor(status, COLOR.muted));
  }
  grid.text(left, rect.y + 1, fit(node.name, room), ink, Infinity, heat);
  grid.text(left, rect.y + 2, fit(badge?.team ? `@${badge.team}` : 'system', room), muted, Infinity, heat);
  if (!badge) return;
  grid.text(left, rect.y + 3, fit(badge.promise ? `promise ${badge.promise}` : 'no promise', room), badge.promise ? ink : muted, Infinity, heat);
  if (rect.h < 6) return;
  const long = `${loadText(badge)} sent / headroom`;
  const text = fit(long.length <= room ? long : loadText(badge), room);
  grid.text(left, rect.y + 4, text, ink, Infinity, heat);
  const bar = room - text.length - 1;
  if (bar < 4 || !Number.isFinite(badge.headroomRps) || badge.headroomRps <= 0) return;
  const share = badge.sentRps / badge.headroomRps;
  const filled = Math.max(share > 0 ? 1 : 0, Math.min(bar, Math.round(share * bar)));
  for (let i = 0; i < bar; i++) {
    const full = i < filled;
    grid.set(left + text.length + 1 + i, rect.y + 4, full ? '━' : '─', heat !== undefined ? COLOR.onColor : full ? ink : COLOR.muted, heat);
  }
}

/** The canvas's icon tile: a square of the card's color left of the name, the icon dark on it. */
const TILE = { w: 5, h: 3 };

/** The fill of a busy card (utils/heat.ts); none below 70%, where the bar alone tells. */
export function heatOf(overlay: NodeOverlay | undefined): number | undefined {
  const u = overlay?.utilization;
  if (!overlay || overlay.down || u === undefined) return undefined;
  if (overlay.saturated || u >= 1) return COLOR.heatOver;
  if (u >= 0.9) return COLOR.heatHot;
  return u >= 0.7 ? COLOR.heatWarm : undefined;
}

const replicasOf = (node: DiagramNode, overlay: NodeOverlay | undefined) => overlay?.replicas ?? node.replicas ?? 1;

/** Whether the cells one right and one down of a card are free of other cards and inside the grid. */
function stackRoom(grid: Grid, scene: Scene, { node, rect }: SceneNode): boolean {
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;
  if (!grid.inside(right, bottom)) return false;
  for (const other of scene.nodes.values()) {
    if (other.node === node || other.node.kind === 'group') continue;
    const r = other.rect;
    const hitsRight = right >= r.x && right < r.x + r.w && r.y <= bottom && r.y + r.h > rect.y + 1;
    const hitsBottom = bottom >= r.y && bottom < r.y + r.h && r.x <= right && r.x + r.w > rect.x + 1;
    if (hitsRight || hitsBottom) return false;
  }
  return true;
}

const stackShown = (grid: Grid, scene: Scene, n: SceneNode, overlay: NodeOverlay | undefined) => stacked(n.node, replicasOf(n.node, overlay)) && stackRoom(grid, scene, n);

/** The edge of a second card behind a card with replicas (canvas.css `data-stack`). */
function drawStack(grid: Grid, scene: Scene, n: SceneNode, overlay: NodeOverlay | undefined, look: Look): void {
  if (!stackShown(grid, scene, n, overlay)) return;
  const { node, rect } = n;
  const color = look ? (look === 'off' ? COLOR.fadedMore : COLOR.faded) : overlay?.down ? COLOR.muted : baseColor(node, COLOR.line);
  const right = rect.x + rect.w;
  const bottom = rect.y + rect.h;
  const { h, v } = LINES[look === 'off' ? 'dotted' : 'solid'];
  for (let y = rect.y + 2; y < bottom; y++) grid.set(right, y, v, color);
  for (let x = rect.x + 2; x < right; x++) grid.set(x, bottom, h, color);
  grid.set(right, rect.y + 1, '╮', color);
  grid.set(rect.x + 1, bottom, '╰', color);
  grid.set(right, bottom, '╯', color);
}

/** The replica count on the stacked card's edge, drawn after the lines that may cross it. */
function drawStackCount(grid: Grid, scene: Scene, n: SceneNode, overlay: NodeOverlay | undefined, look: Look): void {
  if (!stackShown(grid, scene, n, overlay)) return;
  const { rect } = n;
  const count = ` ×${replicasOf(n.node, overlay)} `;
  if (rect.w > count.length + 4) grid.text(rect.x + rect.w - 1 - count.length, rect.y + rect.h, count, look === 'off' ? COLOR.fadedMore : COLOR.muted);
}

/**
 * A card: a heavy border and a solid icon tile, both in the node's
 * color, or the accent while it is lit. On the scenario's path it turns grey
 * and keeps its ink; off it, it all turns grey and dotted. Under the load
 * overlay (ComponentNode.tsx) a busy card fills with its heat, one past
 * capacity turns its border red, one that is down turns grey and dotted, and
 * the team line gives way to the numbers and a bar of how busy it is.
 */
function drawCard(grid: Grid, scene: Scene, n: SceneNode, overlay: NodeOverlay | undefined, look: Look, icons: IconStyle): void {
  const { node, rect } = n;
  const down = !!overlay?.down;
  const over = !down && !!overlay && (!!overlay.saturated || (overlay.utilization ?? 0) >= 1);
  const heat = look ? undefined : heatOf(overlay);
  const accent = look === 'failing' ? COLOR.fail : look === 'lit' ? COLOR.pink : undefined;
  const color = accent ?? (down && !look ? COLOR.muted : over && !look ? COLOR.fail : fade(look, baseColor(node, COLOR.line)));
  const faded = look === 'path' || look === 'off' || down;
  const ink = heat !== undefined ? COLOR.onColor : look === 'off' || down ? COLOR.fadedMore : DEFAULT;
  const muted = heat !== undefined ? COLOR.onColor : look === 'off' ? COLOR.fadedMore : COLOR.muted;
  fill(grid, rect, DEFAULT, DEFAULT);
  if (heat !== undefined) fill(grid, { x: rect.x + 1, y: rect.y + 1, w: rect.w - 2, h: rect.h - 2 }, COLOR.onColor, heat);
  frame(grid, rect, color, look === 'off' || down ? 'dotted' : accent ? 'solid' : (node.style?.dash ?? 'solid'), true);

  const icon = iconOf(node, icons);
  const tiled = icon !== undefined && rect.w >= 22;
  if (tiled) {
    const tile = { x: rect.x + 2, y: rect.y + 1, w: TILE.w, h: TILE.h };
    if (faded) grid.set(tile.x + 2, tile.y + 1, icon, color, heat);
    else {
      fill(grid, tile, COLOR.onColor, color);
      grid.set(tile.x + 2, tile.y + 1, icon, COLOR.onColor, color);
    }
  }
  const left = rect.x + (tiled ? 2 + TILE.w + 2 : 2);
  const room = rect.x + rect.w - 2 - left;
  grid.text(left, rect.y + 1, fit(node.name, room), ink, Infinity, heat);
  grid.text(left, rect.y + 2, fit(node.techStack, room), muted, Infinity, heat);
  const load = overlay ? loadRow(grid, { x: left, y: rect.y + 3, room }, node, overlay, look, heat, stackShown(grid, scene, n, overlay)) : false;
  if (!load && node.ownerTeam) grid.text(left, rect.y + 3, fit(`Team: ${node.ownerTeam}`, room), muted, Infinity, heat);
  if (node.critical) grid.text(rect.x + rect.w - 4, rect.y, ' ! ', look === 'off' ? muted : COLOR.critical);
}

/**
 * The canvas's load badge in one row: replicas (unless the stack behind the
 * card shows them), size, shards and how busy, or "down", then a bar of the
 * utilisation. False when there is nothing to show.
 */
function loadRow(grid: Grid, at: { x: number; y: number; room: number }, node: DiagramNode, o: NodeOverlay, look: Look, heat: number | undefined, stack: boolean): boolean {
  const u = o.utilization;
  const replicas = replicasOf(node, o);
  const parts = [
    replicas > 1 && !stack ? `×${replicas}` : '',
    o.size ?? '',
    o.shards && o.shards > 1 ? `⧉${o.shards}` : '',
    o.down ? 'down' : u !== undefined ? `${Math.round(u * 100)}%` : '',
  ].filter(Boolean);
  if (parts.length === 0) return false;
  const text = fit(parts.join(' · '), at.room);
  const on = heat !== undefined;
  const ink = on ? COLOR.onColor : look === 'off' || o.down ? COLOR.fadedMore : look ? COLOR.muted : DEFAULT;
  grid.text(at.x, at.y, text, ink, Infinity, heat);
  const bar = at.room - text.length - 1;
  if (u === undefined || o.down || bar < 4) return true;
  const filled = Math.max(u > 0 ? 1 : 0, Math.min(bar, Math.round(u * bar)));
  for (let i = 0; i < bar; i++) {
    const full = i < filled;
    grid.set(at.x + text.length + 1 + i, at.y, full ? '━' : '─', on ? COLOR.onColor : full ? ink : COLOR.muted, heat);
  }
  return true;
}

function drawNote(grid: Grid, { node, rect }: SceneNode, look: Look): void {
  const muted = look === 'off' ? COLOR.fadedMore : COLOR.muted;
  fill(grid, rect, DEFAULT, DEFAULT);
  frame(grid, rect, fade(look, COLOR.note), look === 'off' ? 'dotted' : 'solid');
  const room = rect.w - 4;
  grid.text(rect.x + 2, rect.y + 1, fit(node.name, room), look === 'off' ? COLOR.fadedMore : DEFAULT);
  const words = (node.description ?? '').split(/\s+/).filter(Boolean);
  let y = rect.y + 2;
  let line = '';
  for (const word of words) {
    if (y >= rect.y + rect.h - 1) break;
    if (line && line.length + 1 + word.length > room) {
      grid.text(rect.x + 2, y++, line, muted);
      line = '';
    }
    line = line ? `${line} ${word}` : fit(word, room);
  }
  if (line && y < rect.y + rect.h - 1) grid.text(rect.x + 2, y, line, muted);
}

/**
 * The legend as the canvas's panel (Legend.tsx): a frame titled LEGEND, a
 * row per entry with its swatch, a block of the entry's color for a fill or
 * a run of its line for a dash.
 */
function drawLegend(grid: Grid, scene: Scene): void {
  const legend = scene.diagram.legend;
  if (!legend?.length) return;
  const panel = { x: 1, y: scene.legendRow, w: legendWidth(legend.map((e) => e.label)), h: legend.length + 2 };
  frame(grid, panel, COLOR.muted);
  grid.text(panel.x + 2, panel.y, ' LEGEND ', COLOR.muted);
  legend.forEach((entry, i) => {
    const y = panel.y + 1 + i;
    const x = panel.x + 2;
    const color = entry.color ? hex(entry.color) : DEFAULT;
    if (entry.dash) grid.text(x, y, LINES[entry.dash].h.repeat(3), color);
    else if (entry.color) grid.text(x, y, '   ', color, Infinity, color);
    else grid.text(x, y, '───', color);
    grid.text(x + 4, y, fit(entry.label, panel.w - 8), DEFAULT);
  });
}
