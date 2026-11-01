import type { Diagram, DiagramNode, DiagramSystem } from '../../dsl';
import { analyze, formatRps, runTests, type Analysis, type SystemAnalysis, type TestResult } from '../../sim';

/**
 * What a system box shows on the canvas (docs/design/team-systems-and-imports.md
 * D3, D4): the team's promise, how much of its headroom the rest of the
 * diagram uses, and whether that saturates it or breaks its SLA.
 */

/** `ok`: takes what it is sent; `hot`: past 70%; `over`: saturated or SLA broken; `idle`: sent nothing; `unsimulated`: no design and no stub. */
export type SystemStatus = 'ok' | 'idle' | 'hot' | 'over' | 'unsimulated';

export interface SystemPort {
  id: string;
  name: string;
  /** The team use case it enters. */
  useCase?: string;
  sentRps: number;
  /** Extra rps the team's design takes on this entry before a node saturates (Infinity when none does). */
  limitRps: number;
}

export interface SystemSummary {
  /** Namespaced id: `orders`, or `orders.wh` for a system inside the Orders design. */
  path: string;
  /** A team design is linked (`from` resolved), so the box can be opened and expanded. */
  linked: boolean;
  /** The file it was loaded from, when linked. */
  file?: string;
  /** The contract comes from the `capacity { … }` stub. */
  stub: boolean;
  status: SystemStatus;
  /** `OK`, `Runs hot`, `Saturated`, `SLA broken`, `Idle`, `Not simulated`. */
  label: string;
  /** `p99 < 150 ms · ≥ 99.95%`; absent when the team promises nothing. */
  promise?: string;
  /** What is sent against what it takes, for the tightest entry point: `1.8k / 1.2k rps`. */
  headroom?: { text: string; ratio: number };
  ports: SystemPort[];
  /** The busiest node of the team design, under the combined load. */
  busiest?: string;
  utilization: number;
  /** The simulation's findings about it (saturation, running hot, SLA breaches). */
  warnings: string[];
  /**
   * The findings in short, for the status tooltip: a headline (`Saturated ·
   * db at 160%`) and one line each (`You send 1.5k of the 2.1k rps it gets`,
   * `Takes at most 1.2k rps before db saturates`, `p99 of "Place order" < 150 ms broken`).
   */
  tip: { headline: string; lines: string[] };
  /** Who to ask: `Send it less, or ask the Orders team to add capacity for it`. */
  hint?: string;
}

/** The system at a namespaced path (`orders.wh`), looking through team designs. */
export function systemAt(diagram: Diagram, path: string): DiagramSystem | undefined {
  const [head, ...rest] = path.split('.');
  const system = diagram.systems?.find((s) => s.id === head);
  if (!system || rest.length === 0) return system;
  return system.diagram ? systemAt(system.diagram, rest.join('.')) : undefined;
}

/** The analysis of the system at a namespaced path: each level's team design under the load it is sent. */
export function systemAnalysisAt(analysis: Analysis, path: string): SystemAnalysis | undefined {
  const [head, ...rest] = path.split('.');
  const system = analysis.systems?.find((s) => s.id === head);
  if (!system || rest.length === 0) return system;
  return system.analysis ? systemAnalysisAt(system.analysis, rest.join('.')) : undefined;
}

/** The diagram and analysis shown when navigated into `path` (`''` is the document itself). */
export function scopeAt(diagram: Diagram, analysis: Analysis, path: string): { diagram: Diagram; analysis: Analysis } | undefined {
  if (path === '') return { diagram, analysis };
  const system = systemAt(diagram, path);
  const result = systemAnalysisAt(analysis, path);
  if (!system?.diagram) return undefined;
  // Under what it is sent; the design on its own traffic when it is sent nothing.
  return { diagram: system.diagram, analysis: result?.analysis ?? result?.contract.baseline ?? analyze(system.diagram) };
}

const STATUS_LABEL: Record<SystemStatus, string> = { ok: 'OK', idle: 'Idle', hot: 'Runs hot', over: 'Saturated', unsimulated: 'Not simulated' };

/** The summary of the system box `node`, with id `path`, in `scope` (the diagram that declares it and its analysis). */
export function summarizeSystem(path: string, node: DiagramNode, system: DiagramSystem | undefined, result: SystemAnalysis | undefined, test?: TestResult): SystemSummary {
  const contract = result?.contract;
  const source = contract?.source ?? (system?.stub ? 'stub' : 'none');
  const ports: SystemPort[] = (system?.entries ?? []).map((e) => {
    const c = contract?.entries.find((x) => x.entry === e.id);
    return {
      id: e.id,
      name: e.name,
      ...(c?.useCase ? { useCase: c.useCase } : {}),
      sentRps: result?.inbound.find((i) => i.entry === e.id)?.rps ?? 0,
      limitRps: c?.saturatesAtRps ?? Infinity,
    };
  });

  let status: SystemStatus;
  if (source === 'none') status = 'unsimulated';
  else if (result?.saturated || (result?.breaches.length ?? 0) > 0) status = 'over';
  else if (result?.hot) status = 'hot';
  else if ((result?.totalInboundRps ?? 0) === 0) status = 'idle';
  else status = 'ok';
  const label = status === 'over' && !result?.saturated ? 'SLA broken' : STATUS_LABEL[status];

  return {
    path,
    linked: !!system?.diagram,
    ...(system?.diagram && system.resolved ? { file: system.resolved } : {}),
    stub: source === 'stub',
    status,
    label,
    ...promiseOf(contract?.entries ?? []),
    ...headroomOf(ports),
    ports,
    ...(result?.busiest ? { busiest: result.busiest } : {}),
    utilization: result?.utilization ?? 0,
    warnings: result?.warnings ?? [],
    tip: tipOf(result, label, status),
    ...(test && !test.passed && test.hint ? { hint: test.hint } : {}),
    ...(node.ownerTeam && !test?.hint && status === 'hot' ? { hint: `Ask the ${node.ownerTeam} team before you send it more` } : {}),
  };
}

