import type {
  CapacityOverride,
  Diagram,
  DiagramEdge,
  DiagramNode,
  DiagramScenario,
  DiagramStep,
  DiagramSystem,
  DiagramUseCase,
  Requirement,
  TrafficEntry,
} from './types';

/**
 * What changed between two parsed diagrams, e.g. two saved versions
 * (docs/design/versions-and-cloud.md). Structural: source positions,
 * comments and formatting never count, and ids are the identity, so a
 * renamed id is one removal and one addition.
 */

/** One attribute that differs; a side is undefined where the attribute is not set. */
export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface ChangedItem<T> {
  /** The identity the two sides were matched by (a node id, `a->b`, `use case/scenario`, …). */
  key: string;
  before: T;
  after: T;
  /** In a fixed order per kind of item. */
  changes: FieldChange[];
}

/** Every list is sorted by key. */
export interface ItemDiff<T> {
  added: T[];
  removed: T[];
  changed: ChangedItem<T>[];
}

/** A scenario with the id of the use case it belongs to. */
export interface ScenarioRef {
  useCase: string;
  scenario: DiagramScenario;
}

export interface DiagramDiff {
  /** The title and summary. */
  diagram: FieldChange[];
  nodes: ItemDiff<DiagramNode>;
  edges: ItemDiff<DiagramEdge>;
  useCases: ItemDiff<DiagramUseCase>;
  scenarios: ItemDiff<ScenarioRef>;
  requirements: ItemDiff<Requirement>;
  traffic: ItemDiff<TrafficEntry>;
  capacity: ItemDiff<CapacityOverride>;
  systems: ItemDiff<DiagramSystem>;
}

export type DiffSection = Exclude<keyof DiagramDiff, 'diagram'>;

export interface DiffCounts {
  added: number;
  removed: number;
  changed: number;
}

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A value with source locations dropped and object keys sorted, for comparing. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (key, v: unknown) => {
    if (key === 'loc' || key === 'responseLoc') return undefined;
    if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.entries(v).sort(([a], [b]) => byKey(a, b)));
    return v;
  });
}

/** Items by key; a key seen again gets `#2`, `#3`, … so nothing is dropped. */
function keyed<T>(items: T[], key: (item: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    const base = key(item);
    let k = base;
    for (let n = 2; map.has(k); n++) k = `${base}#${n}`;
    map.set(k, item);
  }
  return map;
}

function fieldChanges(before: Record<string, unknown>, after: Record<string, unknown>): FieldChange[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((field) => canonical(before[field]) !== canonical(after[field]))
    .map((field) => ({ field, before: before[field], after: after[field] }));
}

function diffBy<T>(
  before: T[],
  after: T[],
  key: (item: T) => string,
  fields: (item: T) => Record<string, unknown>,
  keyAfter: (item: T) => string = key,
): ItemDiff<T> {
  const old = keyed(before, key);
  const next = keyed(after, keyAfter);
  const diff: ItemDiff<T> = { added: [], removed: [], changed: [] };
  for (const k of [...old.keys()].sort(byKey)) if (!next.has(k)) diff.removed.push(old.get(k)!);
  for (const k of [...next.keys()].sort(byKey)) {
    const b = old.get(k);
    const a = next.get(k)!;
    if (b === undefined) {
      diff.added.push(a);
      continue;
    }
    const changes = fieldChanges(fields(b), fields(a));
    if (changes.length) diff.changed.push({ key: k, before: b, after: a, changes });
  }
  return diff;
}

function withoutLoc<T extends { loc: unknown }>({ loc: _loc, ...rest }: T): Omit<T, 'loc'> {
  void _loc;
  return rest;
}

/** A step as one line, close to how it reads in the source; steps compare by these lines. */
function stepText(step: DiagramStep): string {
  const arrow = step.failed ? '-x' : step.executionType === 'SYNC_REQUEST_RESPONSE' ? '->' : '->>';
  const prefixes = `${step.multiplier !== undefined ? `x${step.multiplier} ` : ''}${step.sizeBytes !== undefined ? `~${step.sizeBytes}B ` : ''}`;
  const label = `${prefixes}${step.stepName}`.trim();
  const reply = [step.statusCode, step.responseBody].filter((x) => x !== undefined && x !== '').join(' ');
  const flags = `${step.isParallel ? ' [par]' : ''}${step.isConditional ? ` [if ${step.conditionExpression ?? ''}]` : ''}`;
  return `${step.fromServiceId} ${arrow} ${step.toServiceId}${label ? ` : ${label}` : ''}${reply ? ` --> ${reply}` : ''}${flags}`;
}

const steps = (list: DiagramStep[]) => list.map(stepText);

