import { kindOf } from './kinds';
import type { Diagram, DiagramEdge, DiagramNode, DiagramScenario, DiagramStep, DiagramSystem, DiagramUseCase } from './types';

/**
 * What to show of a diagram's systems (docs/design/team-systems-and-imports.md D6).
 * Ids are namespaced paths: `orders` is a system of the diagram, `orders.wh`
 * a system inside the Orders team file.
 */
export interface ViewOptions {
  /** Systems drawn open, as a frame around their team design; the others are one box. */
  expanded?: ReadonlySet<string>;
  /** Show only this system's team design, as its own document (navigating into it). */
  focus?: string;
}

/** The frame of an expanded system is drawn as a group of this style. */
const FRAME_TECH = 'Service Group';

/**
 * A layout-ready diagram for the given view. Collapsed systems stay nodes of
 * kind `system`, with edges and steps ending at the box. An expanded system
 * becomes a `group` frame (`system` set to its id) holding its team design
 * under namespaced ids (`orders.db`); edges and steps to one of its entry
 * points are rerouted to where the mapped use case starts (see
 * `entryRouter`), and its use cases are added under namespaced ids. The team's
 * traffic, requirements and other sections stay in its own scope.
 *
 * With `focus`, the result is that system's team design itself, with its own
 * ids, title and layout, and its nested systems expanded as `expanded` says
 * (relative to the focused one). An unknown focus, or a system without a team
 * file, shows the whole diagram.
 */
export function viewDiagram(diagram: Diagram, options: ViewOptions = {}): Diagram {
  const expanded = options.expanded ?? new Set<string>();
  if (options.focus !== undefined) {
    const team = systemAt(diagram, options.focus);
    if (team?.diagram) {
      const prefix = `${options.focus}.`;
      const inner = new Set([...expanded].filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length)));
      return viewDiagram(team.diagram, { expanded: inner });
    }
  }
  const open = (diagram.systems ?? []).filter((s) => s.diagram && expanded.has(s.id));
  if (open.length === 0) return diagram;

  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const useCases: DiagramUseCase[] = [];
  const route = entryRouter(diagram, expanded, '');
  const openIds = new Set(open.map((s) => s.id));
  for (const node of diagram.nodes) {
    if (!openIds.has(node.id)) {
      nodes.push(node);
      continue;
    }
    nodes.push(frameOf(node, node.id));
    const system = open.find((s) => s.id === node.id)!;
    inline(system.diagram!, `${node.id}.`, node, expanded, nodes, edges, useCases);
  }
  for (const edge of diagram.edges) edges.push(rerouteEdge(edge, route));
  return { ...diagram, nodes, edges, useCases: [...diagram.useCases.map((u) => rerouteUseCase(u, route)), ...useCases] };
}

/** The system at a namespaced path. */
function systemAt(diagram: Diagram, path: string): DiagramSystem | undefined {
  const [head, ...rest] = path.split('.');
  const system = diagram.systems?.find((s) => s.id === head);
  if (!system || rest.length === 0) return system;
  return system.diagram ? systemAt(system.diagram, rest.join('.')) : undefined;
}

const frameOf = (node: DiagramNode, id: string): DiagramNode => ({ ...node, id, kind: 'group', type: 'group', techStack: FRAME_TECH, system: id });

/** Adds a team design's nodes, edges and use cases under `prefix`, inside the frame `owner`. */
function inline(team: Diagram, prefix: string, owner: DiagramNode, expanded: ReadonlySet<string>, nodes: DiagramNode[], edges: DiagramEdge[], useCases: DiagramUseCase[]) {
  const ownerId = prefix.slice(0, -1);
  const route = entryRouter(team, expanded, prefix);
  for (const node of team.nodes) {
    const id = prefix + node.id;
    const parent = node.parent !== undefined ? prefix + node.parent : ownerId;
    const system = team.systems?.find((s) => s.id === node.id);
    if (system?.diagram && expanded.has(id)) {
      nodes.push({ ...frameOf(node, id), parent });
      inline(system.diagram, `${id}.`, node, expanded, nodes, edges, useCases);
    } else {
      // A position is relative to the team's own canvas, so the layout places the node instead.
      const { position: _position, ...rest } = node;
      void _position;
      nodes.push({ ...rest, id, parent, system: ownerId });
    }
  }
  for (const edge of team.edges) edges.push(rerouteEdge({ ...edge, id: prefix + edge.id, source: prefix + edge.source, target: prefix + edge.target }, route));
  for (const u of team.useCases) {
    const named: DiagramUseCase = { ...u, id: prefix + u.id, name: `${owner.name}: ${u.name}`, entryServiceId: u.entryServiceId !== undefined ? prefix + u.entryServiceId : undefined };
    useCases.push(rerouteUseCase(prefixUseCase(named, prefix), route));
  }
}

function prefixUseCase(u: DiagramUseCase, prefix: string): DiagramUseCase {
  const step = (s: DiagramStep): DiagramStep => ({ ...s, ...(s.id !== undefined ? { id: prefix + s.id } : {}), fromServiceId: prefix + s.fromServiceId, toServiceId: prefix + s.toServiceId });
  const scenarios = u.scenarios.map((sc): DiagramScenario => ({ ...sc, steps: sc.steps.map(step) }));
  return { ...u, steps: scenarios[0]?.steps ?? [], scenarios };
}

/**
 * Where an edge or step to entry point `port` of system `id` (both namespaced)
 * ends: the box itself when the system is collapsed, else where the mapped
 * use case starts: the sender of its first request, or its receiver when the
 * sender is a client (the team file's stand-in for whoever calls it),
 * followed into nested expanded systems.
 */
type Router = (id: string, port: string | undefined) => { id: string; port?: string };

function entryRouter(diagram: Diagram, expanded: ReadonlySet<string>, prefix: string): Router {
  const route: Router = (id, port) => {
    if (port === undefined || !expanded.has(id)) return { id, port };
    const local = id.slice(prefix.length);
    const system = diagram.systems?.find((s) => s.id === local);
    const entry = system?.entries.find((e) => e.id === port);
    const team = system?.diagram;
    const first = team?.useCases.find((u) => u.id === entry?.useCaseId)?.steps[0];
    if (!team || !first) return { id };
    const sender = team.nodes.find((n) => n.id === first.fromServiceId);
    if (sender && kindOf(sender) !== 'client') return { id: `${id}.${sender.id}` };
    return entryRouter(team, expanded, `${id}.`)(`${id}.${first.toServiceId}`, first.toPort);
  };
  return route;
}

function rerouteEdge(edge: DiagramEdge, route: Router): DiagramEdge {
  const { id: target, port } = route(edge.target, edge.targetPort);
  if (target === edge.target && port === edge.targetPort) return edge;
  const { targetPort: _targetPort, ...rest } = edge;
  void _targetPort;
  return { ...rest, target, ...(port !== undefined ? { targetPort: port } : {}) };
}

function rerouteUseCase(u: DiagramUseCase, route: Router): DiagramUseCase {
  let changed = false;
  const step = (s: DiagramStep): DiagramStep => {
    const { id, port } = route(s.toServiceId, s.toPort);
    if (id === s.toServiceId && port === s.toPort) return s;
    changed = true;
    const { toPort: _toPort, ...rest } = s;
    void _toPort;
    return { ...rest, toServiceId: id, ...(port !== undefined ? { toPort: port } : {}) };
  };
  const scenarios = u.scenarios.map((sc) => ({ ...sc, steps: sc.steps.map(step) }));
  return changed ? { ...u, steps: scenarios[0]?.steps ?? [], scenarios } : u;
}
