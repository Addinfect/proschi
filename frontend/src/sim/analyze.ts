import type { Diagram, DiagramNode, DiagramStep, DiagramUseCase, Kind, Percentile } from '../dsl/types';
import { accessIn } from './access';
import { criticalPath, fallbacksFor, findScenario, findUseCase, needs, pathNodes, type Hop } from './flow';
import { formatPercent, formatRps } from './format';
import { capacityOf, combinedUtilization, profileOf, type Profile } from './profiles';
import { analyzeSystems, type SharedSystemLoad, type SystemAnalysis } from './systems';

/**
 * A deterministic, analytical model of the design under its traffic
 * (docs/design/hld-and-practice.md §2, §7; the "How the simulation works"
 * page, model/index.html, states every rule with its numbers): read and
 * write load and utilisation per node, M/M/c queueing per hop, latency
 * percentiles per scenario and of each use case's scenario mixture,
 * availability with single-primary failover, cost with internet egress.
 */

export interface NodeAnalysis {
  id: string;
  kind: Kind;
  replicas: number;
  /** Partitions (`capacity { n shards 4 }`), each with `replicas` instances; 1 by default. */
  shards: number;
  /** Reads and writes together, fan-out included; failed calls (`-x`) add nothing. */
  loadRps: number;
  /**
   * All replicas and shards together. When reads and writes have different
   * capacities, the effective capacity under the current mix
   * (`loadRps / utilization`), or the read capacity without load. Infinity
   * for clients.
   */
  capacityRps: number;
  /** How busy the node is, 0..1+: the larger of its request utilisation and its bandwidth utilisation. */
  utilization: number;
  /** Utilisation by requests alone (see `combinedUtilization`, §7.2). */
  requestUtilization: number;
  /** At or past 100% utilisation. */
  saturated: boolean;
  /** Read and write load and capacity (all replicas and shards together), and their utilisation (§7.2). */
  readLoadRps: number;
  writeLoadRps: number;
  readCapacityRps: number;
  writeCapacityRps: number;
  readUtilization: number;
  writeUtilization: number;
  /**
   * Payload megabytes per second the node sends and receives, the bandwidth
   * of all its replicas and shards, and their ratio (§7.3). Only nodes you
   * run on instances have a bandwidth limit; 0 for clients, third parties,
   * DNS, object storage and CDNs (see `BANDWIDTH_BOUND`).
   */
  bandwidthLoadMBps: number;
  bandwidthCapacityMBps: number;
  bandwidthUtilization: number;
  /** `shards`: writes go to one primary per shard and replicas only add reads (relational databases). */
  writeScaling: 'replicas' | 'shards';
  /** Data stores only (§7.4). */
  consistency?: 'strong' | 'eventual';
  /**
   * Servers one request can queue for: the replicas of its shard, or the one
   * primary when writes bind a single-primary store (see `serversOf`).
   */
  servers: number;
  /** Probability that a request waits in the queue (Erlang C for `servers` at this utilisation). */
  waitProbability: number;
  /** Mean hop latency under the current load: service time plus mean queueing delay (payload transfer not included). */
  latencyMs: number;
  /** With replicas, as a fraction 0..1. */
  availability: number;
  /**
   * What a write needs: the same as `availability`, except for a
   * single-primary store, whose writes need the primary; with a replica to
   * promote, only the failover window counts (`FAILOVER_SHARE`).
   */
  writeAvailability: number;
  /** All replicas and shards together, per month, egress included. */
  costUsd: number;
  /** Data this node sends to clients and third parties per month (§7.3), in GB, and what it costs (included in `costUsd`). */
  egressGbPerMonth: number;
  egressUsd: number;
  durable: boolean;
}

export type Percentiles = Record<'p50' | 'p90' | 'p95' | 'p99' | 'p999', number>;

export interface ScenarioAnalysis {
  id: string;
  name: string;
  /** Share of the use case's traffic, 0..1. */
  share: number;
  meanMs: number;
  percentiles: Percentiles;
}

export interface UseCaseAnalysis {
  id: string;
  name: string;
  rps: number;
  scenarios: ScenarioAnalysis[];
  /** Percentiles of the mixture of the scenarios, weighted by their shares. */
  percentiles: ScenarioAnalysis['percentiles'];
  /** For each percentile, the index of the scenario that contributes most to the requests slower than it. */
  tailScenario: Record<keyof Percentiles, number>;
  /** Fraction 0..1. */
  availability: number;
}