/** The findings of `result` in short; see `SystemSummary.tip`. */
function tipOf(result: SystemAnalysis | undefined, label: string, status: SystemStatus): SystemSummary['tip'] {
  if (!result || (status !== 'over' && status !== 'hot')) return { headline: label, lines: [] };
  const pct = `${Math.round(result.utilization * 100)}%`;
  const headline = result.busiest ? `${label} · ${result.busiest} at ${pct}` : `${label} · ${pct} of its capacity`;
  const own = result.totalInboundRps;
  const all = result.sharedInboundRps ?? own;
  const lines = [all > own * (1 + 1e-9) ? `You send ${formatRps(own).replace(/ rps$/, '')} of the ${formatRps(all)} it gets` : `You send ${formatRps(own)}`];
  const entry = result.contract.entries.find((c) => result.inbound.some((e) => e.entry === c.entry && e.rps > 0));
  if (entry && entry.saturatesAtRps === 0) lines.push('Saturated on its own traffic');
  else if (entry && result.saturated && Number.isFinite(entry.saturatesAtRps)) lines.push(`Takes at most ${formatRps(entry.saturatesAtRps)}${entry.bottleneck ? ` before ${entry.bottleneck} saturates` : ''}`);
  else if (entry && Number.isFinite(entry.hotAtRps)) lines.push(`Runs hot past ${formatRps(entry.hotAtRps)}`);
  for (const b of result.breaches) lines.push(`${b.requirement} broken`);
  return { headline, lines };
}

/** The promise of the first entry point that makes one: its latency limits and availability. */
function promiseOf(entries: NonNullable<SystemAnalysis['contract']>['entries']): { promise?: string } {
  const entry = entries.find((e) => e.latency.length > 0 || e.availabilityPercent !== undefined);
  if (!entry) return {};
  const parts = entry.latency.filter((l) => !l.scenario).map((l) => `p${l.percentile} < ${l.maxMs} ms`);
  if (entry.availabilityPercent !== undefined) parts.push(`≥ ${entry.availabilityPercent}%`);
  return parts.length ? { promise: parts.join(' · ') } : {};
}

/** Sent against what the tightest entry point takes. */
function headroomOf(ports: SystemPort[]): { headroom?: { text: string; ratio: number } } {
  const limited = ports.filter((p) => Number.isFinite(p.limitRps));
  if (limited.length === 0) {
    const sent = ports.reduce((sum, p) => sum + p.sentRps, 0);
    return ports.length ? { headroom: { text: `${formatRps(sent)} sent`, ratio: 0 } } : {};
  }
  const ratio = (p: SystemPort) => (p.limitRps > 0 ? p.sentRps / p.limitRps : p.sentRps > 0 ? Infinity : 1);
  const tight = limited.reduce((a, b) => (ratio(b) > ratio(a) ? b : a));
  return { headroom: { text: `${formatRps(tight.sentRps).replace(' rps', '')} / ${formatRps(tight.limitRps)}`, ratio: ratio(tight) } };
}

/**
 * Summaries of every system box in `shown` (a view of `diagram`, with
 * namespaced ids inside expanded systems), with `prefix` the namespaced id of
 * the system navigated into (`''` at the top).
 */
export function systemSummaries(diagram: Diagram, analysis: Analysis, results: TestResult[], shown: Diagram, prefix: string): Map<string, SystemSummary> {
  const summaries = new Map<string, SystemSummary>();
  const testsOf = new Map<string, TestResult[]>([['', results]]);
  // Test results per scope, computed only for scopes that have a system box on screen.
  const tests = (scopePath: string): TestResult[] => {
    let found = testsOf.get(scopePath);
    if (found === undefined) {
      const scope = scopeAt(diagram, analysis, scopePath);
      found = scope ? runTests(scope.diagram, scope.analysis) : [];
      testsOf.set(scopePath, found);
    }
    return found;
  };
  for (const node of shown.nodes) {
    if (node.kind !== 'system' && node.system !== node.id) continue;
    const path = prefix ? `${prefix}.${node.id}` : node.id;
    const dot = path.lastIndexOf('.');
    const scopePath = dot === -1 ? '' : path.slice(0, dot);
    const ownId = path.slice(dot + 1);
    const system = systemAt(diagram, path);
    const result = systemAnalysisAt(analysis, path);
    const test = tests(scopePath).find((r) => r.id === `system:${ownId}`);
    summaries.set(node.id, summarizeSystem(path, node, system, result, test));
  }
  return summaries;
}
