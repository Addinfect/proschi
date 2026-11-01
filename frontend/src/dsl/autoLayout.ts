import type { ElkEdgeSection, ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import type { EdgeRoute, Point } from '../types/canvas';
import type { Diagram, DiagramNode, LayoutDirection as LayoutHintDirection, Rank } from './types';
import { countCrossings, countOutOfOrder, toRects } from './layoutMetrics';

export type { EdgeRoute, Point };

/**
 * ELK auto-layout of a diagram, free of React Flow so the canvas
 * (layout.ts) and the static renderer (`proschi render`) place every node and
 * route every edge exactly the same way.
 */

// The canvas cards' rendered sizes (ComponentNode), so edge routes end on their borders.
const COMPONENT_SIZE = { width: 240, height: 60 };
const COMPONENT_WITH_TEAM_SIZE = { width: 240, height: 84 };
const TEXT_SIZE = { width: 240, height: 110 };
/** A collapsed system box as the static renderers draw it (name, team, promise); the canvas draws a bigger card through `nodeSize`. */
export const SYSTEM_SIZE = { width: 240, height: 100 };

/** Edge labels: the canvas draws them in 11px JetBrains Mono on a padded chip. */
const LABEL_CHAR_WIDTH = 6.7;
const LABEL_PAD = 12;
const LABEL_HEIGHT = 18;

/** Labels sit on their edge (the chip covers the line), as on the canvas, not beside it. */
const INLINE_LABEL = { 'elk.edgeLabels.inline': 'true' };

/** Space kept between a group's edge and a member that was dragged near it. */
const GROUP_MARGIN = 24;

/** Where edges flow, in ELK's terms. */
export type LayoutDirection = 'DOWN' | 'RIGHT' | 'UP' | 'LEFT';

/** Settings that may differ per diagram and per group; they override the document's layout hints. */
export interface LayoutOptions {
  direction?: LayoutDirection;
  /** Per-group overrides, by group id. */
  groups?: Record<string, { direction?: LayoutDirection }>;
  /** Lay every edge out by declaration order (`layout ordered`). */
  ordered?: boolean;
  /** Raw ELK options over the defaults, for trying engine settings in the metrics harness. */
  elk?: Record<string, string>;
  /** The size a renderer draws a node at, when it differs from the default card (e.g. the canvas's system boxes). */
  nodeSize?: (node: DiagramNode) => { width: number; height: number } | undefined;
}

// ELK reads spacing from each container, so groups repeat it.
const SPACING = {
  'elk.spacing.nodeNode': '40',
  'elk.spacing.edgeNode': '24',
  'elk.spacing.edgeEdge': '14',
  'elk.spacing.edgeLabel': '4',
  'elk.layered.spacing.nodeNodeBetweenLayers': '40',
  'elk.layered.spacing.edgeNodeBetweenLayers': '24',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '14',
};

/** `interactive`: the top level is layered by rank hints; `ranked`: some container is, and compaction would undo it. */
function rootOptions(options: LayoutOptions, interactive = false, ranked = false): Record<string, string> {
  return {
    'elk.algorithm': 'layered',
    'elk.direction': options.direction ?? 'DOWN',
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    'elk.edgeRouting': 'ORTHOGONAL',
    ...SPACING,
    'elk.spacing.componentComponent': '72',
    // Declaration order steers the layout: what comes first goes first, and breaks ties.
    'elk.layered.considerModelOrder.strategy': 'PREFER_NODES',
    'elk.layered.cycleBreaking.strategy': 'GREEDY_MODEL_ORDER',
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    'elk.layered.thoroughness': '100',
    // Straighter, shorter edges than BRANDES_KOEPF on big graphs.
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.compaction.postCompaction.strategy': 'EDGE_LENGTH',
    'elk.edgeLabels.placement': 'CENTER',
    'elk.layered.unnecessaryBendpoints': 'false',
    ...(interactive ? INTERACTIVE_LAYERING : {}),
    // Compaction slides nodes along the flow, out of the layer their rank put them in.
    ...(ranked ? { 'elk.layered.compaction.postCompaction.strategy': 'NONE' } : {}),
    ...options.elk,
  };
}

const vertical = (direction: LayoutDirection = 'DOWN') => direction === 'DOWN' || direction === 'UP';

/** Padding inside a group (matches GroupNode), and its smallest drawn size. */
const GROUP_PAD = { top: 56, left: 24, side: 24 };
const GROUP_MIN = { width: 300, height: 200 };

/** Keeps the members of a container in declaration order, whatever the crossings. */
const FORCE_ORDER = { 'elk.layered.crossingMinimization.forceNodeModelOrder': 'true' };

function groupOptions(options: LevelOptions): Record<string, string> {
  return {
    // Matches GroupNode's minimum size so the drawn box and the layout agree.
    'elk.padding': '[top=56,left=24,bottom=24,right=24]',
    'elk.nodeSize.constraints': 'MINIMUM_SIZE',
    // ELK applies this before turning its left-to-right layout to vertical, so a vertical layout needs it transposed.
    'elk.nodeSize.minimum': vertical(options.direction) ? '(200, 300)' : '(300, 200)',
    ...SPACING,
    ...(options.groupOrder ? FORCE_ORDER : {}),
  };
}

/** What layoutBoxes needs from ELK: the bundled engine, or one running in a Web Worker (layout.ts). */
export type ElkInstance = { layout: (graph: ElkNode) => Promise<ElkNode> };
let elkPromise: Promise<ElkInstance> | undefined;

/** ELK on the calling thread. It is large, so it is loaded on first use and kept out of the main bundle. */
export function bundledElk(): Promise<ElkInstance> {
  elkPromise ??= import('elkjs/lib/elk.bundled.js').then(({ default: ELK }) => new ELK());
  return elkPromise;
}

export interface LaidOutNode {
  id: string;
  /** Top-left corner, relative to the enclosing group when there is one. */
  position: Point;
  width: number;
  /** ELK's height; components are measured by the canvas, so theirs is only nominal. */
  height: number;
  /** The enclosing group, when it exists. */
  parent?: string;
}

export interface Layout {
  nodes: LaidOutNode[];
  /** Routes by diagram edge id; edges without one (pinned or moved ends) are drawn by a fallback. */
  routes: Record<string, EdgeRoute>;
}

/** Positions every node (see layoutDiagram); the edge routes are dropped. */
export async function layoutBoxes(diagram: Diagram, getElk: () => Promise<ElkInstance> = bundledElk): Promise<LaidOutNode[]> {
  return (await layoutGraph(diagram, getElk)).nodes;
}

/**
 * Positions every node with ELK's layered algorithm and routes every edge
 * orthogonally around them. Groups become containers sized around their
 * members, and an explicit `pos x,y` wins over the layout. Use case steps
 * between nodes that no edge connects count as connections, so flows lay out
 * sensibly even when the architecture declares no edges. `getElk` picks the
 * ELK engine (default: bundled, on this thread).
 *
 * The document's layout hints steer it (docs/STYLING.md, "Steering the
 * layout"): `direction` turns the flow, `rank` pins nodes to a layer and
 * `layout ordered` lays every edge out by declaration order. Of the layouts
 * in VARIANTS, the one with the fewest crossings wins, and among those the
 * one with the fewest siblings out of declaration order.
 */
export async function layoutGraph(diagram: Diagram, getElk: () => Promise<ElkInstance> = bundledElk, options: LayoutOptions = {}): Promise<Layout> {
  const base = { ...options, direction: options.direction ?? elkDirection(diagram.layout?.direction), ordered: options.ordered ?? diagram.layout?.ordered };
  let best: { level: Level; score: [number, number] } | undefined;
  const groups = diagram.nodes.some((n) => n.kind === 'group');
  let canMirror = true;
  for (const variant of VARIANTS) {
    if ((variant.groupOrder && !groups) || (variant.mirror && !canMirror)) continue;
    const level = await layoutLevel(diagram, getElk, { ...base, ...variant });
    if (variant.mirror && !level.mirrored) {
      canMirror = false;
      continue;
    }
    const s = score(diagram, level, base.direction ?? 'DOWN');
    if (!best || s[0] < best.score[0] || (s[0] === best.score[0] && s[1] < best.score[1])) best = { level, score: s };
  }
  const { nodes, routes } = best!.level;
  return { nodes, routes };
}

/**
 * The ways layoutGraph tries to lay a diagram out: as is, with every group's
 * members in declaration order, and each of those mirrored (ELK given every
 * list reversed, the result turned back), which is where ELK's sweeps often
 * land a diagram the right way round. Never more crossings than the plain
 * layout; the fewest siblings out of declaration order breaks the tie.
 */
interface LevelOptions extends LayoutOptions {
  groupOrder?: boolean;
  mirror?: boolean;
}

const VARIANTS: Pick<LevelOptions, 'groupOrder' | 'mirror'>[] = [{}, { mirror: true }, { groupOrder: true }, { groupOrder: true, mirror: true }];

/** How a layout reads: edge crossings first, then siblings out of declaration order. */
function score(diagram: Diagram, level: Level, flow: LayoutDirection): [number, number] {
  const crossings = countCrossings(Object.values(level.routes));
  return [crossings, countOutOfOrder(toRects(level.nodes, diagram), vertical(flow) ? 'x' : 'y')];
}

const elkDirection = (direction: LayoutHintDirection | undefined): LayoutDirection | undefined => direction?.toUpperCase() as LayoutDirection | undefined;

/** A layout, plus the nodes that are where ELK put them (not moved by a `pos`), so routes to them hold. */
interface Level extends Layout {
  unmoved: Set<string>;
  /** Laid out mirrored (LevelOptions); not when a group is laid out on its own. */
  mirrored?: boolean;
}

/** An edge as handed to ELK; an end on a group laid out on its own goes through a port on its border. */
interface LayoutEdge {
  id: string;
  source: string;
  target: string;
  /** The member inside a separately laid-out `source` group that the edge really starts at. */
  sourceMember?: string;
  targetMember?: string;
  labels?: ElkExtendedEdge['labels'];
  /** A node standing in for the label (rankLayers), which the edge is handed to ELK in two halves through. */
  via?: string;
}

type Side = 'NORTH' | 'SOUTH' | 'WEST' | 'EAST';

/** A group laid out on its own (its direction differs from the flow around it). */
interface Separate {
  level: Level;
  /** Where its layout's origin sits inside the group's box. */
  offset: Point;
  width: number;
  height: number;
  /** Member boxes relative to the group's top-left, by id. */
  members: Map<string, Box>;
  /** The members that are not groups, which an edge into the group must not cross. */
  leaves: (Box & { id: string })[];
}

/** `declared`: declaration order, which steers edge directions; ELK sees the nodes in `diagram.nodes` order. */
async function layoutLevel(diagram: Diagram, getElk: () => Promise<ElkInstance>, options: LevelOptions, declared = new Map(diagram.nodes.map((n, i) => [n.id, i]))): Promise<Level> {
  const byId = new Map(diagram.nodes.map((n) => [n.id, n]));
  const parentOf = (id: string) => {
    const p = byId.get(id)?.parent;
    return p && byId.has(p) ? p : undefined;
  };
  const flow = options.direction ?? 'DOWN';

  // A group whose own direction differs from the flow around it is laid out on
  // its own, then placed as one box: ELK gives every group the root's direction.
  const ownDirection = (id: string) => (byId.get(id)?.kind === 'group' ? (options.groups?.[id]?.direction ?? elkDirection(byId.get(id)!.direction)) : undefined);
  const flowAt = (id: string | undefined): LayoutDirection => (id === undefined ? flow : (ownDirection(id) ?? flowAt(parentOf(id))));
  const hasMembers = new Set(diagram.nodes.map((n) => parentOf(n.id)));
  const isSeparate = (id: string) => hasMembers.has(id) && ownDirection(id) !== undefined && ownDirection(id) !== flowAt(parentOf(id));
  /** The node itself, or the outermost separately laid-out group around it. */
  const carrierOf = (id: string): string => {
    let carrier = id;
    for (let p = parentOf(id); p; p = parentOf(p)) if (isSeparate(p)) carrier = p;
    return carrier;
  };

  const separate = new Map<string, Separate>();
  const outermost = diagram.nodes.filter((n) => isSeparate(n.id) && carrierOf(n.id) === n.id);
  // Laid out on its own, a group's members keep their order whatever the edges
  // around it, so they take the order a layout with the group in the main flow gives them.
  // A group laid out on its own would need its inside mirrored too, against its own flow.
  if (options.mirror && outermost.length) return { nodes: [], routes: {}, unmoved: new Set(), mirrored: false };
  const across = new Map<string, number>();
  if (outermost.length) {
    const inline = Object.fromEntries(outermost.map((g) => [g.id, { direction: flowAt(parentOf(g.id)) }]));
    const preview = absoluteBoxes((await layoutLevel(diagram, getElk, { ...options, groups: { ...options.groups, ...inline } }, declared)).nodes);
    for (const [id, b] of preview) across.set(id, flow === 'DOWN' || flow === 'UP' ? b.x + b.width / 2 : b.y + b.height / 2);
  }
  for (const group of outermost) {
    const inside = diagram.nodes.filter((n) => isAncestor(byId, group.id, n.id)).sort((a, b) => (across.get(a.id) ?? 0) - (across.get(b.id) ?? 0));
    const ids = new Set(inside.map((n) => n.id));
    // The group's direct members become the sub-layout's top level: their parent is not in it.
    const sub: Diagram = { ...diagram, nodes: inside, edges: diagram.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
    const direction = ownDirection(group.id)!;
    // Members that no edge connects line up along the group's direction too, not across it. ELK
    // only packs unconnected parts when it lays out one level at a time, which is the same without nested groups.
    const along = {
      'elk.aspectRatio': direction === 'RIGHT' || direction === 'LEFT' ? '100' : '0.01',
      ...(inside.some((n) => n.kind === 'group') ? {} : { 'elk.hierarchyHandling': 'SEPARATE_CHILDREN' }),
    };
    const level = await layoutLevel(sub, getElk, { ...options, direction, elk: { ...along, ...options.elk } }, declared);
    const rects = absoluteBoxes(level.nodes);
    // Sized around what the layout placed; members pinned with `pos` are grown around later.
    const top = level.nodes.filter((b) => !b.parent);
    const free = top.filter((b) => !byId.get(b.id)?.position);
    const points = Object.values(level.routes).flatMap((r) => r.points);
    const xs = [...(free.length ? free : top).flatMap((b) => [b.position.x, b.position.x + b.width]), ...points.map((p) => p.x)];
    const ys = [...(free.length ? free : top).flatMap((b) => [b.position.y, b.position.y + b.height]), ...points.map((p) => p.y)];
    const [minX, minY] = [Math.min(...xs), Math.min(...ys)];
    const offset = { x: GROUP_PAD.left - minX, y: GROUP_PAD.top - minY };
    const members = new Map<string, Box>();
    for (const [id, r] of rects) members.set(id, { x: r.x + offset.x, y: r.y + offset.y, width: r.width, height: r.height });
    separate.set(group.id, {
      level,
      offset,
      members,
      leaves: [...members.entries()].filter(([id]) => byId.get(id)?.kind !== 'group').map(([id, b]) => ({ id, ...b })),
      width: Math.max(GROUP_MIN.width, Math.max(...xs) - minX + GROUP_PAD.left + GROUP_PAD.side),
      height: Math.max(GROUP_MIN.height, Math.max(...ys) - minY + GROUP_PAD.top + GROUP_PAD.side),
    });
  }

  const inMain = (id: string) => carrierOf(id) === id;
  const mainNodes = diagram.nodes.filter((n) => inMain(n.id));
  const elkNodes = new Map<string, ElkNode>();
  for (const node of mainNodes) {
    const own = separate.get(node.id);
    if (own) {
      elkNodes.set(node.id, { id: node.id, width: own.width, height: own.height, ports: [], layoutOptions: { 'elk.portConstraints': 'FIXED_POS' } });
      continue;
    }
    const size = node.kind === 'group' ? {} : (options.nodeSize?.(node) ?? (node.kind === 'text' ? TEXT_SIZE : node.kind === 'system' ? SYSTEM_SIZE : node.ownerTeam ? COMPONENT_WITH_TEAM_SIZE : COMPONENT_SIZE));
    elkNodes.set(node.id, {
      id: node.id,
      ...size,
      children: node.kind === 'group' ? [] : undefined,
      layoutOptions: node.kind === 'group' ? groupOptions(options) : undefined,
    });
  }

  const roots: ElkNode[] = [];
  for (const node of mainNodes) {
    const elkNode = elkNodes.get(node.id)!;
    const parent = node.parent ? elkNodes.get(node.parent) : undefined;
    if (parent?.children) parent.children.push(elkNode);
    else roots.push(elkNode);
  }

  // Empty groups still need a visible size.
  for (const node of elkNodes.values()) {
    if (node.children && node.children.length === 0) {
      node.width = 300;
      node.height = 200;
    }
  }

  const connected = new Set<string>();
  const pair = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  const edges: LayoutEdge[] = [];
  const canConnect = (source: string, target: string) =>
    source !== target &&
    byId.has(source) &&
    byId.has(target) &&
    // ELK rejects edges between a group and its own members.
    !isAncestor(byId, source, target) &&
    !isAncestor(byId, target, source);
  /** The edge between the carriers of its ends; inside one separately laid-out group it belongs to that group's layout. */
  const toLayoutEdge = (id: string, from: string, to: string, labels?: ElkExtendedEdge['labels']): LayoutEdge | undefined => {
    const [source, target] = [carrierOf(from), carrierOf(to)];
    if (!canConnect(source, target)) return undefined;
    return { id, source, target, ...(separate.has(source) ? { sourceMember: from } : {}), ...(separate.has(target) ? { targetMember: to } : {}), ...(labels ? { labels } : {}) };
  };

  for (const e of diagram.edges) {
    if (!canConnect(e.source, e.target)) continue;
    connected.add(pair(e.source, e.target));
    const labels = e.label ? [{ text: e.label, width: Math.ceil(e.label.length * LABEL_CHAR_WIDTH + LABEL_PAD), height: LABEL_HEIGHT, layoutOptions: INLINE_LABEL }] : undefined;
    const edge = toLayoutEdge(e.id, e.source, e.target, labels);
    if (edge) edges.push(edge);
  }
  // A step only shapes the layout between nodes no edge connects, and once
  // per pair: the reply going back must not pull the two apart.
  for (const uc of diagram.useCases) {
    for (const s of uc.steps) {
      const key = pair(s.fromServiceId, s.toServiceId);
      if (connected.has(key) || !canConnect(s.fromServiceId, s.toServiceId)) continue;
      connected.add(key);
      const edge = toLayoutEdge(`step\u0000${edges.length}`, s.fromServiceId, s.toServiceId);
      if (edge) edges.push(edge);
    }
  }

  const reversed = orientEdges(edges, declared, !!options.ordered);
  const interactive = rankLayers(mainNodes, edges, reversed, elkNodes, roots, parentOf, flow);
  // After rankLayers, which may turn edges: a port's side depends on which way its edge runs.
  const ports = attachPorts(edges, separate, elkNodes, flow);

  const elkEdges: ElkExtendedEdge[] = edges.flatMap((e) => {
    const [source, target] = [ports.get(`${e.id}\u0000source`) ?? e.source, ports.get(`${e.id}\u0000target`) ?? e.target];
    if (e.via) {
      return [
        { id: `${e.id}\u0000in`, sources: [source], targets: [`${e.via}\u0000in`] },
        { id: `${e.id}\u0000out`, sources: [`${e.via}\u0000out`], targets: [target] },
      ];
    }
    return [{ id: e.id, sources: [source], targets: [target], ...(e.labels ? { labels: e.labels } : {}) }];
  });

  const mirrored = !!options.mirror;
  if (mirrored) reverseOrder(roots, elkEdges);
  const elk = await getElk();
  const result = await elk.layout({ id: 'root', layoutOptions: rootOptions(options, interactive.has(undefined), interactive.size > 0), children: roots, edges: elkEdges });
  if (mirrored) mirrorLayout(result, vertical(flow) ? 'x' : 'y');

  // ELK's absolute positions, before `pos` overrides any of them.
  const placed = new Map<string, ElkNode>();
  const elkAbsolute = new Map<string, Point>([['root', { x: 0, y: 0 }]]);
  const collect = (nodes: ElkNode[] | undefined, origin: Point) =>
    nodes?.forEach((n) => {
      placed.set(n.id, n);
      const at = { x: origin.x + (n.x ?? 0), y: origin.y + (n.y ?? 0) };
      elkAbsolute.set(n.id, at);
      collect(n.children, at);
    });
  collect(result.children, { x: 0, y: 0 });

  // Members of a separately laid-out group keep their places inside it.
  const inner = new Map<string, LaidOutNode>();
  for (const [group, own] of separate) {
    for (const b of own.level.nodes) {
      const direct = !b.parent;
      const pinned = byId.get(b.id)?.position;
      inner.set(b.id, direct ? { ...b, position: pinned ?? { x: b.position.x + own.offset.x, y: b.position.y + own.offset.y }, parent: group } : b);
    }
  }
  const boxes = diagram.nodes.map((node): LaidOutNode => {
    const nested = inner.get(node.id);
    if (nested) return nested;
    const box = placed.get(node.id);
    return {
      id: node.id,
      position: node.position ?? { x: box?.x ?? 0, y: box?.y ?? 0 },
      width: box?.width ?? 0,
      height: box?.height ?? 0,
      ...(node.parent && byId.has(node.parent) ? { parent: node.parent } : {}),
    };
  });
  growGroupsAroundMembers(boxes, byId);

  // Where every node really ends up, so routes whose ends were pinned elsewhere are dropped.
  const boxById = new Map(boxes.map((b) => [b.id, b]));
  const finalAbsolute = (id: string): Point => {
    const b = boxById.get(id)!;
    const origin = b.parent ? finalAbsolute(b.parent) : { x: 0, y: 0 };
    return { x: origin.x + b.position.x, y: origin.y + b.position.y };
  };
  const unmovedInMain = (id: string) => {
    const a = elkAbsolute.get(id);
    const b = finalAbsolute(id);
    return !!a && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5;
  };
  const unmoved = new Set(mainNodes.map((n) => n.id).filter(unmovedInMain));
  for (const [group, own] of separate) {
    if (!unmoved.has(group)) continue;
    for (const id of own.level.unmoved) unmoved.add(id);
  }

  const boxAt = (id: string): Box => ({ ...elkAbsolute.get(id)!, width: placed.get(id)?.width ?? 0, height: placed.get(id)?.height ?? 0 });
  const titles = mainNodes.filter((n) => n.kind === 'group' && unmovedInMain(n.id)).map((n) => titleBand(boxAt(n.id), n.name));
  const routes: Record<string, EdgeRoute> = {};
  const routed = new Map((result.edges ?? []).map((e) => [e.id, e as ElkExtendedEdge & { container?: string }]));
  /** Ends that run through one port of a separately laid-out group to one member, by port. */
  const bundles = new Map<string, { id: string; atStart: boolean; box: Box }[]>();
  for (const layoutEdge of edges) {
    const parts = layoutEdge.via ? [routed.get(`${layoutEdge.id}\u0000in`), routed.get(`${layoutEdge.id}\u0000out`)] : [routed.get(layoutEdge.id)];
    const flipped = reversed.has(layoutEdge.id);
    // The diagram's source and target, which a flipped edge had the other way round.
    const [source, target] = flipped ? [layoutEdge.target, layoutEdge.source] : [layoutEdge.source, layoutEdge.target];
    const [sourceMember, targetMember] = flipped ? [layoutEdge.targetMember, layoutEdge.sourceMember] : [layoutEdge.sourceMember, layoutEdge.targetMember];
    const [from, to] = [sourceMember ?? source, targetMember ?? target];
    if (layoutEdge.id.startsWith('step\u0000') || parts.some((p) => !p?.sections?.length) || !unmoved.has(source) || !unmoved.has(target) || !unmoved.has(from) || !unmoved.has(to)) continue;
    const originOf = (e: ElkExtendedEdge & { container?: string }) => elkAbsolute.get(e.container ?? 'root') ?? { x: 0, y: 0 };
    const shift = (p: Point) => ({ x: originOf(parts[0]!).x + p.x, y: originOf(parts[0]!).y + p.y });
    // Through the label's stand-in, the two halves join up across it; the label sits at its centre.
    const stand = layoutEdge.via ? boxAt(layoutEdge.via) : undefined;
    const label = parts[0]!.labels?.[0];
    const labelAt = stand
      ? { x: stand.x + stand.width / 2, y: stand.y + stand.height / 2 }
      : label?.x !== undefined && label.y !== undefined
        ? shift({ x: label.x + (label.width ?? 0) / 2, y: label.y + (label.height ?? 0) / 2 })
        : undefined;
    let points = parts.flatMap((p) => sectionPoints(p!.sections!).map((q) => ({ x: originOf(p!).x + q.x, y: originOf(p!).y + q.y })));
    if (flipped) points.reverse();
    // An end on a separately laid-out group runs on from the port to the member inside.
    const leg = (group: string, member: string, port: Point, atStart: boolean) => {
      const inside = separate.get(group)!.members.get(member);
      const g = elkAbsolute.get(group)!;
      if (!inside) return port;
      const box = { x: g.x + inside.x, y: g.y + inside.y, width: inside.width, height: inside.height };
      const key = `${group}\u0000${member}\u0000${Math.round(port.x)},${Math.round(port.y)}`;
      bundles.set(key, [...(bundles.get(key) ?? []), { id: layoutEdge.id, atStart, box }]);
      return sidePoint(box, port);
    };
    if (sourceMember && sourceMember !== source) points = [leg(source, sourceMember, points[0], true), ...points];
    if (targetMember && targetMember !== target) points = [...points, leg(target, targetMember, points[points.length - 1], false)];
    points = simplify(points);
    if (!sourceMember && !targetMember) points = dropJogs(points, boxAt(source), boxAt(target));
    routes[layoutEdge.id] = {
      points: avoidTitles(points, titles),
      ...(labelAt ? { label: labelAt } : {}),
      from: finalAbsolute(from),
      to: finalAbsolute(to),
    };
  }
  for (const ends of bundles.values()) if (ends.length > 1) fanOut(ends, routes);
  // Routes inside a separately laid-out group move with it.
  for (const [group, own] of separate) {
    const g = finalAbsolute(group);
    const move = (p: Point) => ({ x: p.x + g.x + own.offset.x, y: p.y + g.y + own.offset.y });
    for (const [id, route] of Object.entries(own.level.routes)) {
      routes[id] = { points: route.points.map(move), ...(route.label ? { label: move(route.label) } : {}), from: move(route.from), to: move(route.to) };
    }
  }
  return { nodes: boxes, routes, unmoved, mirrored };
}

/** Reverses every list ELK reads model order from: the children of each container, and the edges. */
function reverseOrder(roots: ElkNode[], edges: ElkExtendedEdge[]) {
  const reverse = (nodes: ElkNode[]) => {
    nodes.reverse();
    for (const n of nodes) if (n.children) reverse(n.children);
  };
  reverse(roots);
  edges.reverse();
}

/** Turns ELK's result over across `axis` (x: left for right), in place: nodes, ports, edge routes and labels. */
function mirrorLayout(root: ElkNode, axis: 'x' | 'y') {
  const dim = axis === 'x' ? 'width' : 'height';
  const span = (n: { width?: number; height?: number }) => n[dim] ?? 0;
  const containers = new Map<string, ElkNode>([[root.id, root]]);
  const flip = (node: ElkNode) => {
    for (const c of node.children ?? []) {
      c[axis] = span(node) - (c[axis] ?? 0) - span(c);
      containers.set(c.id, c);
      flip(c);
    }
    for (const p of node.ports ?? []) p[axis] = span(node) - (p[axis] ?? 0) - span(p);
  };
  flip(root);
  for (const e of (root.edges ?? []) as (ElkExtendedEdge & { container?: string })[]) {
    const size = span(containers.get(e.container ?? root.id) ?? root);
    for (const sec of e.sections ?? []) for (const p of [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint]) p[axis] = size - p[axis];
    for (const l of e.labels ?? []) l[axis] = size - (l[axis] ?? 0) - span(l);
  }
}

/** How far apart edges that share a port meet their member, at most, and how far before it they part. */
const FAN_STEP = 24;
const FAN_LENGTH = 16;

/**
 * Edges into (or out of) one member of a separately laid-out group share the
 * group's port, so they would all meet the member in one point. Just before
 * the member they part, side by side along its border, ordered by where
 * their other ends are so they do not cross.
 */
function fanOut(ends: { id: string; atStart: boolean; box: Box }[], routes: Record<string, EdgeRoute>) {
  const near = (route: EdgeRoute, atStart: boolean) => (atStart ? route.points[0] : route.points[route.points.length - 1]);
  const far = (route: EdgeRoute, atStart: boolean) => (atStart ? route.points[route.points.length - 1] : route.points[0]);
  const live = ends.filter((e) => routes[e.id]?.points.length >= 2);
  if (live.length < 2) return;
  const box = live[0].box;
  const end = near(routes[live[0].id], live[0].atStart);
  // Along the side the edges meet: x on the top or bottom, y on the left or right.
  const axis: 'x' | 'y' = Math.abs(end.y - box.y) < 0.5 || Math.abs(end.y - box.y - box.height) < 0.5 ? 'x' : 'y';
  const other: 'x' | 'y' = axis === 'x' ? 'y' : 'x';
  const span = axis === 'x' ? box.width : box.height;
  const step = Math.min(FAN_STEP, span / (live.length + 1));
  live.sort((a, b) => far(routes[a.id], a.atStart)[axis] - far(routes[b.id], b.atStart)[axis]);
  live.forEach((e, i) => {
    const offset = (i - (live.length - 1) / 2) * step;
    if (Math.abs(offset) < 0.5) return;
    const route = routes[e.id];
    const points = e.atStart ? [...route.points].reverse() : [...route.points];
    const last = points[points.length - 1];
    const before = points[points.length - 2];
    // The last leg must run straight into the side for there to be room to step over.
    if (Math.abs(before[axis] - last[axis]) > 0.5) return;
    const room = last[other] - before[other];
    const turn = last[other] - Math.sign(room) * Math.min(FAN_LENGTH, Math.abs(room) / 2);
    const at = (a: number, o: number): Point => (axis === 'x' ? { x: a, y: o } : { x: o, y: a });
    points.splice(points.length - 1, 1, at(last[axis], turn), at(last[axis] + offset, turn), at(last[axis] + offset, last[other]));
    route.points = simplify(e.atStart ? points.reverse() : points);
  });
}

/** Absolute boxes of a layout whose members are placed relative to their group. */
function absoluteBoxes(boxes: LaidOutNode[]): Map<string, Box> {
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const out = new Map<string, Box>();
  const at = (b: LaidOutNode): Point => {
    const parent = b.parent ? byId.get(b.parent) : undefined;
    const origin = parent ? at(parent) : { x: 0, y: 0 };
    return { x: origin.x + b.position.x, y: origin.y + b.position.y };
  };
  for (const b of boxes) out.set(b.id, { ...at(b), width: b.width, height: b.height });
  return out;
}

/** The point on `box`'s border straight across from `port`, on the side facing it. */
function sidePoint(box: Box, port: Point): Point {
  const cx = Math.min(Math.max(port.x, box.x), box.x + box.width);
  const cy = Math.min(Math.max(port.y, box.y), box.y + box.height);
  if (port.y <= box.y) return { x: cx, y: box.y };
  if (port.y >= box.y + box.height) return { x: cx, y: box.y + box.height };
  if (port.x <= box.x) return { x: box.x, y: cy };
  return { x: box.x + box.width, y: cy };
}

const IN_SIDE: Record<LayoutDirection, Side> = { DOWN: 'NORTH', UP: 'SOUTH', RIGHT: 'WEST', LEFT: 'EAST' };
const OPPOSITE: Record<Side, Side> = { NORTH: 'SOUTH', SOUTH: 'NORTH', WEST: 'EAST', EAST: 'WEST' };
const ACROSS: Record<Side, Side[]> = { NORTH: ['WEST', 'EAST'], SOUTH: ['WEST', 'EAST'], WEST: ['NORTH', 'SOUTH'], EAST: ['NORTH', 'SOUTH'] };

/**
 * Gives every edge end on a separately laid-out group a fixed port on the
 * group's border, straight across from the member it really ends at: on the
 * side the flow comes in from (targets) or leaves by (sources), else another
 * side whose way in is not blocked by another member. Returns the port id by
 * `<edge id>\0source|target`.
 */
function attachPorts(edges: LayoutEdge[], separate: Map<string, Separate>, elkNodes: Map<string, ElkNode>, flow: LayoutDirection): Map<string, string> {
  const ids = new Map<string, string>();
  const shared = new Map<string, string>();
  const portFor = (group: string, member: string, role: 'source' | 'target') => {
    const own = separate.get(group)!;
    const preferred = role === 'target' ? IN_SIDE[flow] : OPPOSITE[IN_SIDE[flow]];
    const box = own.members.get(member) ?? { x: 0, y: 0, width: own.width, height: own.height };
    const others = own.leaves.filter((b) => b.id !== member);
    const clear = (side: Side) => !others.some((o) => blocks(o, box, side, own));
    const side = member === group ? preferred : ([preferred, ...ACROSS[preferred], OPPOSITE[preferred]].find(clear) ?? preferred);
    const key = `${group}\u0000${member}\u0000${side}`;
    let id = shared.get(key);
    if (!id) {
      id = `${group}\u0000port${shared.size}`;
      shared.set(key, id);
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const at = side === 'NORTH' ? { x: cx, y: 0 } : side === 'SOUTH' ? { x: cx, y: own.height } : side === 'WEST' ? { x: 0, y: cy } : { x: own.width, y: cy };
      elkNodes.get(group)!.ports!.push({ id, ...at, width: 0, height: 0, layoutOptions: { 'elk.port.side': side } });
    }
    return id;
  };
  for (const e of edges) {
    if (e.sourceMember !== undefined) ids.set(`${e.id}\u0000source`, portFor(e.source, e.sourceMember, 'source'));
    if (e.targetMember !== undefined) ids.set(`${e.id}\u0000target`, portFor(e.target, e.targetMember, 'target'));
  }
  return ids;
}

/** `other` stands between `box` and the group's `side` border. */
function blocks(other: Box, box: Box, side: Side, group: { width: number; height: number }): boolean {
  const overlapX = other.x < box.x + box.width / 2 && box.x + box.width / 2 < other.x + other.width;
  const overlapY = other.y < box.y + box.height / 2 && box.y + box.height / 2 < other.y + other.height;
  switch (side) {
    case 'NORTH':
      return overlapX && other.y < box.y && other.y + other.height > 0;
    case 'SOUTH':
      return overlapX && other.y + other.height > box.y + box.height && other.y < group.height;
    case 'WEST':
      return overlapY && other.x < box.x;
    case 'EAST':
      return overlapY && other.x + other.width > box.x + box.width;
  }
}

/** Positions far enough apart that ELK's interactive layering reads each layer as its own. */
const LAYER_STEP = 100_000;

/**
 * `rank` hints. In every container (the top level, or a group) where a child
 * has a rank, the children's layers are computed here and handed to ELK's
 * interactive layering as positions: children of one rank share a layer, a
 * lower rank sits higher (in the flow's direction), `first` and `last` are
 * the outermost layers, and the unranked children go where their edges pull
 * them. An edge that would run against these layers is reversed (and its
 * route turned back afterwards). Returns the containers laid out this way
 * (undefined for the top level).
 */
function rankLayers(
  nodes: DiagramNode[],
  edges: LayoutEdge[],
  reversed: Set<string>,
  elkNodes: Map<string, ElkNode>,
  roots: ElkNode[],
  parentOf: (id: string) => string | undefined,
  flow: LayoutDirection,
): Set<string | undefined> {
  const sign = flow === 'UP' || flow === 'LEFT' ? -1 : 1;
  const place = (node: ElkNode, layer: number, i: number) =>
    Object.assign(node, flow === 'DOWN' || flow === 'UP' ? { x: i, y: layer * LAYER_STEP * sign } : { x: layer * LAYER_STEP * sign, y: i });
  const containers = new Set(nodes.filter((n) => n.rank !== undefined).map((n) => parentOf(n.id)));
  const rankOf = new Map(nodes.map((n) => [n.id, n.rank]));
  for (const container of containers) {
    const children = nodes.filter((n) => parentOf(n.id) === container).map((n) => n.id);
    const childOf = (id: string): string | undefined => {
      for (let a: string | undefined = id; a !== undefined; a = parentOf(a)) if (parentOf(a) === container) return a;
      return undefined;
    };
    const links = edges.flatMap((e) => {
      const [a, b] = [childOf(e.source), childOf(e.target)];
      return a !== undefined && b !== undefined && a !== b ? [{ edge: e, a, b }] : [];
    });
    const layers = assignLayers(children, links.map((l): Link => [l.a, l.b, l.edge.labels?.length ? 2 : 1]), (id) => rankOf.get(id));
    for (const { edge, a, b } of links) {
      if (layers.get(a)! <= layers.get(b)!) continue;
      flipEdge(edge);
      if (reversed.has(edge.id)) reversed.delete(edge.id);
      else reversed.add(edge.id);
    }
    children.forEach((id, i) => place(elkNodes.get(id)!, layers.get(id)!, i));
    // ELK turns a centred label into a node of its own before layering, which
    // interactive layering cannot place. A real stand-in node is placed here instead,
    // in a layer between the ends (labelled edges span two at least, as in ELK), and the
    // edge runs through it. It comes right after the edge's upper end in model order.
    const siblings = container === undefined ? roots : elkNodes.get(container)!.children!;
    for (const { edge, a, b } of links) {
      const label = edge.labels?.[0];
      delete edge.labels;
      const [top, bottom] = [Math.min(layers.get(a)!, layers.get(b)!), Math.max(layers.get(a)!, layers.get(b)!)];
      // Without a layer between its ends (a rank held it close), the label goes on the line, without room kept for it.
      if (!label || bottom - top < 2) continue;
      const id = `${edge.id}\u0000label`;
      const [width, height] = [label.width ?? 0, label.height ?? 0];
      const inSide = IN_SIDE[flow];
      const at = (side: Side) => (side === 'NORTH' ? { x: width / 2, y: 0 } : side === 'SOUTH' ? { x: width / 2, y: height } : side === 'WEST' ? { x: 0, y: height / 2 } : { x: width, y: height / 2 });
      const stand: ElkNode = {
        id,
        width,
        height,
        layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
        ports: [
          { id: `${id}\u0000in`, ...at(inSide), width: 0, height: 0, layoutOptions: { 'elk.port.side': inSide } },
          { id: `${id}\u0000out`, ...at(OPPOSITE[inSide]), width: 0, height: 0, layoutOptions: { 'elk.port.side': OPPOSITE[inSide] } },
        ],
      };
      place(stand, top + Math.floor((bottom - top) / 2), siblings.length);
      siblings.splice(siblings.indexOf(elkNodes.get(layers.get(a)! < layers.get(b)! ? a : b)!) + 1, 0, stand);
      elkNodes.set(id, stand);
      edge.via = id;
    }
    if (container !== undefined) elkNodes.get(container)!.layoutOptions = { ...elkNodes.get(container)!.layoutOptions, ...INTERACTIVE_LAYERING };
  }
  return containers;
}

const INTERACTIVE_LAYERING = { 'elk.layered.layering.strategy': 'INTERACTIVE' };

function reachable(succ: Map<string, Set<string>>, from: string, to: string): boolean {
  const seen = new Set([from]);
  const stack = [from];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === to) return true;
    for (const next of succ.get(id) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

/**
 * Network simplex layering (Gansner et al., "A Technique for Drawing Directed
 * Graphs", as in ELK's default layering): moves the layers in `layer`, a
 * feasible start, to where the weighted edge lengths in total are smallest
 * while every edge spans at least its `minlen`.
 */
function networkSimplex(nodes: string[], edges: { u: string; v: string; minlen: number; weight: number }[], layer: Map<string, number>) {
  const slack = (e: (typeof edges)[number]) => layer.get(e.v)! - layer.get(e.u)! - e.minlen;
  const incident = new Map(nodes.map((n) => [n, [] as number[]]));
  edges.forEach((e, i) => {
    incident.get(e.u)!.push(i);
    incident.get(e.v)!.push(i);
  });
  const other = (i: number, n: string) => (edges[i].u === n ? edges[i].v : edges[i].u);
  const done = new Set<string>();
  for (const start of nodes) {
    if (done.has(start)) continue;
    // A spanning tree of tight edges for start's component, shifting the tree onto the nearest edge.
    const inTree = new Set([start]);
    const tree = new Set<number>();
    const grow = () => {
      for (let changed = true; changed; ) {
        changed = false;
        for (const n of [...inTree]) {
          for (const i of incident.get(n)!) {
            const m = other(i, n);
            if (!inTree.has(m) && slack(edges[i]) === 0) {
              inTree.add(m);
              tree.add(i);
              changed = true;
            }
          }
        }
      }
    };
    grow();
    for (;;) {
      let best = -1;
      for (const n of inTree) for (const i of incident.get(n)!) if (!inTree.has(other(i, n)) && (best < 0 || slack(edges[i]) < slack(edges[best]))) best = i;
      if (best < 0) break;
      const delta = inTree.has(edges[best].u) ? slack(edges[best]) : -slack(edges[best]);
      for (const n of inTree) layer.set(n, layer.get(n)! + delta);
      grow();
    }
    for (const n of inTree) done.add(n);
    if (tree.size === 0) continue;

    // The tail side of a tree edge: what stays connected to its `u` without it.
    const tailSide = (cut: number) => {
      const side = new Set([edges[cut].u]);
      const stack = [edges[cut].u];
      while (stack.length) {
        const n = stack.pop()!;
        for (const i of incident.get(n)!) {
          if (i === cut || !tree.has(i)) continue;
          const m = other(i, n);
          if (!side.has(m)) {
            side.add(m);
            stack.push(m);
          }
        }
      }
      return side;
    };
    const component = [...inTree];
    for (let round = 0; round < 10 * component.length + 100; round++) {
      let leave = -1;
      let tail = new Set<string>();
      for (const t of tree) {
        const side = tailSide(t);
        let cut = 0;
        for (const n of component) {
          for (const i of incident.get(n)!) {
            if (edges[i].u !== n) continue;
            const [fromTail, toTail] = [side.has(edges[i].u), side.has(edges[i].v)];
            if (fromTail && !toTail) cut += edges[i].weight;
            else if (!fromTail && toTail) cut -= edges[i].weight;
          }
        }
        if (cut < 0) {
          leave = t;
          tail = side;
          break;
        }
      }
      if (leave < 0) break;
      let enter = -1;
      for (const n of component) {
        for (const i of incident.get(n)!) {
          if (edges[i].u !== n || tree.has(i)) continue;
          if (!tail.has(edges[i].u) && tail.has(edges[i].v) && (enter < 0 || slack(edges[i]) < slack(edges[enter]))) enter = i;
        }
      }
      if (enter < 0) break;
      // Moving the tail side makes the entering edge tight.
      const delta = slack(edges[enter]);
      for (const n of tail) layer.set(n, layer.get(n)! + delta);
      tree.delete(leave);
      tree.add(enter);
    }
  }
}

/** An edge between two children of a container, and how many layers it spans at least: 2 with a label, which takes a layer of its own. */
type Link = [from: string, to: string, length: number];

/** How far down its rank each member goes: the longest path to it over edges among the members (in declaration order, skipping those that close a cycle). */
function depthsWithin(members: string[], links: Link[]): Map<string, number> {
  const inside = new Set(members);
  const succ = new Map(members.map((m) => [m, new Set<string>()]));
  const length = new Map<string, number>();
  for (const [a, b, len] of links) {
    if (inside.has(a) && inside.has(b) && a !== b && !reachable(succ, b, a)) {
      succ.get(a)!.add(b);
      length.set(`${a}\u0000${b}`, Math.max(len, length.get(`${a}\u0000${b}`) ?? 1));
    }
  }
  const depth = new Map(members.map((m) => [m, 0]));
  // At most members.length rounds: the graph is acyclic.
  for (let round = 0, changed = true; changed && round < members.length; round++) {
    changed = false;
    for (const [a, next] of succ) {
      for (const b of next) {
        const step = length.get(`${a}\u0000${b}`)!;
        if (depth.get(b)! < depth.get(a)! + step) {
          depth.set(b, depth.get(a)! + step);
          changed = true;
        }
      }
    }
  }
  return depth;
}

/**
 * Layers for the children of one container: ranks first (in order, `first`
 * above and `last` below everything; see depthsWithin), then each edge in
 * declaration order unless it would close a cycle, a labelled one two layers
 * long; laid out longest-path, then by network simplex, so that without ranks
 * the layers are about what ELK's own layering would choose.
 */
export function assignLayers(children: string[], links: Link[], rankOf: (id: string) => Rank | undefined): Map<string, number> {
  const key = (r: Rank) => (r === 'first' ? -Infinity : r === 'last' ? Infinity : r);
  // ELK cannot draw an edge within a layer, so of two connected nodes of one
  // rank the target goes a layer lower: a rank is a run of layers, one per depth.
  const unitOf = new Map<string, string>();
  const chain: { unit: string; key: number }[] = [];
  const keys = [...new Set(children.map(rankOf).filter((r): r is Rank => r !== undefined).map(key))].sort((a, b) => a - b);
  for (const k of keys) {
    const members = children.filter((c) => rankOf(c) !== undefined && key(rankOf(c)!) === k);
    const depth = depthsWithin(members, links);
    const deepest = Math.max(...depth.values());
    for (let d = 0; d <= deepest; d++) chain.push({ unit: `\u0000rank ${k} ${d}`, key: k });
    for (const m of members) unitOf.set(m, `\u0000rank ${k} ${depth.get(m)}`);
  }
  for (const c of children) if (!unitOf.has(c)) unitOf.set(c, c);
  const units = [...new Set([...chain.map((c) => c.unit), ...unitOf.values()])];
  const succ = new Map(units.map((u) => [u, new Set<string>()]));
  const pred = new Map(units.map((u) => [u, new Set<string>()]));
  /** How many layers apart the ends of each constraint must at least be. */
  const minlen = new Map<string, number>();
  const gap = (a: string, b: string) => minlen.get(`${a}\u0000${b}`) ?? 1;
  const add = (a: string, b: string, length = 1) => {
    succ.get(a)!.add(b);
    pred.get(b)!.add(a);
    minlen.set(`${a}\u0000${b}`, Math.max(length, gap(a, b)));
  };
  const reaches = (from: string, to: string) => reachable(succ, from, to);

  chain.slice(1).forEach((c, i) => add(chain[i].unit, c.unit));
  const firsts = chain.filter((c) => c.key === -Infinity).map((c) => c.unit);
  const lasts = chain.filter((c) => c.key === Infinity).map((c) => c.unit);
  for (const u of units) {
    if (firsts.length && !firsts.includes(u)) add(firsts[firsts.length - 1], u);
    if (lasts.length && !lasts.includes(u) && !firsts.includes(u)) add(u, lasts[0]);
  }

  /** Real edges per constraint; the rank chain only spaces layers and weighs nothing. */
  const weight = new Map<string, number>();
  for (const [a, b, length] of links) {
    const [ua, ub] = [unitOf.get(a)!, unitOf.get(b)!];
    if (ua === ub || (!succ.get(ua)!.has(ub) && reaches(ub, ua))) continue;
    add(ua, ub, length);
    weight.set(`${ua}\u0000${ub}`, (weight.get(`${ua}\u0000${ub}`) ?? 0) + 1);
  }

  // Longest path from the top, in topological order.
  const layer = new Map<string, number>();
  const waiting = new Map(units.map((u) => [u, pred.get(u)!.size]));
  const ready = units.filter((u) => waiting.get(u) === 0);
  while (ready.length) {
    const u = ready.shift()!;
    layer.set(u, Math.max(0, ...[...pred.get(u)!].map((p) => layer.get(p)! + gap(p, u))));
    for (const s of succ.get(u)!) {
      waiting.set(s, waiting.get(s)! - 1);
      if (waiting.get(s) === 0) ready.push(s);
    }
  }

  const constraints = units.flatMap((u) => [...succ.get(u)!].map((v) => ({ u, v, minlen: gap(u, v), weight: weight.get(`${u}\u0000${v}`) ?? 0 })));
  networkSimplex(units, constraints, layer);

  const top = Math.min(...layer.values());
  return new Map(children.map((c) => [c, layer.get(unitOf.get(c)!)! - top]));
}

function flipEdge(e: LayoutEdge) {
  [e.source, e.target] = [e.target, e.source];
  [e.sourceMember, e.targetMember] = [e.targetMember, e.sourceMember];
  if (e.sourceMember === undefined) delete e.sourceMember;
  if (e.targetMember === undefined) delete e.targetMember;
}

/**
 * Breaks cycles by declaration order before ELK sees them: an edge that closes
 * a cycle and points at a node declared earlier is handed to ELK reversed, so
 * the node declared first sits higher and the edge is routed as a short hop up
 * instead of ELK's own feedback routing, which loops around whole groups when
 * the edge crosses them. Edges outside cycles keep their direction whatever
 * the order, unless `ordered` (`layout ordered`) turns every edge that points
 * at an earlier node. Returns the ids of the reversed edges; their routes are
 * turned back afterwards.
 */
function orientEdges(edges: LayoutEdge[], order: Map<string, number>, ordered: boolean): Set<string> {
  const out = new Map<string, string[]>();
  for (const e of edges) out.set(e.source, [...(out.get(e.source) ?? []), e.target]);
  const reaches = (from: string, to: string) => {
    const seen = new Set([from]);
    const stack = [from];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === to) return true;
      for (const next of out.get(id) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return false;
  };
  const reversed = new Set<string>();
  for (const e of edges) {
    if ((order.get(e.target) ?? 0) < (order.get(e.source) ?? 0) && (ordered || reaches(e.target, e.source))) reversed.add(e.id);
  }
  for (const e of edges) if (reversed.has(e.id)) flipEdge(e);
  return reversed;
}

/** The sections of a routed edge joined into one polyline. */
function sectionPoints(sections: ElkEdgeSection[]): Point[] {
  const points: Point[] = [];
  for (const s of sections) {
    for (const p of [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]) {
      const last = points[points.length - 1];
      if (!last || last.x !== p.x || last.y !== p.y) points.push({ x: p.x, y: p.y });
    }
  }
  return points;
}

/** Drops points that do not turn (on a straight run), so every inner point is a bend. */
export function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    const a = out[out.length - 2];
    const b = out[out.length - 1];
    if (b && Math.abs(b.x - p.x) < 0.01 && Math.abs(b.y - p.y) < 0.01) continue;
    if (a && b && Math.abs((b.x - a.x) * (p.y - b.y) - (b.y - a.y) * (p.x - b.x)) < 0.01) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

/**
 * ELK sometimes ends a route with a jog of a few pixels just before a node
 * (where ports are spread out); slide that last (or first) leg over so the
 * line runs straight in, as long as it still meets the node's side.
 */
function dropJogs(points: Point[], source: Box, target: Box): Point[] {
  const JOG = 10;
  const MARGIN = 6;
  const fix = (pts: Point[], box: Box): Point[] => {
    const n = pts.length;
    if (n < 4) return pts;
    const [a, b, c, d] = pts.slice(n - 4);
    const vertical = Math.abs(c.x - d.x) < 0.5 && Math.abs(a.x - b.x) < 0.5 && Math.abs(b.y - c.y) < 0.5;
    const horizontal = Math.abs(c.y - d.y) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(b.x - c.x) < 0.5;
    if (vertical && Math.abs(b.x - c.x) < JOG && b.x > box.x + MARGIN && b.x < box.x + box.width - MARGIN) {
      return simplify([...pts.slice(0, n - 3), { x: b.x, y: d.y }]);
    }
    if (horizontal && Math.abs(b.y - c.y) < JOG && b.y > box.y + MARGIN && b.y < box.y + box.height - MARGIN) {
      return simplify([...pts.slice(0, n - 3), { x: d.x, y: b.y }]);
    }
    return pts;
  };
  return fix(fix(points, target).reverse(), source).reverse();
}

type Box = Point & { width: number; height: number };

/** Where a group draws its name (GroupNode: icon, then the name in 12px bold capitals), plus a few px; the right edge is for edges to step around it. */
interface TitleBand {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Inside the group's right border, where a detour must stay left of. */
  limit: number;
}

function titleBand(group: Box, name: string): TitleBand {
  return { x0: group.x + 8, x1: group.x + 40 + name.length * 11, y0: group.y, y1: group.y + 36, limit: group.x + group.width - 12 };
}

/**
 * ELK routes an edge into a group straight down through its top padding, so
 * it can strike through the group's name. A vertical leg that crosses a name
 * steps right around it, just above the group's border, and back.
 */
function avoidTitles(points: Point[], bands: TitleBand[]): Point[] {
  let out = points;
  for (const band of bands) {
    const next: Point[] = [out[0]];
    for (let i = 1; i < out.length; i++) {
      const [p, q] = [out[i - 1], out[i]];
      const top = Math.min(p.y, q.y);
      const bottom = Math.max(p.y, q.y);
      const xr = band.x1 + 12;
      const crosses = Math.abs(p.x - q.x) < 0.5 && p.x > band.x0 && p.x < band.x1 && top < band.y0 - 10 && bottom > band.y1 + 14 && xr < band.limit;
      if (crosses) {
        const above = band.y0 - 10;
        const below = band.y1 + 4;
        const detour = [
          { x: p.x, y: above },
          { x: xr, y: above },
          { x: xr, y: below },
          { x: p.x, y: below },
        ];
        next.push(...(q.y > p.y ? detour : detour.reverse()));
      }
      next.push(q);
    }
    out = next;
  }
  return out === points ? points : simplify(out);
}

/**
 * ELK sizes groups for its own placement; members pinned with `pos` can sit
 * outside that box, so grow each group (innermost first) until it contains them.
 */
function growGroupsAroundMembers(boxes: LaidOutNode[], byId: Map<string, DiagramNode>) {
  const depth = (b: LaidOutNode): number => {
    const parent = boxes.find((p) => p.id === b.parent);
    return parent ? depth(parent) + 1 : 0;
  };
  const groups = boxes.filter((b) => byId.get(b.id)?.kind === 'group').sort((a, b) => depth(b) - depth(a));
  for (const group of groups) {
    for (const member of boxes.filter((b) => b.parent === group.id)) {
      group.width = Math.max(group.width, member.position.x + member.width + GROUP_MARGIN);
      group.height = Math.max(group.height, member.position.y + member.height + GROUP_MARGIN);
    }
  }
}

function isAncestor(byId: Map<string, DiagramNode>, ancestor: string, id: string): boolean {
  for (let p = byId.get(id)?.parent; p; p = byId.get(p)?.parent) {
    if (p === ancestor) return true;
  }
  return false;
}