export interface Analysis {
  nodes: NodeAnalysis[];
  useCases: UseCaseAnalysis[];
  /** Instances and egress together, per month. */
  totalCostUsd: number;
  /** The egress part of `totalCostUsd` (§7.3). */
  totalEgressUsd: number;
  /** Ids of single-replica nodes a use case needs and cannot do without. */
  singlePointsOfFailure: string[];
  warnings: string[];
  /** Each `system` under what the diagram sends it (sim/systems.ts); absent when there are none. */
  systems?: SystemAnalysis[];
}

export interface AnalyzeOptions {
  /** What a failed call (`-x`) costs unless `capacity { n timeout … }` says otherwise; 1 000 ms by default. */
  timeoutMs?: number;
  /** Replica counts to use instead of the declared ones, by node id (`survive` analyses the design with one instance fewer). */
  replicas?: ReadonlyMap<string, number>;
  /**
   * Use case percentiles to compute; the others are NaN and their
   * `tailScenario` is 0. The mixture quantile is the costly part of an
   * analysis, so a caller that analyses many times (the game, once per tick)
   * asks only for what it reads. All of them by default.
   */
  percentiles?: readonly Percentile[];
  /** Internal: the load on every team design of the document being analysed (sim/systems.ts), passed to the team designs' own analyses. */
  sharedSystems?: SharedSystemLoad;
}

export const DEFAULT_TIMEOUT_MS = 1000;
/** Utilisation above which a node counts as hot (amber in the editor). */
export const HOT = 0.7;
/** Queueing delay is computed at most at this utilisation, so a saturated node still has a finite latency. */
export const QUEUE_CAP = 0.95;
/**
 * The part of a single-primary store's per-replica downtime that writes
 * still see when a replica can be promoted: failover takes a minute or two
 * of an outage that would otherwise last the whole repair.
 */
export const FAILOVER_SHARE = 0.1;
/**
 * How variable a service time is: half of it is fixed, half exponential, so
 * an idle hop's p50 is 0.85× its mean, p99 2.8× and p999 4.0×.
 */
export const SERVICE_SPREAD = 0.5;

/** Seconds in the 30-day month that monthly costs are quoted for. */
export const SECONDS_PER_MONTH = 2_592_000;
const BYTES_PER_MB = 1e6;
const BYTES_PER_GB = 1e9;

export const PERCENTILE_KEYS: Record<Percentile, keyof Percentiles> = { 50: 'p50', 90: 'p90', 95: 'p95', 99: 'p99', 99.9: 'p999' };
const PERCENTILES = Object.keys(PERCENTILE_KEYS).map(Number) as Percentile[];

/** Components the model covers: groups and text nodes are ignored. */
export function components(diagram: Diagram): DiagramNode[] {
  return diagram.nodes.filter((n) => n.kind === 'component');
}

export const replicasOf = (node: DiagramNode): number => Math.max(1, node.replicas ?? 1);

/** Traffic of a use case: requests per second, and each scenario's share (aligned with `useCase.scenarios`). */
export interface UseCaseTraffic {
  rps: number;
  shares: number[];
}

/**
 * Applies `traffic { … }`: without `mix` all traffic goes to the first
 * scenario; shares that do not add up to 100% are normalised. Use cases
 * without a traffic line get 0 rps, with the first scenario as their shape.
 */
export function resolveTraffic(diagram: Diagram, warnings: string[] = []): Map<string, UseCaseTraffic> {
  const result = new Map<string, UseCaseTraffic>();
  for (const u of diagram.useCases) result.set(u.id, { rps: 0, shares: u.scenarios.map((_, i) => (i === 0 ? 1 : 0)) });
  const seen = new Set<string>();
  for (const entry of diagram.traffic ?? []) {
    const useCase = findUseCase(diagram, entry.useCase);
    if (!useCase) {
      warnings.push(`Traffic for unknown use case "${entry.useCase}" is ignored`);
      continue;
    }
    if (seen.has(useCase.id)) continue;
    seen.add(useCase.id);
    const shares = useCase.scenarios.map(() => 0);
    for (const { scenario, share } of entry.mix ?? []) {
      const found = findScenario(useCase, scenario);
      if (found) shares[useCase.scenarios.indexOf(found)] += share;
      else warnings.push(`"${useCase.name}" has no scenario "${scenario}"; its traffic share is ignored`);
    }
    const total = shares.reduce((a, b) => a + b, 0);
    if (total <= 0) shares[0] = 1;
    else {
      if (Math.abs(total - 1) > 1e-6) warnings.push(`Traffic mix of "${useCase.name}" adds up to ${formatPercent(total)}; shares are scaled to 100%`);
      for (let i = 0; i < shares.length; i++) shares[i] /= total;
    }
    result.set(useCase.id, { rps: entry.rps, shares: useCase.scenarios.length ? shares : [] });
  }
  return result;
}

