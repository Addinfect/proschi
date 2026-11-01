import type { Diagram, DiagramSystem, DiagramUseCase, Percentile, SourceLoc, TrafficEntry } from '../dsl/types';
import {
  HOT,
  PERCENTILE_KEYS,
  SERVICE_SPREAD,
  analyze,
  components,
  computeBytesPerSecond,
  computeLoad,
  forEachStepRate,
  hopModel,
  multiplierOf,
  profilesOf,
  replicasOf,
  resolveTraffic,
  tailFactor,
  usageOf,
  usageText,
  type Analysis,
  type AnalyzeOptions,
  type HopModel,
  type NodeAnalysis,
  type Usage,
  type UseCaseTraffic,
} from './analyze';
import { findScenario, findUseCase } from './flow';
import { formatAvailability, formatMs, formatRps } from './format';
import { analysisOverlay, type SimOverlay } from './overlay';

/**
 * Systems in the simulation (docs/design/team-systems-and-imports.md D3, D4):
 * a team's design behind a contract. The contract (promise and headroom) is
 * derived from the team file once; the load other parts of the diagram send
 * through the entry points is added to the team's own traffic, and the team
 * design is analysed under that combined load.
 */

/** What one entry point promises and how much more it takes. */
export interface EntryContract {
  entry: string;
  name: string;
  /** Name of the team use case it enters; absent for a stub or an unmapped entry. */
  useCase?: string;
  /** The team's own traffic on that use case. */
  ownRps: number;
  /** The team's latency requirements that apply to the use case. */
  latency: { percentile: Percentile; maxMs: number; scenario?: string }[];
  /** The strictest availability requirement that applies, 0..100. */
  availabilityPercent?: number;
  /** Extra rps on the entry point, on top of the team's own traffic, at which a node saturates; Infinity when none does. 0 when one already is. */
  saturatesAtRps: number;
  /** The node that saturates first, in the team's scope. */
  bottleneck?: string;
  /** Extra rps at which a node passes `HOT`. */
  hotAtRps: number;
  hotNode?: string;
}

export interface SystemContract {
  /** Derived from the team file, from the `capacity` stub, or neither (not simulated). */
  source: 'design' | 'stub' | 'none';
  entries: EntryContract[];
  /** The team design under its own traffic only; design systems only. */
  baseline?: Analysis;
}

/** One system that sends load into a team design, and from where. */
export interface SystemCaller {
  /** Namespaced id: `orders`, or `frontend.orders` for one declared in the Frontend design. */
  path: string;
  /** Title of the diagram that declares it. */
  from?: string;
  rps: number;
}

/** The file a system's design came from; the parsed design itself when the resolver named none. */
type TeamKey = string | Diagram;
const teamKey = (s: DiagramSystem): TeamKey => s.resolved ?? s.diagram!;

/**
 * The load on every team design of a document from every system that uses
 * it (keyed by the file the resolver returned), and each design's analysis
 * under that load, computed once. Built by the top-level `analyzeSystems`
 * and passed down to the team designs' own analyses.
 */
export interface SharedSystemLoad {
  byFile: Map<TeamKey, { useCases: Map<string, number>; callers: SystemCaller[] }>;
  analyses: Map<TeamKey, { combined: Diagram; analysis: Analysis }>;
}

/** A team requirement that fails under the combined load. */
export interface SystemBreach {
  /** `p99 of "Place order" < 150 ms` */
  requirement: string;
  message: string;
}

export interface SystemAnalysis {
  id: string;
  contract: SystemContract;
  /** What the rest of the diagram sends to each entry point (every entry listed), in rps. */
  inbound: { entry: string; rps: number }[];
  totalInboundRps: number;
  /**
   * Every system in the document (at any depth) that sends into the same
   * team file, with what each sends: the team design is one design, so it is
   * analysed once under all of it. Design systems only.
   */
  callers?: SystemCaller[];
  /** What all of `callers` send together, in rps; design systems only. */
  sharedInboundRps?: number;
  /** The team design under its own traffic plus what every caller sends; design systems only. */
  analysis?: Analysis;
  /**
   * The load on each node of the team design under the combined load, by the
   * team's own ids (`db`), with the flows along its connections: the shape
   * the canvas overlay uses for any diagram. Design systems only.
   */
  overlay?: SimOverlay;
  /** The busiest node's utilisation (the stub's for a stub), 0..1+. */
  utilization: number;
  /** The busiest node, in the team's scope. */
  busiest?: string;
  saturated: boolean;
  hot: boolean;
  breaches: SystemBreach[];
  /** Latency and availability of each entry point as the rest of the diagram sees them. */
  entries: { entry: string; p50Ms: number; p99Ms: number; availability: number }[];
  /** Org-level findings, also in the parent analysis's `warnings`. */
  warnings: string[];
}

