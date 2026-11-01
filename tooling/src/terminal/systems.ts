import { viewDiagram, type ViewOptions } from '../../../frontend/src/dsl/view';
import type { Diagram, DiagramSystem } from '../../../frontend/src/dsl/types';
import type { Analysis } from '../../../frontend/src/sim/analyze';
import { formatMs, formatRps } from '../../../frontend/src/sim/format';
import { analysisOverlay, type NodeOverlay, type SimOverlay } from '../../../frontend/src/sim/overlay';
import { contractOf, type SystemAnalysis } from '../../../frontend/src/sim/systems';
import { runTests } from '../../../frontend/src/sim/tests';

/**
 * Which systems a drawing opens, and what the drawing shows on them
 * (docs/design/team-systems-and-imports.md D3, D6): the CLI's `--expand` and
 * `--focus`, the plugin's system keys, and the promise, headroom and status
 * of each system box. Ids are namespaced paths from the root document
 * (`orders`, `orders.warehouse`), also under `focus`.
 */

/** A view as JSON carries it (the plugin's layout helper reads it from stdin). */
export interface SystemsView {
  expanded?: string[];
  focus?: string;
}

/** How a system box is drawn: ok, running hot, saturated by what it is sent, or breaking its SLA; idle when it has no contract to simulate. */
export type SystemStatus = 'ok' | 'hot' | 'saturated' | 'breach' | 'idle';

/** What a system box shows. */
export interface SystemBadge {
  team?: string;
  /** The team's promise: `p99 150 ms · 99.95%`; absent when it promises nothing. */
  promise?: string;
  /** What the rest of the diagram sends it, in rps. */
  sentRps: number;
  /** Extra rps it takes on top of its own traffic before a node saturates (the tightest entry point); Infinity when none does. */
  headroomRps: number;
  /** The busiest node's utilisation under what it is sent, 0..1+. */
  utilization?: number;
  status: SystemStatus;
}

/** A sim warning about a system, with the hint of its failing check. */
export interface SystemNote {
  system: string;
  text: string;
  hint?: string;
}

export interface ViewOverlay {
  /** Load per drawn node, by its id in the view. */
  nodes: Record<string, NodeOverlay>;
  /** Per system box or expanded frame, by its id in the view. */
  systems: Record<string, SystemBadge>;
  notes: SystemNote[];
}

/** The system at a namespaced path. */
export function systemAt(diagram: Diagram, path: string): DiagramSystem | undefined {
  const [head, ...rest] = path.split('.');
  const system = diagram.systems?.find((s) => s.id === head);
  if (!system || rest.length === 0) return system;
  return system.diagram ? systemAt(system.diagram, rest.join('.')) : undefined;
}

/** Every system path of a diagram, nested ones under their team's. */
export function systemPaths(diagram: Diagram, prefix = ''): string[] {
  return (diagram.systems ?? []).flatMap((s) => [prefix + s.id, ...(s.diagram ? systemPaths(s.diagram, `${prefix}${s.id}.`) : [])]);
}

/** Why a view cannot be drawn: an id that names no system, or one without a team design to open. */
export function viewError(diagram: Diagram, view: SystemsView): string | undefined {
  const known = systemPaths(diagram);
  const check = (id: string, what: string): string | undefined => {
    const system = systemAt(diagram, id);
    if (!system) return `No system '${id}' to ${what}; ${known.length ? `the systems are ${known.join(', ')}` : 'the diagram has no systems'}.`;
    if (!system.diagram) return `System '${id}' has no team design (from "…") to ${what}.`;
    return undefined;
  };
  for (const id of view.expanded ?? []) {
    const error = check(id, 'expand');
    if (error) return error;
  }
  return view.focus !== undefined ? check(view.focus, 'focus') : undefined;
}

/** The view for viewDiagram: each expanded system with the systems around it expanded too, so a nested one shows. */
export function viewOptions(view: SystemsView = {}): ViewOptions {
  const expanded = new Set<string>();
  for (const id of view.expanded ?? []) {
    const parts = id.split('.');
    for (let i = 1; i <= parts.length; i++) expanded.add(parts.slice(0, i).join('.'));
  }
  return { expanded, ...(view.focus !== undefined ? { focus: view.focus } : {}) };
}

/** The diagram as the view draws it. */
export function applyView(diagram: Diagram, view: SystemsView = {}): Diagram {
  return view.focus === undefined && !view.expanded?.length ? diagram : viewDiagram(diagram, viewOptions(view));
}

/** `a,b`: a comma-separated list of ids, empty ones dropped. */
export const idList = (value: string) => value.split(',').map((s) => s.trim()).filter(Boolean);