/** Times the step happens per request (`x200 …`, §7.3); 1 when absent. */
export const multiplierOf = (step: DiagramStep): number => (step.multiplier !== undefined && step.multiplier > 0 ? step.multiplier : 1);

/** Requests per second a node receives, split by access (§7.2). */
export interface Load {
  read: number;
  write: number;
}

/**
 * Calls `visit` with every request step that carries traffic and its rate
 * `R · m(s)` (fan-out not applied). A failed call (`-x`) is skipped: its
 * target is down in that scenario, so it receives nothing, and nothing is
 * sent back.
 */
export function forEachStepRate(diagram: Diagram, traffic: Map<string, UseCaseTraffic>, visit: (step: DiagramStep, rate: number) => void) {
  for (const u of diagram.useCases) {
    const { rps, shares } = traffic.get(u.id) ?? { rps: 0, shares: [] };
    u.scenarios.forEach((s, i) => {
      const rate = rps * (shares[i] ?? 0);
      if (rate > 0) for (const step of s.steps) if (!step.failed) visit(step, rate);
    });
  }
}

/**
 * `R · m(s) · multiplier` on the target of every request step that gets
 * through (`->`, `->>`; not `-x`), split into reads and writes (§2.2, §7.2,
 * §7.3).
 */
export function computeLoad(diagram: Diagram, traffic: Map<string, UseCaseTraffic>): Map<string, Load> {
  const load = new Map<string, Load>();
  const access = accessIn(diagram);
  forEachStepRate(diagram, traffic, (step, rate) => {
    const entry = load.get(step.toServiceId) ?? { read: 0, write: 0 };
    entry[access(step)] += rate * multiplierOf(step);
    load.set(step.toServiceId, entry);
  });
  return load;
}

/**
 * Where a step's payload goes (§7.3): from the target back to the sender
 * for a read (it answers with the payload), from the sender to the target
 * for a write (it sends it).
 */
export const payloadDirection = (step: DiagramStep, access: 'read' | 'write'): { from: string; to: string } =>
  access === 'read' ? { from: step.toServiceId, to: step.fromServiceId } : { from: step.fromServiceId, to: step.toServiceId };

/** Kinds outside your network: a payload sent to one of them leaves it, and is charged as internet egress. */
export const OUTSIDE = (kind: Kind): boolean => kind === 'client' || kind === 'external';

/**
 * GB per month each node sends out of your network:
 * `rps × share × multiplier × size × 2 592 000 s ÷ 10⁹`, for payloads that go
 * to a client or a third party. Payloads between your own nodes (storage to a
 * service, a CDN's origin fetch) are internal and free; payloads a client or
 * a third party sends are not your bill.
 */
export function computeEgressGb(diagram: Diagram, traffic: Map<string, UseCaseTraffic>, kindOf: (id: string) => Kind = (id) => profileOfId(diagram, id)): Map<string, number> {
  const gb = new Map<string, number>();
  const access = accessIn(diagram);
  forEachStepRate(diagram, traffic, (step, rate) => {
    if (!step.sizeBytes || step.sizeBytes <= 0) return;
    const { from, to } = payloadDirection(step, access(step));
    if (OUTSIDE(kindOf(from)) || !OUTSIDE(kindOf(to))) return;
    gb.set(from, (gb.get(from) ?? 0) + (rate * multiplierOf(step) * step.sizeBytes * SECONDS_PER_MONTH) / BYTES_PER_GB);
  });
  return gb;
}

/**
 * Kinds whose bandwidth is a limit: the ones you run on instances. Object
 * storage and CDNs scale out behind one name (their bandwidth is the speed of
 * one connection, for transfer time); clients, third parties and DNS are not
 * yours to size.
 */
export const BANDWIDTH_BOUND = (kind: Kind): boolean => !['client', 'external', 'dns', 'other', 'storage', 'cdn'].includes(kind);