/** What the parent analysis needs per system: one hop model and an availability per entry point. */
export interface SystemsResult {
  systems: SystemAnalysis[];
  /** The hop of a step to `id`'s entry point `port`; undefined when `id` is not a simulated system. */
  hop(id: string, port: string | undefined): HopModel | undefined;
  availability(id: string, port: string | undefined): number | undefined;
}

const contracts = new WeakMap<DiagramSystem, SystemContract>();

/** The contract of a system, computed once per parsed system. */
export function contractOf(system: DiagramSystem, options: AnalyzeOptions = {}): SystemContract {
  let contract = contracts.get(system);
  if (!contract) {
    contract = system.diagram ? designContract(system, system.diagram, options) : stubContract(system);
    contracts.set(system, contract);
  }
  return contract;
}

function stubContract(system: DiagramSystem): SystemContract {
  const stub = system.stub;
  if (!stub) return { source: 'none', entries: system.entries.map((e) => emptyEntry(e.id, e.name)) };
  const rps = stub.rps ?? Infinity;
  return {
    source: 'stub',
    entries: system.entries.map((e) => ({
      ...emptyEntry(e.id, e.name),
      latency: stub.p99Ms !== undefined ? [{ percentile: 99, maxMs: stub.p99Ms }] : [],
      ...(stub.availability !== undefined ? { availabilityPercent: stub.availability } : {}),
      saturatesAtRps: rps,
      hotAtRps: rps * HOT,
    })),
  };
}

const emptyEntry = (entry: string, name: string): EntryContract => ({ entry, name, ownRps: 0, latency: [], saturatesAtRps: Infinity, hotAtRps: Infinity });

/**
 * Promise and headroom from the team design. Load is linear in traffic, so
 * each node's utilisation is linear in the extra rps `t` on the entry's use
 * case (per read, write and bandwidth term); the headroom is where the first
 * term of the first node crosses 100% (or `HOT`).
 */
function designContract(system: DiagramSystem, team: Diagram, options: AnalyzeOptions): SystemContract {
  const traffic = resolveTraffic(team);
  const base = computeLoad(team, traffic);
  const baseBytes = computeBytesPerSecond(team, traffic);
  const profiles = profilesOf(team);
  const nodes = components(team);
  const entries = system.entries.map((e): EntryContract => {
    const u = team.useCases.find((x) => x.id === e.useCaseId);
    if (!u) return emptyEntry(e.id, e.name);
    const own = traffic.get(u.id)!;
    const unit = new Map<string, UseCaseTraffic>([[u.id, { rps: 1, shares: own.shares }]]);
    const delta = computeLoad(team, unit);
    const deltaBytes = computeBytesPerSecond(team, unit);
    const result: EntryContract = { ...emptyEntry(e.id, e.name), useCase: u.name, ownRps: own.rps };
    for (const n of nodes) {
      const d = delta.get(n.id);
      const db = deltaBytes.get(n.id) ?? 0;
      if (!d && !db) continue;
      const p = profiles.get(n.id)!;
      const replicas = replicasOf(n);
      const b = base.get(n.id) ?? { read: 0, write: 0 };
      const bb = baseBytes.get(n.id) ?? 0;
      const u0 = usageOf(p, replicas, b.read, b.write, bb);
      const u1 = usageOf(p, replicas, b.read + (d?.read ?? 0), b.write + (d?.write ?? 0), bb + db);
      const sat = crossing(u0, u1, 1);
      const hot = crossing(u0, u1, HOT);
      if (sat < result.saturatesAtRps) {
        result.saturatesAtRps = sat;
        result.bottleneck = n.id;
      }
      if (hot < result.hotAtRps) {
        result.hotAtRps = hot;
        result.hotNode = n.id;
      }
    }
    for (const r of team.requirements ?? []) {
      if (r.kind !== 'latency' && r.kind !== 'availability') continue;
      if (r.useCase !== undefined && findUseCase(team, r.useCase) !== u) continue;
      if (r.kind === 'latency') result.latency.push({ percentile: r.percentile, maxMs: r.maxMs, ...(r.scenario !== undefined ? { scenario: r.scenario } : {}) });
      else result.availabilityPercent = Math.max(result.availabilityPercent ?? 0, r.minPercent);
    }
    return result;
  });
  return { source: 'design', entries, baseline: analyze(team, { timeoutMs: options.timeoutMs }) };
}