const nodeFields = (n: DiagramNode) => ({
  kind: n.kind,
  name: n.name,
  type: n.type,
  techStack: n.techStack,
  ownerTeam: n.ownerTeam,
  description: n.description,
  parent: n.parent,
  replicas: n.replicas,
  color: n.color,
  tag: n.tag,
  critical: n.critical,
  rank: n.rank,
  direction: n.direction,
  style: n.style,
  system: n.system,
  position: n.position,
});

/** Edges are matched by `from->to`; where one pair has several edges, by their label too. */
function edgeKey(edges: DiagramEdge[]): (e: DiagramEdge) => string {
  const pairs = new Map<string, number>();
  for (const e of edges) pairs.set(`${e.source}->${e.target}`, (pairs.get(`${e.source}->${e.target}`) ?? 0) + 1);
  return (e) => {
    const pair = `${e.source}->${e.target}`;
    return pairs.get(pair)! > 1 ? `${pair} : ${e.label ?? ''}` : pair;
  };
}

const edgeFields = (e: DiagramEdge) => ({ label: e.label, tag: e.tag, style: e.style, sourcePort: e.sourcePort, targetPort: e.targetPort });

const useCaseFields = (u: DiagramUseCase) => ({
  name: u.name,
  description: u.description,
  entryServiceId: u.entryServiceId,
  endpoint: u.endpoint,
  steps: steps(u.steps),
});

const scenarioFields = ({ scenario: s }: ScenarioRef) => ({ name: s.name, outcome: s.outcome, condition: s.condition, steps: steps(s.steps) });

const scenariosOf = (d: Diagram): ScenarioRef[] => d.useCases.flatMap((u) => u.scenarios.map((scenario) => ({ useCase: u.id, scenario })));

/** A requirement's identity: what it constrains, not its limit, so a new limit is a change. */
export function requirementKey(r: Requirement): string {
  switch (r.kind) {
    case 'latency':
      return `latency p${r.percentile} ${r.useCase ?? '*'}${r.scenario ? `/${r.scenario}` : ''}`;
    case 'availability':
      return `availability ${r.useCase ?? '*'}`;
    case 'durable':
      return `durable ${r.useCase}`;
    case 'survive':
      return `survive ${canonical(r.target)}`;
    case 'cost':
      return 'cost';
  }
}

function requirementFields(r: Requirement): Record<string, unknown> {
  switch (r.kind) {
    case 'latency':
      return { maxMs: r.maxMs };
    case 'availability':
      return { minPercent: r.minPercent };
    case 'cost':
      return { maxUsdPerMonth: r.maxUsdPerMonth };
    default:
      return {};
  }
}

const systemFields = (s: DiagramSystem) => ({
  from: s.from,
  entries: s.entries.map((e) => `${e.id}${e.name !== e.id ? ` "${e.name}"` : ''}${e.useCase ? ` -> "${e.useCase}"` : ''}`),
  stub: s.stub && withoutLoc(s.stub),
});

/** Everything that differs from `before` to `after`; every list is empty when nothing does. */
export function diffDiagrams(before: Diagram, after: Diagram): DiagramDiff {
  return {
    diagram: fieldChanges({ title: before.title, summary: before.summary }, { title: after.title, summary: after.summary }),
    nodes: diffBy(before.nodes, after.nodes, (n) => n.id, nodeFields),
    edges: diffBy(before.edges, after.edges, edgeKey(before.edges), edgeFields, edgeKey(after.edges)),
    useCases: diffBy(before.useCases, after.useCases, (u) => u.id, useCaseFields),
    scenarios: diffBy(scenariosOf(before), scenariosOf(after), (s) => `${s.useCase}/${s.scenario.id}`, scenarioFields),
    requirements: diffBy(before.requirements ?? [], after.requirements ?? [], requirementKey, requirementFields),
    traffic: diffBy(before.traffic ?? [], after.traffic ?? [], (t) => t.useCase, (t) => ({ rps: t.rps, mix: t.mix })),
    capacity: diffBy(before.capacity ?? [], after.capacity ?? [], (c) => c.node, withoutLoc),
    systems: diffBy(before.systems ?? [], after.systems ?? [], (s) => s.id, systemFields),
  };
}

export const DIFF_SECTIONS: readonly DiffSection[] = ['nodes', 'edges', 'useCases', 'scenarios', 'requirements', 'traffic', 'capacity', 'systems'];

/** How many items each section added, removed and changed, and the totals (a changed title or summary counts as a change). */
export function summarizeDiff(diff: DiagramDiff): Record<DiffSection | 'total', DiffCounts> {
  const total: DiffCounts = { added: 0, removed: 0, changed: diff.diagram.length };
  const counts = { total } as Record<DiffSection | 'total', DiffCounts>;
  for (const section of DIFF_SECTIONS) {
    const { added, removed, changed } = diff[section] as ItemDiff<unknown>;
    counts[section] = { added: added.length, removed: removed.length, changed: changed.length };
    total.added += added.length;
    total.removed += removed.length;
    total.changed += changed.length;
  }
  return counts;
}