/** Bytes per second each node sends or receives in payloads (both ends of every sized step). */
export function computeBytesPerSecond(diagram: Diagram, traffic: Map<string, UseCaseTraffic>): Map<string, number> {
  const bytes = new Map<string, number>();
  forEachStepRate(diagram, traffic, (step, rate) => {
    if (!step.sizeBytes || step.sizeBytes <= 0) return;
    const b = rate * multiplierOf(step) * step.sizeBytes;
    for (const id of new Set([step.fromServiceId, step.toServiceId])) bytes.set(id, (bytes.get(id) ?? 0) + b);
  });
  return bytes;
}

function profileOfId(diagram: Diagram, id: string): Kind {
  const node = diagram.nodes.find((n) => n.id === id);
  return node ? profileOf(node).kind : 'client';
}

/**
 * Time to move a step's payload (§7.3): `N × size ÷ bandwidth`, at the
 * slower of the sender's and the receiver's per-replica bandwidth. A fan-out
 * of N moves N payloads over the caller's link, batched or in parallel.
 */
export function transferMs(step: DiagramStep, bandwidthOf: (id: string) => number): number {
  if (!step.sizeBytes || step.sizeBytes <= 0) return 0;
  const mbps = Math.min(bandwidthOf(step.fromServiceId), bandwidthOf(step.toServiceId));
  return mbps > 0 && Number.isFinite(mbps) ? ((multiplierOf(step) * step.sizeBytes) / BYTES_PER_MB / mbps) * 1000 : 0;
}

export const utilizationOf = (load: number, capacity: number): number => (Number.isFinite(capacity) && capacity > 0 ? load / capacity : 0);

/**
 * Erlang C: the probability that a request waits in an M/M/c queue with
 * `servers` servers at utilisation `rho` (per server), computed through the
 * stable Erlang B recurrence. 0 when idle, 1 at or past saturation; for one
 * server it is `rho`.
 */
export function erlangC(servers: number, rho: number): number {
  if (rho <= 0) return 0;
  if (rho >= 1) return 1;
  const c = Math.max(1, Math.round(servers));
  const a = c * rho;
  let b = 1;
  for (let k = 1; k <= c; k++) b = (a * b) / (k + a * b);
  return b / (1 - rho * (1 - b));
}

/**
 * One hop's response time (§1.4, §1.5 of the model page), as a fixed part
 * plus an exponential tail: `fixed + Exp(tail)`. The mean is the M/M/c
 * response time, a service time `base` plus the mean queueing delay
 * `C · base ÷ (c · (1 − ρ))`; half the service time is fixed
 * (`SERVICE_SPREAD`) and the rest of the mean is the tail. An idle hop's
 * p99 is 2.8× its mean; as queueing grows, the tail grows with it, towards
 * the 4.6× of an exponential.
 */
export interface HopModel {
  fixedMs: number;
  tailMs: number;
  /** Erlang C: the probability that a request waits in the queue. */
  waitProbability: number;
}

/** The hop model of a node with base latency `baseMs`, at utilisation `rho` (capped at 95%), with `servers` servers. */
export function hopModel(baseMs: number, rho: number, servers = 1): HopModel {
  const r = Math.min(Math.max(rho, 0), QUEUE_CAP);
  const c = Math.max(1, Math.round(servers));
  const waitProbability = erlangC(c, r);
  const meanMs = baseMs + (waitProbability * baseMs) / (c * (1 - r));
  const fixedMs = (1 - SERVICE_SPREAD) * baseMs;
  return { fixedMs, tailMs: meanMs - fixedMs, waitProbability };
}

/** Mean response time of a hop: `base + C · base ÷ (c(1 − ρ))`, which is `base ÷ (1 − ρ)` for one server. */
export const hopMean = (h: Pick<HopModel, 'fixedMs' | 'tailMs'>): number => h.fixedMs + h.tailMs;

/** `ln(1 ÷ (1 − p))`: the p-quantile of an exponential with mean 1 (0.69 at p50, 4.6 at p99). */
export const tailFactor = (p: number): number => -Math.log(1 - p);

/** The p-quantile (0 ≤ p < 1) of a hop's response time: `fixed + tail · ln(1 ÷ (1 − p))`. */
export const hopQuantile = (h: Pick<HopModel, 'fixedMs' | 'tailMs'>, p: number): number => h.fixedMs + h.tailMs * tailFactor(p);

/** Mean hop latency for base latency `baseMs` at utilisation `rho` with `servers` servers (M/M/1 for one). */
export const hopLatency = (baseMs: number, utilization: number, servers = 1): number => hopMean(hopModel(baseMs, utilization, servers));