/** Smallest extra rps at which a linear utilisation term reaches `theta` (0 when one already has). */
function crossing(u0: Usage, u1: Usage, theta: number): number {
  const terms: [number, number][] =
    u0.writeScaling === 'shards'
      ? [
          [u0.readUtilization, u1.readUtilization],
          [u0.writeUtilization, u1.writeUtilization],
        ]
      : [[u0.requestUtilization, u1.requestUtilization]];
  terms.push([u0.bandwidthUtilization, u1.bandwidthUtilization]);
  let best = Infinity;
  for (const [a, b] of terms) {
    const slope = b - a;
    if (slope <= 1e-15) continue;
    if (a >= theta) return 0;
    best = Math.min(best, (theta - a) / slope);
  }
  return best;
}

/** Rps the parent's steps send to each entry point of each system: rate × fan-out, failed calls left out. */
export function inboundLoad(diagram: Diagram, traffic: Map<string, UseCaseTraffic>): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>();
  forEachStepRate(diagram, traffic, (step, rate) => {
    if (step.toPort === undefined) return;
    const ports = result.get(step.toServiceId) ?? new Map<string, number>();
    ports.set(step.toPort, (ports.get(step.toPort) ?? 0) + rate * multiplierOf(step));
    result.set(step.toServiceId, ports);
  });
  return result;
}

/** A hop whose p50 and p99 are the given ones (fixed part plus exponential tail, as `hopModel`). */
function hopFrom(p50: number, p99: number): HopModel {
  const l50 = tailFactor(0.5);
  const l99 = tailFactor(0.99);
  let tailMs = Math.max(0, (p99 - p50) / (l99 - l50));
  let fixedMs = p50 - tailMs * l50;
  if (fixedMs < 0) {
    fixedMs = 0;
    tailMs = p99 / l99;
  }
  return { fixedMs, tailMs, waitProbability: 0 };
}

/** Analyses every system of `diagram` under what the diagram sends it. */
export function analyzeSystems(diagram: Diagram, traffic: Map<string, UseCaseTraffic>, options: AnalyzeOptions = {}): SystemsResult {
  const inbound = inboundLoad(diagram, traffic);
  if (!options.sharedSystems) options = { ...options, sharedSystems: sharedLoad(diagram, inbound) };
  const hops = new Map<string, HopModel>();
  const availabilities = new Map<string, number>();
  const key = (id: string, port: string) => `${id}\n${port}`;
  const systems = (diagram.systems ?? []).map((system) => {
    const result = analyzeSystem(system, inbound.get(system.id) ?? new Map(), options);
    for (const e of result.entries) {
      hops.set(key(system.id, e.entry), hopFrom(e.p50Ms, e.p99Ms));
      availabilities.set(key(system.id, e.entry), e.availability);
    }
    return result;
  });
  return {
    systems,
    hop: (id, port) => (port === undefined ? undefined : hops.get(key(id, port))),
    availability: (id, port) => (port === undefined ? undefined : availabilities.get(key(id, port))),
  };
}