/**
 * The simulation on a view: the load of each drawn node, a badge per system,
 * and the sim's warnings about systems. A team's nodes carry the team
 * design's analysis under what it is sent (or under its own traffic, when the
 * root document has none).
 */
export function viewOverlay(diagram: Diagram, analysis: Analysis | undefined, view: SystemsView = {}): ViewOverlay {
  const out: ViewOverlay = { nodes: {}, systems: {}, notes: [] };
  const { expanded } = viewOptions(view);
  let scope = diagram;
  let scoped = analysis;
  let load = analysis ? analysisOverlay(diagram, analysis) : undefined;
  let path = '';
  if (view.focus !== undefined && systemAt(diagram, view.focus)?.diagram) {
    for (const id of view.focus.split('.')) {
      const system = scope.systems!.find((s) => s.id === id)!;
      const result = scoped?.systems?.find((s) => s.id === id);
      // Focused into a system, what is said about it still shows: the cause is outside it.
      if (path + id === view.focus) notesOf(scope, scoped, system, result, path, out);
      scoped = teamAnalysis(system, result);
      load = teamLoad(system, result, scoped);
      scope = system.diagram!;
      path += `${id}.`;
    }
  }
  collect(scope, scoped, load, '', path, expanded!, out);
  return out;
}

function teamAnalysis(system: DiagramSystem, result: SystemAnalysis | undefined): Analysis | undefined {
  return result?.analysis ?? (system.diagram ? contractOf(system).baseline : undefined);
}

/** The load on a team's nodes: under what it is sent, with the flows that carry it there; else under its own traffic. */
function teamLoad(system: DiagramSystem, result: SystemAnalysis | undefined, analysis: Analysis | undefined): SimOverlay | undefined {
  return result?.overlay ?? (analysis && system.diagram ? analysisOverlay(system.diagram, analysis) : undefined);
}

function collect(diagram: Diagram, analysis: Analysis | undefined, load: SimOverlay | undefined, at: string, path: string, expanded: ReadonlySet<string>, out: ViewOverlay): void {
  for (const [id, o] of Object.entries(load?.nodes ?? {})) out.nodes[at + id] = o;
  for (const system of diagram.systems ?? []) {
    const result = analysis?.systems?.find((s) => s.id === system.id);
    out.systems[at + system.id] = badgeOf(diagram, system, result);
    notesOf(diagram, analysis, system, result, path, out);
    if (system.diagram && expanded.has(path + system.id)) {
      const team = teamAnalysis(system, result);
      collect(system.diagram, team, teamLoad(system, result, team), `${at}${system.id}.`, `${path}${system.id}.`, expanded, out);
    }
  }
}

/** The sim's warnings about a system, the hint of its failing check after the last of them. */
function notesOf(diagram: Diagram, analysis: Analysis | undefined, system: DiagramSystem, result: SystemAnalysis | undefined, path: string, out: ViewOverlay): void {
  const warnings = result?.warnings ?? [];
  if (!analysis || warnings.length === 0) return;
  const hint = runTests(diagram, analysis).find((t) => t.id === `system:${system.id}` && !t.passed)?.hint;
  warnings.forEach((text, i) => out.notes.push({ system: path + system.id, text, ...(hint && i === warnings.length - 1 ? { hint } : {}) }));
}

function badgeOf(diagram: Diagram, system: DiagramSystem, result: SystemAnalysis | undefined): SystemBadge {
  const contract = result?.contract ?? contractOf(system);
  const latency = contract.entries.flatMap((e) => e.latency)[0];
  const availability = contract.entries.map((e) => e.availabilityPercent).filter((a): a is number => a !== undefined);
  const promise = [latency ? `p${latency.percentile} ${formatMs(latency.maxMs)}` : '', availability.length ? `${Math.min(...availability)}%` : ''].filter(Boolean).join(' · ');
  const team = diagram.nodes.find((n) => n.id === system.id)?.ownerTeam;
  const status: SystemStatus =
    contract.source === 'none' ? 'idle' : result?.saturated ? 'saturated' : result?.breaches.length ? 'breach' : result?.hot ? 'hot' : 'ok';
  return {
    ...(team ? { team } : {}),
    ...(promise ? { promise } : {}),
    sentRps: result?.totalInboundRps ?? 0,
    headroomRps: Math.min(Infinity, ...contract.entries.map((e) => e.saturatesAtRps)),
    ...(result && contract.source !== 'none' ? { utilization: result.utilization } : {}),
    status,
  };
}

/** `5.2k / 4.7k rps`: what a system is sent against its headroom. */
export function loadText(badge: SystemBadge): string {
  const head = formatRps(badge.headroomRps);
  return `${formatRps(badge.sentRps).replace(/ rps$/, '')} / ${head}`;
}