/** `A = 1 − (1 − a)^replicas` */
export const replicatedAvailability = (a: number, replicas: number): number => 1 - (1 - a) ** replicas;

/**
 * Availability of a single-primary store's writes: the primary's, except
 * that with another replica to promote only the failover window is lost:
 * `1 − (1 − a) × FAILOVER_SHARE`.
 */
export const primaryAvailability = (a: number, replicas: number): number => (replicas >= 2 ? 1 - (1 - a) * FAILOVER_SHARE : a);

/** The load and capacity fields of a node analysis. */
export type Usage = Pick<
  NodeAnalysis,
  | 'loadRps'
  | 'capacityRps'
  | 'utilization'
  | 'requestUtilization'
  | 'saturated'
  | 'readLoadRps'
  | 'writeLoadRps'
  | 'readCapacityRps'
  | 'writeCapacityRps'
  | 'readUtilization'
  | 'writeUtilization'
  | 'bandwidthLoadMBps'
  | 'bandwidthCapacityMBps'
  | 'bandwidthUtilization'
  | 'writeScaling'
>;

/**
 * Load, capacity and utilisation of a node with `replicas` replicas under the
 * given read and write load (§7.2) and payload bytes per second (§7.3).
 */
export function usageOf(p: Profile, replicas: number, readLoadRps: number, writeLoadRps: number, bytesPerSecond = 0): Usage {
  const { readRps: readCapacityRps, writeRps: writeCapacityRps } = capacityOf(p, replicas);
  const readUtilization = utilizationOf(readLoadRps, readCapacityRps);
  const writeUtilization = utilizationOf(writeLoadRps, writeCapacityRps);
  const requestUtilization = combinedUtilization(p, readUtilization, writeUtilization);
  const loadRps = readLoadRps + writeLoadRps;
  const bound = BANDWIDTH_BOUND(p.kind);
  const bandwidthLoadMBps = bound ? bytesPerSecond / BYTES_PER_MB : 0;
  const bandwidthCapacityMBps = bound ? p.bandwidthMBps * replicas * p.shards : 0;
  const bandwidthUtilization = utilizationOf(bandwidthLoadMBps, bandwidthCapacityMBps);
  const utilization = Math.max(requestUtilization, bandwidthUtilization);
  return {
    loadRps,
    capacityRps: readCapacityRps === writeCapacityRps || requestUtilization === 0 ? readCapacityRps : loadRps / requestUtilization,
    utilization,
    requestUtilization,
    saturated: utilization >= 1,
    readLoadRps,
    writeLoadRps,
    readCapacityRps,
    writeCapacityRps,
    readUtilization,
    writeUtilization,
    bandwidthLoadMBps,
    bandwidthCapacityMBps,
    bandwidthUtilization,
    writeScaling: p.writeScaling,
  };
}

/** Bandwidth, not requests, is what fills the node. */
export const bandwidthBound = (n: Usage): boolean => n.bandwidthUtilization > n.requestUtilization;

/**
 * How many servers a request queues for (§1.4): load is spread evenly over
 * the shards, and a key's requests can only go to its own shard, so the pool
 * is one shard's replicas; a single-primary store whose writes are the busier
 * side queues them for its one primary.
 */
export const serversOf = (n: Usage, replicas: number): number => (writeBound(n) ? 1 : replicas);

/**
 * `12k of 20k, 60%`; for a single-primary store that takes writes, reads and
 * writes separately: `reads 10k of 20k, 50%; writes 2k of 5k, 40%`.
 */
export function usageText(n: Usage): string {
  const part = (load: number, capacity: number, rho: number) => `${formatRps(load)} of ${formatRps(capacity)}, ${formatPercent(rho)}`;
  if (bandwidthBound(n)) {
    const mb = (x: number) => `${Number(x.toPrecision(3)).toLocaleString('en-US')} MB/s`;
    return `bandwidth ${mb(n.bandwidthLoadMBps)} of ${mb(n.bandwidthCapacityMBps)}, ${formatPercent(n.bandwidthUtilization)}`;
  }
  if (n.writeScaling === 'shards' && n.writeLoadRps > 0) {
    // Only the dimension that is loaded: no "reads 0 rps of 60k rps, 0%".
    if (n.readLoadRps <= 0) return `writes ${part(n.writeLoadRps, n.writeCapacityRps, n.writeUtilization)}`;
    return `reads ${part(n.readLoadRps, n.readCapacityRps, n.readUtilization)}; writes ${part(n.writeLoadRps, n.writeCapacityRps, n.writeUtilization)}`;
  }
  return part(n.loadRps, n.capacityRps, n.requestUtilization);
}