/** Adds what `system`'s entry points are sent to its team's use cases in `into`; returns the total. */
function sentByUseCase(system: DiagramSystem, sent: Map<string, number>, into: Map<string, number>): number {
  let total = 0;
  for (const e of system.entries) {
    const rps = sent.get(e.id) ?? 0;
    if (rps <= 0 || e.useCaseId === undefined) continue;
    into.set(e.useCaseId, (into.get(e.useCaseId) ?? 0) + rps);
    total += rps;
  }
  return total;
}

/**
 * The load on every team design of the document from every system that uses
 * it. A team design's own systems send what its combined load makes them
 * send, so the designs are visited callers first (the `from` chain has no
 * cycles).
 */
function sharedLoad(root: Diagram, rootInbound: Map<string, Map<string, number>>): SharedSystemLoad {
  const byFile: SharedSystemLoad['byFile'] = new Map();
  const designs = new Map<TeamKey, { diagram: Diagram; path: string; loc: SourceLoc }>();
  const order: TeamKey[] = [];
  const visit = (d: Diagram, prefix: string) => {
    for (const s of d.systems ?? []) {
      if (!s.diagram) continue;
      const key = teamKey(s);
      if (designs.has(key)) continue;
      const path = prefix ? `${prefix}.${s.id}` : s.id;
      designs.set(key, { diagram: s.diagram, path, loc: s.loc });
      visit(s.diagram, path);
      order.push(key);
    }
  };
  visit(root, '');
  const send = (d: Diagram, prefix: string, inbound: Map<string, Map<string, number>>) => {
    for (const s of d.systems ?? []) {
      if (!s.diagram) continue;
      const key = teamKey(s);
      const load = byFile.get(key) ?? { useCases: new Map<string, number>(), callers: [] };
      byFile.set(key, load);
      const rps = sentByUseCase(s, inbound.get(s.id) ?? new Map(), load.useCases);
      if (rps > 0) load.callers.push({ path: prefix ? `${prefix}.${s.id}` : s.id, ...(d.title !== undefined ? { from: d.title } : {}), rps });
    }
  };
  send(root, '', rootInbound);
  // Post-order reversed: every design comes after the designs that call it.
  for (const key of order.reverse()) {
    const { diagram, path, loc } = designs.get(key)!;
    if (!diagram.systems?.length) continue;
    const combined = withExtraTraffic(diagram, byFile.get(key)?.useCases ?? new Map(), loc);
    send(diagram, path, inboundLoad(combined, resolveTraffic(combined)));
  }
  return { byFile, analyses: new Map() };
}

function analyzeSystem(system: DiagramSystem, sent: Map<string, number>, options: AnalyzeOptions): SystemAnalysis {
  const contract = contractOf(system, options);
  const inbound = system.entries.map((e) => ({ entry: e.id, rps: sent.get(e.id) ?? 0 }));
  const totalInboundRps = inbound.reduce((sum, e) => sum + e.rps, 0);
  const result: SystemAnalysis = { id: system.id, contract, inbound, totalInboundRps, utilization: 0, saturated: false, hot: false, breaches: [], entries: [], warnings: [] };
  const shared = system.diagram ? options.sharedSystems?.byFile.get(teamKey(system)) : undefined;
  const sending = inbound
    .filter((e) => e.rps > 0)
    .map((e) => {
      const c = contract.entries.find((x) => x.entry === e.entry);
      const useCaseId = system.entries.find((x) => x.id === e.entry)?.useCaseId;
      const gets = useCaseId !== undefined ? (shared?.useCases.get(useCaseId) ?? 0) : 0;
      // Other systems send into the same team design too.
      const rps = gets > e.rps * (1 + 1e-9) ? `${formatRps(e.rps).replace(/ rps$/, '')} of the ${formatRps(gets)} it gets` : formatRps(e.rps);
      return `${rps} into ${c?.useCase ? `"${c.useCase}" (${system.id}.${e.entry})` : `${system.id}.${e.entry}`}`;
    })
    .join(' and ');
  const label = `'${system.id}'`;

  if (contract.source === 'stub') {
    const stub = system.stub!;
    const rps = stub.rps ?? Infinity;
    result.utilization = Number.isFinite(rps) && rps > 0 ? totalInboundRps / rps : 0;
    result.saturated = result.utilization >= 1;
    result.hot = !result.saturated && result.utilization > HOT;
    // A stub holds its promise up to its rate: its latency does not queue.
    const base = stub.latencyMs ?? (stub.p99Ms !== undefined ? stub.p99Ms / (1 - SERVICE_SPREAD + SERVICE_SPREAD * tailFactor(0.99)) : 0);
    const hop = hopModel(base, 0);
    const at = (p: number) => hop.fixedMs + hop.tailMs * tailFactor(p);
    const availability = stub.availability !== undefined ? stub.availability / 100 : 1;
    result.entries = system.entries.map((e) => ({ entry: e.id, p50Ms: at(0.5), p99Ms: at(0.99), availability }));
    if (result.saturated) {
      result.warnings.push(`${label} cannot take what it is sent: you send ${sending}; it takes at most ${formatRps(rps)}.`);
      if (stub.p99Ms !== undefined) result.breaches.push({ requirement: `p99 < ${formatMs(stub.p99Ms)}`, message: `p99 is not held past ${formatRps(rps)}` });
    } else if (result.hot) result.warnings.push(`${label} runs hot under what it is sent: you send ${sending}; it runs hot past ${formatRps(rps * HOT)} and takes at most ${formatRps(rps)}.`);
    return result;
  }
  if (contract.source === 'none' || !system.diagram) {
    result.entries = system.entries.map((e) => ({ entry: e.id, p50Ms: 0, p99Ms: 0, availability: 1 }));
    return result;
  }

  const team = system.diagram;
  const key = teamKey(system);
  // What every system using this team file sends; this one's own when analysed on its own.
  const sentToTeam = shared?.useCases ?? new Map<string, number>();
  if (!shared) sentByUseCase(system, sent, sentToTeam);
  const sharedInboundRps = [...sentToTeam.values()].reduce((sum, rps) => sum + rps, 0);
  result.callers = shared?.callers ?? (totalInboundRps > 0 ? [{ path: system.id, rps: totalInboundRps }] : []);
  result.sharedInboundRps = sharedInboundRps;
  let cached = options.sharedSystems?.analyses.get(key);
  if (!cached) {
    const combined = sharedInboundRps > 0 ? withExtraTraffic(team, sentToTeam, system.loc) : team;
    const nested: AnalyzeOptions = { timeoutMs: options.timeoutMs, ...(options.sharedSystems ? { sharedSystems: options.sharedSystems } : {}) };
    cached = { combined, analysis: sharedInboundRps > 0 ? analyze(combined, nested) : contract.baseline! };
    options.sharedSystems?.analyses.set(key, cached);
  }
  const { analysis } = cached;
  result.analysis = analysis;
  result.overlay = analysisOverlay(cached.combined, analysis);
  const busiest = analysis.nodes.reduce<NodeAnalysis | undefined>((best, n) => (!best || n.utilization > best.utilization ? n : best), undefined);
  result.utilization = busiest?.utilization ?? 0;
  result.busiest = busiest?.id;
  result.saturated = !!busiest?.saturated;
  result.hot = !result.saturated && result.utilization > HOT;
  const byId = new Map(analysis.useCases.map((u) => [u.id, u]));
  result.entries = system.entries.map((e) => {
    const u = e.useCaseId !== undefined ? byId.get(e.useCaseId) : undefined;
    return { entry: e.id, p50Ms: u?.percentiles.p50 ?? 0, p99Ms: u?.percentiles.p99 ?? 0, availability: u?.availability ?? 1 };
  });
  // A design only other systems send to: their warnings say it.
  if (totalInboundRps === 0) return result;

  result.breaches = breachesOf(team, sentToTeam, analysis);
  const first = contract.entries.find((c) => inbound.some((e) => e.entry === c.entry && e.rps > 0));
  if (result.saturated && busiest) {
    const onOwn = first && first.saturatesAtRps === 0;
    const limit = first && Number.isFinite(first.saturatesAtRps) ? `; it takes at most ${formatRps(first.saturatesAtRps)} before its ${first.bottleneck} saturates` : '';
    result.warnings.push(
      onOwn
        ? `${label} is saturated on its own traffic, before what it is sent: its ${busiest.id} is at ${usageText(busiest)}.`
        : `${label} cannot take what it is sent: you send ${sending}${limit}. Its ${busiest.id} is at ${usageText(busiest)}.`,
    );
  } else if (result.hot && busiest) {
    const limit = first && Number.isFinite(first.hotAtRps) ? `; it runs hot past ${formatRps(first.hotAtRps)}` : '';
    result.warnings.push(`${label} runs hot under what it is sent: you send ${sending}${limit}. Its ${busiest.id} is at ${usageText(busiest)}.`);
  }
  for (const b of result.breaches) result.warnings.push(`${label} breaks its SLA under what it is sent: ${b.message}.`);
  return result;
}