/** Writes are what saturates the node, and replicas cannot help with them (a single-primary store). */
export const writeBound = (n: Usage): boolean => n.writeScaling === 'shards' && n.writeUtilization >= n.readUtilization && n.writeLoadRps > 0;

/**
 * A scenario's synchronous critical path: parts in sequence, each the
 * slowest of its parallel items. An item is a fixed time (a timeout, a
 * transfer, the fixed half of a service time) plus an exponential tail.
 */
export interface PathModel {
  parts: { fixedMs: number; tailMs: number }[][];
}

/** Mean of a path: per part the largest item mean, summed. */
export function pathMean(path: PathModel): number {
  return path.parts.reduce((sum, part) => sum + Math.max(0, ...part.map((i) => i.fixedMs + i.tailMs)), 0);
}

/** A path's quantile at tail factor `l` (`ln(1 ÷ (1 − p))`): per part the largest item, summed. */
function pathAt(path: PathModel, l: number): number {
  let sum = 0;
  for (const part of path.parts) {
    let most = 0;
    for (const i of part) most = Math.max(most, i.fixedMs + i.tailMs * l);
    sum += most;
  }
  return sum;
}

/**
 * The p-quantile of a path: each item at its own p-quantile, the largest of
 * each part, summed. Fixed costs (timeouts, transfer time) add once; only the
 * hops' tails grow with p. Taking every hop at the same quantile treats slow
 * hops as coming together, which errs on the slow side for long paths.
 */
export const pathQuantile = (path: PathModel, p: number): number => pathAt(path, tailFactor(p));

/** `P(latency ≤ t)` for a path: `1 − e^(−l)` for the largest tail factor l whose quantile is at most t. */
export function pathCdf(path: PathModel, t: number): number {
  if (pathAt(path, 0) > t) return 0;
  // Without par groups the quantile is linear in l, `F + T·l`, so l = (t − F) / T exactly.
  if (path.parts.every((part) => part.length <= 1)) {
    let fixed = 0;
    let tail = 0;
    for (const part of path.parts) {
      if (part.length) {
        fixed += part[0].fixedMs;
        tail += part[0].tailMs;
      }
    }
    if (tail <= 0) return 1;
    const l = (t - fixed) / tail;
    return l > 1e6 ? 1 : 1 - Math.exp(-l);
  }
  let hi = 1;
  while (pathAt(path, hi) <= t) {
    hi *= 2;
    if (hi > 1e6) return 1; // no tail, or t is past any quantile that matters
  }
  let lo = 0;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (pathAt(path, mid) <= t) lo = mid;
    else hi = mid;
  }
  return 1 - Math.exp(-lo);
}

/**
 * The q-quantile (0..1) of a use case's latency, the mixture of its
 * scenarios weighted by their shares: the t with `Σ share(s) · P(s ≤ t) = q`,
 * found by bisection. A single scenario is its own quantile.
 */
export function mixtureQuantile(paths: { share: number; path: PathModel }[], q: number): number {
  const live = paths.filter((s) => s.share > 0);
  if (live.length === 0) return 0;
  if (live.length === 1) return pathQuantile(live[0].path, q);
  const total = live.reduce((sum, s) => sum + s.share, 0);
  const cdf = (t: number) => live.reduce((sum, s) => sum + s.share * pathCdf(s.path, t), 0) / total;
  let lo = Math.min(...live.map((s) => pathQuantile(s.path, 0)));
  let hi = Math.max(...live.map((s) => pathQuantile(s.path, q)));
  for (let i = 0; i < 60 && hi - lo > 1e-9 * Math.max(1, hi); i++) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) >= q) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Index of the scenario with the largest share (the first on ties). */
export function mainScenarioIndex(shares: number[]): number {
  let best = 0;
  shares.forEach((share, i) => {
    if (share > shares[best]) best = i;
  });
  return best;
}

/** Profiles of every component, with `capacity` overrides; warns about overrides for unknown nodes. */
export function profilesOf(diagram: Diagram, warnings: string[] = []): Map<string, Profile> {
  const nodes = components(diagram);
  const ids = new Set(nodes.map((n) => n.id));
  const overrides = new Map((diagram.capacity ?? []).map((o) => [o.node, o]));
  for (const o of diagram.capacity ?? []) if (!ids.has(o.node)) warnings.push(`Capacity for unknown node '${o.node}' is ignored`);
  return new Map<string, Profile>(nodes.map((n) => [n.id, profileOf(n, overrides.get(n.id))]));
}