/** The team design with `extra` rps (by use case id) added to its own traffic. */
function withExtraTraffic(team: Diagram, extra: Map<string, number>, loc: SourceLoc): Diagram {
  const traffic: TrafficEntry[] = [...(team.traffic ?? [])];
  for (const [id, rps] of extra) {
    const u = team.useCases.find((x) => x.id === id);
    if (!u || rps <= 0) continue;
    // The first traffic line of the use case is the one the simulation reads.
    const i = traffic.findIndex((t) => findUseCase(team, t.useCase) === u);
    if (i >= 0) traffic[i] = { ...traffic[i], rps: traffic[i].rps + rps };
    else traffic.push({ useCase: u.name, rps, loc });
  }
  return { ...team, traffic };
}

/** The team's latency and availability requirements on the entered use cases that fail under the combined load. */
function breachesOf(team: Diagram, sent: Map<string, number>, analysis: Analysis): SystemBreach[] {
  const entered = new Set<DiagramUseCase>();
  for (const [id, rps] of sent) {
    const u = team.useCases.find((x) => x.id === id);
    if (u && rps > 0) entered.add(u);
  }
  const nodes = new Map(analysis.nodes.map((n) => [n.id, n]));
  const results = new Map(analysis.useCases.map((u) => [u.id, u]));
  const breaches: SystemBreach[] = [];
  for (const r of team.requirements ?? []) {
    if (r.kind !== 'latency' && r.kind !== 'availability') continue;
    const targets = r.useCase === undefined ? [...entered] : [findUseCase(team, r.useCase)].filter((u): u is DiagramUseCase => !!u && entered.has(u));
    for (const u of targets) {
      const ua = results.get(u.id)!;
      const under = `under ${formatRps(ua.rps)}`;
      if (r.kind === 'availability') {
        const name = `availability of "${u.name}" ≥ ${r.minPercent}%`;
        if (ua.availability * 100 < r.minPercent - 1e-9) breaches.push({ requirement: name, message: `availability of "${u.name}" is ${formatAvailability(ua.availability)} ${under} (limit ${r.minPercent}%)` });
        continue;
      }
      const key = PERCENTILE_KEYS[r.percentile];
      const scenario = r.scenario !== undefined ? findScenario(u, r.scenario) : undefined;
      if (r.scenario !== undefined && !scenario) continue;
      const what = `${key} of "${u.name}"${scenario ? ` scenario "${scenario.name}"` : ''}`;
      const name = `${what} < ${formatMs(r.maxMs)}`;
      const steps = scenario ? scenario.steps : u.scenarios.flatMap((s) => s.steps);
      // The busiest saturated node the use case sends load to.
      const saturated = steps
        .map((s) => nodes.get(s.toServiceId))
        .reduce<NodeAnalysis | undefined>((best, n) => (n?.saturated && (!best || n.utilization > best.utilization) ? n : best), undefined);
      if (saturated) {
        breaches.push({ requirement: name, message: `${what}: ${saturated.id} is saturated (${usageText(saturated)}) ${under} (limit ${formatMs(r.maxMs)})` });
        continue;
      }
      const ms = scenario ? ua.scenarios[u.scenarios.indexOf(scenario)].percentiles[key] : ua.percentiles[key];
      if (ms >= r.maxMs) breaches.push({ requirement: name, message: `${what} is ${formatMs(ms)} ${under} (limit ${formatMs(r.maxMs)})` });
    }
  }
  return breaches;
}