export function analyze(diagram: Diagram, options: AnalyzeOptions = {}): Analysis {
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const warnings: string[] = [];
  const nodes = components(diagram);
  const profiles = profilesOf(diagram, warnings);
  const kindOf = (id: string): Kind => profiles.get(id)?.kind ?? 'client';

  const traffic = resolveTraffic(diagram, warnings);
  const load = computeLoad(diagram, traffic);
  const egress = computeEgressGb(diagram, traffic, kindOf);
  const bytes = computeBytesPerSecond(diagram, traffic);
  const systems = diagram.systems?.length ? analyzeSystems(diagram, traffic, options) : undefined;

  const hops = new Map<string, HopModel>();
  const nodeResults: NodeAnalysis[] = nodes.map((n) => {
    const p = profiles.get(n.id)!;
    const replicas = Math.max(1, options.replicas?.get(n.id) ?? replicasOf(n));
    const { read, write } = load.get(n.id) ?? { read: 0, write: 0 };
    const usage = usageOf(p, replicas, read, write, bytes.get(n.id) ?? 0);
    const servers = serversOf(usage, replicas);
    const hop = hopModel(p.latencyMs, usage.utilization, servers);
    hops.set(n.id, hop);
    const egressGbPerMonth = egress.get(n.id) ?? 0;
    const egressUsd = egressGbPerMonth * p.egressUsdPerGb;
    const availability = replicatedAvailability(p.availability, replicas);
    return {
      id: n.id,
      kind: p.kind,
      replicas,
      shards: p.shards,
      ...usage,
      ...(p.consistency ? { consistency: p.consistency } : {}),
      servers,
      waitProbability: hop.waitProbability,
      latencyMs: hopMean(hop),
      availability,
      writeAvailability: p.writeScaling === 'shards' ? primaryAvailability(p.availability, replicas) : availability,
      costUsd: replicas * p.shards * p.costUsd + egressUsd,
      egressGbPerMonth,
      egressUsd,
      durable: p.durable,
    };
  });
  const nodeById = new Map(nodeResults.map((n) => [n.id, n]));
  const bandwidthOf = (id: string) => profiles.get(id)?.bandwidthMBps ?? Infinity;
  const timeoutOf = (id: string) => profiles.get(id)?.timeoutMs ?? defaultTimeoutMs;

  for (const n of nodeResults) {
    const usage = usageText(n);
    if (n.saturated) warnings.push(`'${n.id}' is saturated: ${usage}. ${writeBound(n) ? 'Add shards for writes' : 'Add replicas'} or take load off it.`);
    else if (n.utilization > HOT) warnings.push(`'${n.id}' runs hot: ${usage}.`);
  }
  for (const s of systems?.systems ?? []) warnings.push(...s.warnings);

  const access = accessIn(diagram);
  const pathOf = (hopsOfPath: Hop[][]): PathModel => ({
    parts: hopsOfPath.map((part) =>
      part.map((h) => {
        if (h.failed) return { fixedMs: timeoutOf(h.target), tailMs: 0 };
        const hop = systems?.hop(h.target, h.step.toPort) ?? hops.get(h.target) ?? { fixedMs: 0, tailMs: 0 };
        return { fixedMs: transferMs(h.step, bandwidthOf) + hop.fixedMs, tailMs: hop.tailMs };
      }),
    ),
  });

  const useCases: UseCaseAnalysis[] = diagram.useCases.map((u) => {
    const { rps, shares } = traffic.get(u.id)!;
    const paths = u.scenarios.map((s) => pathOf(criticalPath(u, s)));
    const scenarios: ScenarioAnalysis[] = u.scenarios.map((s, i) => ({
      id: s.id,
      name: s.name,
      share: shares[i] ?? 0,
      meanMs: pathMean(paths[i]),
      percentiles: Object.fromEntries(PERCENTILES.map((q) => [PERCENTILE_KEYS[q], pathQuantile(paths[i], q / 100)])) as Percentiles,
    }));
    const weighted = paths.map((path, i) => ({ share: shares[i] ?? 0, path }));
    const wanted = new Set(options.percentiles ?? PERCENTILES);
    const percentiles = Object.fromEntries(PERCENTILES.map((q) => [PERCENTILE_KEYS[q], wanted.has(q) ? mixtureQuantile(weighted, q / 100) : NaN])) as Percentiles;
    const tailScenario = Object.fromEntries(
      PERCENTILES.map((q) => {
        if (!wanted.has(q)) return [PERCENTILE_KEYS[q], 0];
        const t = percentiles[PERCENTILE_KEYS[q]];
        const above = weighted.map((s) => (s.share > 0 ? s.share * (1 - pathCdf(s.path, t * (1 - 1e-9))) : -1));
        return [PERCENTILE_KEYS[q], Math.max(0, above.indexOf(Math.max(...above)))];
      }),
    ) as UseCaseAnalysis['tailScenario'];
    if (rps > 0 && u.scenarios.length === 0) warnings.push(`"${u.name}" has traffic but no steps`);
    const writes = mainWrites(u, shares, (step) => access(step) === 'write');
    const availabilityOf = (id: string) => {
      const n = nodeById.get(id);
      if (!n && systems) return systemAvailability(u, id, systems.availability);
      return !n ? 1 : writes.has(id) ? n.writeAvailability : n.availability;
    };
    return { id: u.id, name: u.name, rps, scenarios, percentiles, tailScenario, availability: useCaseAvailability(u, shares, availabilityOf) };
  });

  return {
    nodes: nodeResults,
    useCases,
    totalCostUsd: nodeResults.reduce((sum, n) => sum + n.costUsd, 0),
    totalEgressUsd: nodeResults.reduce((sum, n) => sum + n.egressUsd, 0),
    singlePointsOfFailure: singlePointsOfFailure(diagram),
    warnings,
    ...(systems ? { systems: systems.systems } : {}),
  };
}

/** A system's availability for a use case: the weakest entry point the use case enters (1 when it is not a simulated system). */
function systemAvailability(u: DiagramUseCase, id: string, availability: (id: string, port: string | undefined) => number | undefined): number {
  let result = 1;
  for (const s of u.scenarios) for (const step of s.steps) if (step.toServiceId === id) result = Math.min(result, availability(id, step.toPort) ?? 1);
  return result;
}

/** Nodes the main scenario writes to on its synchronous critical path (they need a single-primary store's primary). */
export function mainWrites(useCase: DiagramUseCase, shares: number[], isWrite: (step: DiagramStep) => boolean): Set<string> {
  if (useCase.scenarios.length === 0) return new Set();
  const path = criticalPath(useCase, useCase.scenarios[mainScenarioIndex(shares)]).flat();
  return new Set(path.filter((h) => !h.failed && !h.async && isWrite(h.step)).map((h) => h.target));
}

/**
 * Product of node availabilities over the synchronous path of the main
 * scenario. A node with a fallback (§7.6: a success scenario that calls it
 * with `-x` before responding and completes without it) contributes
 * `1 − (1 − A(n)) · (1 − A(fallback))`, where the fallback path is the nodes
 * that scenario adds to the main path. `availabilityOf` gives a node's
 * availability for what the main scenario does with it (a write to a
 * single-primary store needs its primary).
 */
export function useCaseAvailability(useCase: DiagramUseCase, shares: number[], availabilityOf: (id: string) => number): number {
  if (useCase.scenarios.length === 0) return 1;
  const main = pathNodes(useCase, useCase.scenarios[mainScenarioIndex(shares)]);
  const onMain = new Set(main);
  let result = 1;
  for (const id of main) {
    const a = availabilityOf(id);
    const fallback = Math.max(
      0,
      ...fallbacksFor(useCase, id).map((s) =>
        pathNodes(useCase, s)
          .filter((other) => other !== id && !onMain.has(other))
          .reduce((product, other) => product * availabilityOf(other), 1),
      ),
    );
    result *= 1 - (1 - a) * (1 - fallback);
  }
  return result;
}

/**
 * Kinds that run as instances of your own; clients, annotations, third
 * parties and DNS (off the request path, §7.5) are left out of failure analysis.
 */
export const DEPLOYED = (kind: Kind): boolean => kind !== 'client' && kind !== 'other' && kind !== 'external' && kind !== 'dns';

/** Single-replica nodes that some use case needs and has no fallback for. */
export function singlePointsOfFailure(diagram: Diagram): string[] {
  return components(diagram)
    .filter((n) => replicasOf(n) === 1 && DEPLOYED(profileOf(n).kind))
    .filter((n) => diagram.useCases.some((u) => needs(u, n.id) && fallbacksFor(u, n.id).length === 0))
    .map((n) => n.id);
}
