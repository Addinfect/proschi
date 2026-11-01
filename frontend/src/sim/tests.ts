import type { Assertion, Diagram, DiagramScenario, DiagramStep, DiagramUseCase, FlowTest, Percentile, Requirement, Selector, SourceLoc } from '../dsl/types';
import { editDistance } from '../catalog/componentCatalog';
import { requestLabel } from '../dsl/sequence';
import { accessIn } from './access';
import {
  DEFAULT_TIMEOUT_MS,
  DEPLOYED,
  FAILOVER_SHARE,
  HOT,
  PERCENTILE_KEYS,
  analyze,
  components,
  mainScenarioIndex,
  mainWrites,
  profilesOf,
  replicasOf,
  resolveTraffic,
  bandwidthBound,
  usageText,
  writeBound,
  type Analysis,
  type AnalyzeOptions,
  type NodeAnalysis,
  type ScenarioAnalysis,
  type UseCaseAnalysis,
} from './analyze';
import {
  criticalPath,
  fallbacksFor,
  findScenario,
  findUseCase,
  needs,
  nodeLabel,
  pathNodes,
  requestOrder,
  selectNodes,
  selectorText,
  writesBeforeResponse,
} from './flow';
import { formatAvailability, formatMs, formatPercent, formatRps, formatUsd } from './format';
import type { Profile } from './profiles';

/**
 * Requirements and `test` blocks as executable checks
 * (docs/design/hld-and-practice.md §3, §7). Every requirement and every test
 * block yields one result; messages state what was measured and the limit,
 * hints name the lever that fixes a failure.
 */

export interface TestResult {
  /** Stable: `req:<n>` (1-based position in `requirements`) or `test:<name>`. */
  id: string;
  name: string;
  category: 'latency' | 'availability' | 'durability' | 'resilience' | 'cost' | 'flow';
  passed: boolean;
  /** What was measured: "p99 of Redirect is 41 ms (limit 50 ms)". */
  message: string;
  /** How to fix it, when failed. */
  hint?: string;
  /** The requirement or test line. */
  loc?: SourceLoc;
  /** For `test` blocks: the result of each assertion line. */
  assertions?: AssertionResult[];
}

export interface AssertionResult {
  passed: boolean;
  message: string;
  hint?: string;
  loc: SourceLoc;
}

interface Check {
  passed: boolean;
  message: string;
  hint?: string;
  /** Set when the check could not run because a use case or scenario is missing; a test reports each once (§7.1). */
  missing?: string;
}

const pass = (message: string): Check => ({ passed: true, message });
const fail = (message: string, hint?: string): Check => ({ passed: false, message, hint });

/** Context shared by the checks of one run. */
interface Run {
  diagram: Diagram;
  analysis: Analysis;
  nodes: Map<string, NodeAnalysis>;
  useCases: Map<string, UseCaseAnalysis>;
  shares: Map<string, number[]>;
  profiles: Map<string, Profile>;
  isWrite: (step: DiagramStep) => boolean;
  /** What the analysis was made with; `survive` re-analyses with the same options. */
  options: AnalyzeOptions;
}

function makeRun(diagram: Diagram, analysis: Analysis, options: AnalyzeOptions = {}): Run {
  const access = accessIn(diagram);
  return {
    diagram,
    analysis,
    nodes: new Map(analysis.nodes.map((n) => [n.id, n])),
    useCases: new Map(analysis.useCases.map((u) => [u.id, u])),
    shares: new Map([...resolveTraffic(diagram)].map(([id, t]) => [id, t.shares])),
    profiles: profilesOf(diagram),
    isWrite: (step) => access(step) === 'write',
    options,
  };
}

/** `options` must be the ones `analysis` was made with (by default none): `survive` re-analyses with them. */
export function runTests(diagram: Diagram, analysis: Analysis = analyze(diagram), options: AnalyzeOptions = {}): TestResult[] {
  const run = makeRun(diagram, analysis, options);
  const results: TestResult[] = (diagram.requirements ?? []).map((r, i) => {
    const { passed, message, hint } = requirement(run, r);
    return { id: `req:${i + 1}`, name: requirementName(r), category: CATEGORY[r.kind], passed, message, hint, loc: r.loc };
  });
  results.push(...systemResults(diagram, analysis));
  const names = new Map<string, number>();
  for (const test of diagram.tests ?? []) {
    const n = (names.get(test.name) ?? 0) + 1;
    names.set(test.name, n);
    results.push({ id: n === 1 ? `test:${test.name}` : `test:${test.name}#${n}`, name: test.name, category: 'flow', ...flowTest(run, test), loc: test.loc });
  }
  return results.map(({ hint, ...r }) => (r.passed || !hint ? r : { ...r, hint }));
}

/**
 * One result per system that the diagram sends load to
 * (docs/design/team-systems-and-imports.md D4): it passes when the team
 * design takes the combined load without saturating and keeps its own
 * latency and availability requirements.
 */
function systemResults(diagram: Diagram, analysis: Analysis): TestResult[] {
  return (analysis.systems ?? [])
    .filter((s) => s.totalInboundRps > 0 && s.contract.source !== 'none')
    .map((s) => {
      const system = diagram.systems?.find((x) => x.id === s.id);
      const node = diagram.nodes.find((n) => n.id === s.id);
      const team = node?.ownerTeam ? `the ${node.ownerTeam} team` : `the owners of ${s.id}`;
      const problem = s.warnings.find((w) => !w.includes(' runs hot '));
      const sat = s.contract.entries.find((e) => s.inbound.some((i) => i.entry === e.entry && i.rps > 0));
      const room = sat && Number.isFinite(sat.saturatesAtRps) ? `; it takes at most ${formatRps(sat.saturatesAtRps)}` : '';
      const bottleneck = s.saturated && s.busiest ? ` (their bottleneck is ${s.busiest})` : '';
      return {
        id: `system:${s.id}`,
        name: `${s.id} takes what it is sent`,
        category: s.breaches.some((b) => b.requirement.startsWith('availability')) && !s.saturated ? 'availability' : 'latency',
        passed: !problem,
        message: problem ?? `'${s.id}' takes ${formatRps(s.totalInboundRps)}${(s.sharedInboundRps ?? 0) > s.totalInboundRps * (1 + 1e-9) ? ` (of the ${formatRps(s.sharedInboundRps!)} it gets)` : ''}${s.contract.source === 'stub' ? '' : ' on top of its own traffic'} and holds its requirements${room}`,
        ...(problem ? { hint: `Send it less, or ask ${team} to add capacity for it${bottleneck}` } : {}),
        ...(system ? { loc: system.loc } : {}),
      };
    });
}

const CATEGORY: Record<Requirement['kind'], TestResult['category']> = {
  latency: 'latency',
  availability: 'availability',
  durable: 'durability',
  survive: 'resilience',
  cost: 'cost',
};

const percentileName = (q: Percentile) => PERCENTILE_KEYS[q];

/** `line 12`, or `file.proschi:12` for an imported file. */
const lineOf = (loc: SourceLoc) => `${loc.file ? `${loc.file}:` : 'line '}${loc.line}`;

/** A step as written, with its line: `api -> db : INSERT url at line 12`. */
function stepText(step: DiagramStep): string {
  const arrow = step.failed ? '-x' : step.executionType === 'SYNC_REQUEST_RESPONSE' ? '->' : '->>';
  const label = requestLabel(step);
  return `${step.fromServiceId} ${arrow} ${step.toServiceId}${label ? ` : ${label}` : ''} at ${lineOf(step.loc)}`;
}

/** The requirement line in words: "p99 of Redirect < 50 ms". */
export function requirementName(r: Requirement): string {
  switch (r.kind) {
    case 'latency':
      return `${percentileName(r.percentile)} of ${r.useCase ?? 'every use case'}${r.scenario !== undefined ? ` scenario ${r.scenario}` : ''} < ${formatMs(r.maxMs)}`;
    case 'availability':
      return `availability of ${r.useCase ?? 'every use case'} ≥ ${r.minPercent}%`;
    case 'durable':
      return `${r.useCase} is durable`;
    case 'survive':
      return r.target === 'any' ? 'survive any node failure' : `survive failure of ${selectorText(r.target)}`;
    case 'cost':
      return `cost ≤ ${formatUsd(r.maxUsdPerMonth)}`;
  }
}

function requirement(run: Run, r: Requirement): Check {
  switch (r.kind) {
    case 'latency':
      if (r.useCase !== undefined && r.scenario !== undefined) return scenarioLatency(run, r.useCase, r.scenario, r.percentile, r.maxMs);
      return overUseCases(run, r.useCase, (u) => latency(run, u, r.percentile, r.maxMs), `(limit ${formatMs(r.maxMs)})`);
    case 'availability':
      return overUseCases(run, r.useCase, (u) => availability(run, u, r.minPercent), `(limit ${r.minPercent}%)`, true);
    case 'durable':
      return durable(run, r.useCase);
    case 'survive':
      return survive(run, r.target);
    case 'cost':
      return cost(run, r.maxUsdPerMonth);
  }
}

/**
 * Checks one named use case, or every use case with traffic (with
 * `anyWithoutTraffic`, every use case when none has traffic).
 */
function overUseCases(run: Run, name: string | undefined, check: (u: DiagramUseCase) => Check & { value?: string }, limit: string, anyWithoutTraffic = false): Check {
  if (name !== undefined) {
    const u = findUseCase(run.diagram, name);
    return u ? check(u) : unknownUseCase(run, name);
  }
  let targets = run.diagram.useCases.filter((u) => (run.useCases.get(u.id)?.rps ?? 0) > 0);
  if (targets.length === 0 && anyWithoutTraffic) targets = run.diagram.useCases;
  if (targets.length === 0) return fail('No use case has traffic, so there is nothing to measure', 'Add traffic { "<use case>" 1k rps } for the use cases this applies to');
  const checks = targets.map(check);
  const failed = checks.filter((c) => !c.passed);
  if (failed.length === 0) {
    return pass(checks.length === 1 ? checks[0].message : `All ${checks.length} use cases hold; ${checks.map((c) => c.value).join(', ')} ${limit}`);
  }
  return fail(failed.length === 1 ? failed[0].message : `${failed.map((c) => c.value ?? c.message).join('; ')} ${limit}`, failed[0].hint);
}

/**
 * A use case the test names but the diagram lacks. "Use one of" only when the
 * name looks like a typo of an existing one (a case-insensitive match or at most
 * a quarter of its length in edits); otherwise the fix is to add it.
 */
function unknownUseCase(run: Run, name: string): Check {
  const lower = name.toLowerCase();
  const near = run.diagram.useCases.filter((u) => editDistance(u.name.toLowerCase(), lower) <= Math.max(1, Math.floor(name.length / 4)));
  const hint = near.length ? `Use one of ${near.map((u) => quote(u.name)).join(', ')}` : `Add usecase ${quote(name)} { … }`;
  return { ...fail(`No use case named ${quote(name)}`, hint), missing: `use case ${name}` };
}

/** The first saturated node among `ids`, as a failed latency check. */
function saturatedOn(run: Run, ids: Iterable<string>, value: (n: NodeAnalysis) => string, maxMs: number): (Check & { value: string }) | undefined {
  const n = [...new Set(ids)].map((id) => run.nodes.get(id)).find((x): x is NodeAnalysis => !!x?.saturated);
  if (!n) return undefined;
  const v = value(n);
  return { ...fail(`${v} (limit ${formatMs(maxMs)})`, saturationHint(run, n)), value: v };
}

function latency(run: Run, u: DiagramUseCase, q: Percentile, maxMs: number): Check & { value?: string } {
  const result = run.useCases.get(u.id)!;
  const key = percentileName(q);
  const shares = run.shares.get(u.id) ?? [];
  // A saturated node fails every latency requirement whose use case sends it load.
  const touched = u.scenarios.flatMap((s, i) => ((shares[i] ?? 0) > 0 ? s.steps.map((step) => step.toServiceId) : []));
  const saturated = saturatedOn(run, touched, (n) => `${key} of ${u.name}: ${n.id} is saturated (${usageText(n)})`, maxMs);
  if (saturated) return saturated;
  const ms = result.percentiles[key];
  const value = `${key} of ${u.name} is ${formatMs(ms)}${result.rps > 0 ? '' : ' with no traffic'}`;
  const message = `${value} (limit ${formatMs(maxMs)})`;
  if (ms < maxMs) return { ...pass(message), value };
  // The scenario that contributes most of the requests slower than the percentile.
  const index = Math.min(result.tailScenario[key] ?? 0, u.scenarios.length - 1);
  const lead = u.scenarios.length > 1 ? `The "${u.scenarios[index].name}" path (${formatPercent(result.scenarios[index].share)} of traffic) sets ${key}. ` : '';
  return { ...fail(message, lead + latencyHint(run, u, u.scenarios[index])), value };
}

/** `p99 "Checkout" scenario "Replay" < 100ms` (§7.6): the scenario's own percentile, whatever its share. */
function scenarioLatency(run: Run, useCase: string, scenario: string, q: Percentile, maxMs: number): Check {
  const sc = scope(run, useCase, scenario);
  if (isCheck(sc)) return sc;
  const s = sc.scenarios[0];
  const key = percentileName(q);
  const what = `${key} of "${sc.u.name}" scenario "${s.name}"`;
  const saturated = saturatedOn(run, s.steps.map((step) => step.toServiceId), (n) => `${what}: ${n.id} is saturated (${usageText(n)})`, maxMs);
  if (saturated) return saturated;
  const result: ScenarioAnalysis | undefined = run.useCases.get(sc.u.id)?.scenarios[sc.u.scenarios.indexOf(s)];
  const ms = result?.percentiles[key] ?? 0;
  const message = `${what} is ${formatMs(ms)} (limit ${formatMs(maxMs)})`;
  return ms < maxMs ? pass(message) : fail(message, latencyHint(run, sc.u, s));
}

function saturationHint(run: Run, n: NodeAnalysis): string {
  const label = nodeLabel(run.diagram, n.id);
  if (bandwidthBound(n)) {
    const replicas = Math.ceil((n.bandwidthUtilization * n.replicas) / HOT);
    return `${label} moves more payload bytes than its network carries. Send the bytes around it (clients upload to and download from object storage or a CDN directly, with presigned URLs), or add replicas: x${replicas} keeps its bandwidth under ${formatPercent(HOT)}`;
  }
  if (writeBound(n)) {
    const perShard = n.writeCapacityRps / n.shards;
    const shards = Math.ceil(n.writeLoadRps / (perShard * HOT));
    return (
      `Writes to ${label} need ${formatRps(n.writeLoadRps)} and each primary takes ${formatRps(perShard)}; read replicas do not add write capacity. ` +
      `Add shards (capacity { ${n.id} shards ${shards} } keeps writes under ${formatPercent(HOT)}), move the data to a partitioned store (DynamoDB, Cassandra), or batch writes through a queue`
    );
  }
  const rho = n.writeScaling === 'shards' ? n.readUtilization : n.utilization;
  const replicas = Math.ceil((rho * n.replicas) / HOT);
  return `Add replicas to ${label}: x${replicas} keeps it under ${formatPercent(HOT)}, or take load off it (a cache in front, or async work)`;
}

/** Names the slowest hop of the scenario and the lever for it. */
function latencyHint(run: Run, u: DiagramUseCase, scenario: DiagramScenario): string {
  const hops = criticalPath(u, scenario).flat();
  const timeout = (id: string) => run.profiles.get(id)?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cost = (h: (typeof hops)[number]) => (h.failed ? timeout(h.target) : (run.nodes.get(h.target)?.latencyMs ?? 0));
  const slowest = hops.reduce<(typeof hops)[number] | undefined>((best, h) => (!best || cost(h) > cost(best) ? h : best), undefined);
  if (!slowest) return 'Shorten the synchronous path of the request.';
  const label = nodeLabel(run.diagram, slowest.target);
  if (slowest.failed) return `It waits ${formatMs(timeout(slowest.target))} for the failed call to ${label}; give that path a smaller share of traffic, avoid the call, or time out sooner (capacity { ${slowest.target} timeout 200ms }).`;
  const sized = hops.find((h) => (h.step.sizeBytes ?? 0) > 0);
  const node = run.nodes.get(slowest.target);
  if (node && node.utilization > HOT) return `${label} runs at ${formatPercent(node.utilization)} and queues requests; add replicas to it.`;
  const payload = sized ? ` Payloads add transfer time too (${stepText(sized.step)}): send fewer bytes or let the client fetch them from a CDN or storage directly.` : '';
  return `Its slowest hop is ${label} at ${formatMs(cost(slowest))}: put a cache in front of it, run independent calls in par, or move work off the request path with ->>.${payload}`;
}

function availability(run: Run, u: DiagramUseCase, minPercent: number): Check & { value?: string } {
  const result = run.useCases.get(u.id)!;
  const value = `availability of ${u.name} is ${formatAvailability(result.availability)}`;
  const message = `${value} (limit ${minPercent}%)`;
  if (result.availability * 100 >= minPercent - 1e-9) return { ...pass(message), value };
  // The weakest node on the main path that has no fallback; a write to a single-primary store needs its primary.
  const shares = run.shares.get(u.id) ?? [];
  const main = u.scenarios.length ? pathNodes(u, u.scenarios[mainScenarioIndex(shares)]) : [];
  const writes = mainWrites(u, shares, run.isWrite);
  const effective = (n: NodeAnalysis) => (writes.has(n.id) ? n.writeAvailability : n.availability);
  const weakest = main
    .filter((id) => fallbacksFor(u, id).length === 0)
    .map((id) => run.nodes.get(id))
    .filter((n): n is NodeAnalysis => !!n && effective(n) < 1)
    .sort((a, b) => effective(a) - effective(b))[0];
  const primaryBound = weakest && writes.has(weakest.id) && weakest.writeAvailability < weakest.availability;
  const hint = !weakest
    ? 'Add replicas to the nodes on the main path, or fallback scenarios that complete without them'
    : primaryBound
      ? `The weakest link is writing to ${nodeLabel(run.diagram, weakest.id)}: writes need its primary, ${formatAvailability(weakest.writeAvailability)} with failover${weakest.replicas < 2 ? ' (none without a second replica; add one)' : ` (a replica takes over, but about ${formatPercent(FAILOVER_SHARE)} of each outage is lost)`}. Move the writes to a partitioned store, or add a fallback scenario that calls it with -x and still completes`
      : `The weakest link is ${nodeLabel(run.diagram, weakest.id)} at ${formatAvailability(effective(weakest))}: add a replica (x${weakest.replicas + 1}) or a fallback scenario that calls it with -x and still completes`;
  return { ...fail(message, hint), value };
}

type WriteGap = { kind: 'async' | 'after' | 'read'; step: DiagramStep } | { kind: 'none' };

/** Why a scenario does not write to an accepted node synchronously before responding, with the step that comes closest. */
function writeGap(run: Run, u: DiagramUseCase, s: DiagramScenario, accept: (id: string) => boolean): WriteGap {
  const { requests, beforeResponse } = requestOrder(u, s);
  const hits = requests.map((m, i) => ({ m, i })).filter(({ m }) => !m.failed && accept(m.to));
  const writes = hits.filter(({ m }) => run.isWrite(m.step));
  const early = writes.find(({ m, i }) => m.async && i < beforeResponse);
  if (early) return { kind: 'async', step: early.m.step };
  const late = writes.find(({ i }) => i >= beforeResponse);
  if (late) return { kind: 'after', step: late.m.step };
  const read = hits.find(({ m, i }) => i < beforeResponse && !m.async);
  if (read) return { kind: 'read', step: read.m.step };
  return { kind: 'none' };
}

/**
 * Every success scenario writes (§7.2) to a node accepted by `accept`,
 * synchronously, before the entry response. `what` names the target as a
 * noun: `db`, `a durable store`.
 */
function writesCheck(run: Run, u: DiagramUseCase, scenarios: DiagramScenario[], accept: (id: string) => boolean, what: string): Check {
  const success = scenarios.filter((s) => s.outcome === 'success');
  if (success.length === 0) return fail(`"${u.name}" has no success scenario to check`, 'Add a scenario whose entry request is answered with a 2xx');
  const gaps = success.filter((s) => !writesBeforeResponse(u, s, accept, run.isWrite));
  if (gaps.length === 0) {
    const label = success.length === 1 ? `"${u.name}"` : `Every success scenario of "${u.name}"`;
    return pass(`${label} writes to ${what} before responding`);
  }
  const details = gaps.map((s) => ({ s, gap: writeGap(run, u, s, accept) }));
  const where = (s: DiagramScenario) => (u.scenarios.length > 1 ? `"${s.name}"` : `"${u.name}"`);
  const text = (s: DiagramScenario, gap: WriteGap) => {
    switch (gap.kind) {
      case 'async':
        return `${where(s)} writes to ${what} only asynchronously: ${stepText(gap.step)}`;
      case 'after':
        return `${where(s)} writes to ${what} only after responding: ${stepText(gap.step)}`;
      case 'read':
        return `${where(s)} only reads from ${what} before responding: ${stepText(gap.step)} is a read`;
      case 'none':
        return `${where(s)} never writes to ${what} before responding`;
    }
  };
  const message = details.map(({ s, gap }) => text(s, gap)).join('; ');
  const hints: Record<WriteGap['kind'], string> = {
    async: 'Make the write a synchronous request (->) so it is acknowledged before the response',
    after: 'Move the write before the step that answers the entry request',
    read: 'Only writes count: start the label with a write verb (INSERT, UPDATE, PUT, SET, …) or use POST, PUT, PATCH or DELETE if the step stores data',
    none: `Add a synchronous write (->) to ${what} before the entry request is answered`,
  };
  return fail(message, hints[details[0].gap.kind]);
}

function durable(run: Run, name: string): Check {
  const u = findUseCase(run.diagram, name);
  if (!u) return unknownUseCase(run, name);
  return writesCheck(run, u, u.scenarios, (id) => !!run.nodes.get(id)?.durable, 'a durable store');
}

/**
 * `survive any node failure` / `survive failure of X` (§2.5): every selected
 * node you run loses one instance. With replicas, the design is analysed
 * again with one fewer: that node must not saturate, and every latency
 * requirement that held must still hold. Load spreads evenly over shards and
 * a key cannot move to another shard, so losing one replica of a sharded
 * store makes its shard the bottleneck: the per-shard numbers are what count.
 * A single-primary store that loses its primary promotes a replica, so its
 * write capacity stays and one replica's reads go (the same as losing a
 * replica). With one instance, every use case that needs the node must have
 * a fallback scenario for it.
 */
function survive(run: Run, target: Selector | 'any'): Check {
  const all = components(run.diagram);
  const selected = target === 'any' ? all.filter((n) => DEPLOYED(run.nodes.get(n.id)!.kind)) : selectNodes(run.diagram, target);
  const what = target === 'any' ? 'any one node' : selectorText(target);
  if (selected.length === 0) {
    return target === 'any' ? pass('No nodes to lose') : fail(`No node matches ${what}`, 'Use a node id, [Tech] or any <kind>');
  }
  // Latency requirements that hold now; losing an instance must not break them.
  const latencies = (run.diagram.requirements ?? []).filter((r): r is Extract<Requirement, { kind: 'latency' }> => r.kind === 'latency' && requirement(run, r).passed);
  const failures: Check[] = [];
  for (const node of selected) {
    const n = run.nodes.get(node.id)!;
    const label = nodeLabel(run.diagram, node.id);
    const replicas = replicasOf(node);
    if (replicas >= 2) {
      const degradedOptions = { ...run.options, replicas: new Map([...(run.options.replicas ?? []), [node.id, replicas - 1]]) };
      const degraded = makeRun(run.diagram, analyze(run.diagram, degradedOptions), degradedOptions);
      const left = degraded.nodes.get(node.id)!;
      const lost = n.shards > 1 ? `one of the ${replicas} replicas of a ${node.id} shard` : `one of ${replicas} ${node.id} replicas`;
      if (left.saturated) {
        const leaves = bandwidthBound(left)
          ? `leaves ${usageText(left)}`
          : n.shards > 1
            ? `leaves that shard ${formatRps(left.capacityRps / n.shards)} for ${formatRps(n.loadRps / n.shards)}`
            : `leaves ${formatRps(left.capacityRps)} for ${formatRps(n.loadRps)}`;
        failures.push(
          fail(
            `Losing ${lost} ${leaves}${bandwidthBound(left) ? '' : ` (${formatPercent(left.utilization)})`}`,
            writeBound(left) ? saturationHint(run, { ...n, ...left }) : `Add a replica to ${label} (x${replicas + 1}) so the rest carry the load`,
          ),
        );
        continue;
      }
      const broken = latencies.map((r) => requirement(degraded, r)).find((c) => !c.passed);
      if (broken) {
        failures.push(
          fail(
            `Losing ${lost} breaks a latency limit: ${broken.message}`,
            `Add a replica to ${label} (x${replicas + 1}) so the rest keep it under ${formatPercent(HOT)}, or take load off it`,
          ),
        );
      }
      continue;
    }
    for (const u of run.diagram.useCases) {
      if (needs(u, node.id) && fallbacksFor(u, node.id).length === 0) {
        failures.push(
          fail(
            `Losing ${label} breaks "${u.name}"`,
            `Add a replica (x2 on ${node.id}) or a fallback scenario in "${u.name}" that calls ${node.id} with -x and still completes`,
          ),
        );
      }
    }
  }
  if (failures.length === 0) {
    const count = selected.length === 1 ? selected[0].id : `any of ${selected.length} nodes`;
    return pass(`Every use case keeps working after losing ${count}`);
  }
  const more = failures.length > 1 ? ` (and ${failures.length - 1} more)` : '';
  return fail(`${failures[0].message}${more}`, failures[0].hint);
}

function cost(run: Run, max: number): Check {
  const { totalCostUsd: total, totalEgressUsd: egress } = run.analysis;
  const ofWhich = egress > 0 ? `, ${formatUsd(egress)} of it egress` : '';
  const message = `Total cost is ${formatUsd(total)}${ofWhich} (limit ${formatUsd(max)})`;
  if (total <= max) return pass(message);
  const usd = (x: number) => formatUsd(x).replace('/month', '');
  const top = [...run.analysis.nodes]
    .filter((n) => n.costUsd > 0)
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 3)
    .map((n) => {
      const notes = [n.replicas > 1 ? `${n.replicas} replicas` : '', n.shards > 1 ? `${n.shards} shards` : '', n.egressUsd > 0 ? `${usd(n.egressUsd)} of it egress` : ''].filter(Boolean);
      return `${n.id} ${formatUsd(n.costUsd)}${notes.length ? ` (${notes.join(', ')})` : ''}`;
    });
  const egressHint =
    egress > total / 2 ? ' Most of it is egress: serve repeated downloads from a CDN ($0.02/GB) instead of storage ($0.09/GB), or send fewer bytes.' : '';
  return fail(message, `Biggest items: ${top.join(', ')}. Drop replicas on nodes with low utilisation or pick cheaper techs.${egressHint}`);
}

// ---------------------------------------------------------------- test blocks

function flowTest(run: Run, test: FlowTest): Omit<TestResult, 'id' | 'name' | 'category'> {
  const checks = test.assertions.map((a) => ({ ...assertion(run, a), loc: a.loc }));
  const assertions: AssertionResult[] = checks.map(({ passed, message, hint, loc }) => (hint === undefined ? { passed, message, loc } : { passed, message, hint, loc }));
  if (assertions.length === 0) return { passed: true, message: 'No assertions to check', assertions };
  const failed = checks.filter((a) => !a.passed);
  if (failed.length === 0) {
    return { passed: true, message: assertions.length === 1 ? assertions[0].message : `All ${assertions.length} assertions hold`, assertions };
  }
  // A missing use case or scenario is reported once, however many lines name it.
  const seen = new Set<string>();
  const reported = failed.filter((a) => {
    const key = a.missing ?? a.message;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { passed: false, message: reported.map((a) => a.message).join('; '), hint: reported[0].hint, assertions };
}

const quote = (s: string) => `"${s}"`;

/** The use case and the scenarios an assertion looks at, or why it cannot. */
function scope(run: Run, useCase: string, scenario?: string): { u: DiagramUseCase; scenarios: DiagramScenario[]; label: string } | Check {
  const u = findUseCase(run.diagram, useCase);
  if (!u) return unknownUseCase(run, useCase);
  if (scenario === undefined) return { u, scenarios: u.scenarios, label: quote(u.name) };
  const s = findScenario(u, scenario);
  if (!s) return missingScenario(u, scenario);
  return { u, scenarios: [s], label: `${quote(u.name)} scenario ${quote(s.name)}` };
}

function missingScenario(u: DiagramUseCase, scenario: string): Check {
  const names = u.scenarios.map((s) => quote(s.name)).join(', ');
  return {
    ...fail(`${quote(u.name)} has no scenario ${quote(scenario)}${names ? `; it has ${names}` : ''}`, `Add alt "${scenario}" { … } to "${u.name}"`),
    missing: `scenario ${u.name} › ${scenario}`,
  };
}

const isCheck = (x: object): x is Check => 'passed' in x;

/** Ids of the nodes a selector picks. */
const idsOf = (run: Run, selector: Selector) => new Set(selectNodes(run.diagram, selector).map((n) => n.id));

function assertion(run: Run, a: Assertion): Check {
  switch (a.kind) {
    case 'calls':
      return calls(run, a);
    case 'before':
      return before(run, a);
    case 'writesBeforeResponding': {
      const sc = scope(run, a.useCase, a.scenario);
      if (isCheck(sc)) return sc;
      const ids = idsOf(run, a.target);
      if (ids.size === 0) return noMatch(a.target);
      return writesCheck(run, sc.u, sc.scenarios, (id) => ids.has(id), selectorText(a.target));
    }
    case 'responds':
      return responds(run, a);
    case 'hasScenario': {
      const u = findUseCase(run.diagram, a.useCase);
      if (!u) return unknownUseCase(run, a.useCase);
      const s = findScenario(u, a.scenario);
      return s ? pass(`${quote(u.name)} has scenario ${quote(s.name)}`) : missingScenario(u, a.scenario);
    }
    case 'handlesFailure': {
      const u = findUseCase(run.diagram, a.useCase);
      if (!u) return unknownUseCase(run, a.useCase);
      const ids = idsOf(run, a.target);
      if (ids.size === 0) return noMatch(a.target);
      const handled = u.scenarios.find((s) => s.outcome === 'success' && s.steps.some((step) => step.failed && ids.has(step.toServiceId)));
      const what = selectorText(a.target);
      return handled
        ? pass(`${quote(u.name)} handles a failed call to ${what} in ${quote(handled.name)}`)
        : fail(
            `No success scenario of ${quote(u.name)} has a failed call to ${what}`,
            `Add alt "${what} down" { … -x ${[...ids][0]} … } that still answers the entry request with a 2xx`,
          );
    }
    case 'noPath':
      return noPath(run, a.from, a.to);
    case 'replicas': {
      const nodes = selectNodes(run.diagram, a.target);
      if (nodes.length === 0) return noMatch(a.target);
      const short = nodes.filter((n) => replicasOf(n) < a.min);
      const has = (n: (typeof nodes)[number]) => `${n.id} has ${replicasOf(n)} replica${replicasOf(n) === 1 ? '' : 's'}`;
      if (short.length === 0) return pass(`${nodes.map(has).join(', ')} (minimum ${a.min})`);
      return fail(`${short.map(has).join(', ')} (minimum ${a.min})`, `Declare ${short[0].id} with x${a.min}`);
    }
    case 'neverWaits':
      return neverWaits(run, a);
    case 'after':
      return after(run, a);
    case 'senderCalls':
      return senderCalls(run, a);
    case 'startsAt':
      return startsAt(run, a);
  }
}

function noMatch(selector: Selector): Check {
  return fail(`No node matches ${selectorText(selector)}`, 'Use a node id, [Tech] or any <kind> (any cache, any database, …)');
}

function calls(run: Run, a: Extract<Assertion, { kind: 'calls' }>): Check {
  const sc = scope(run, a.useCase, a.scenario);
  if (isCheck(sc)) return sc;
  const what = selectorText(a.target);
  const ids = idsOf(run, a.target);
  const called = (s: DiagramScenario) => s.steps.filter((step) => ids.has(step.toServiceId));
  const calling = sc.scenarios.filter((s) => called(s).length > 0);
  const names = (list: DiagramScenario[]) => list.map((s) => quote(s.name)).join(', ');
  const multi = sc.scenarios.length > 1;

  if (a.quantifier === 'never') {
    if (calling.length === 0) return pass(`${sc.label} never calls ${what}`);
    const first = calling[0];
    const step = called(first)[0];
    return fail(
      `${multi ? quote(first.name) : sc.label} calls ${nodeLabel(run.diagram, step.toServiceId)}: ${stepText(step)}`,
      `Take the call to ${step.toServiceId} out of ${quote(first.name)}, e.g. serve it from a cache`,
    );
  }
  if (ids.size === 0) return noMatch(a.target);
  if (a.quantifier === 'some') {
    if (calling.length) return pass(`${sc.label} calls ${what}${multi ? ` in ${names(calling)}` : ''}`);
    return fail(`${sc.label} never calls ${what}`, `Add a step to ${what}`);
  }
  const missing = sc.scenarios.filter((s) => !calling.includes(s));
  if (missing.length === 0 && sc.scenarios.length) return pass(`Every scenario of ${sc.label} calls ${what}`);
  return fail(`${sc.label} does not call ${what} in ${names(missing) || 'any scenario'}`, `Add a step to ${what} in ${names(missing) || 'a scenario'}`);
}

function before(run: Run, a: Extract<Assertion, { kind: 'before' }>): Check {
  const sc = scope(run, a.useCase, a.scenario);
  if (isCheck(sc)) return sc;
  const first = idsOf(run, a.first);
  const then = idsOf(run, a.then);
  const [x, y] = [selectorText(a.first), selectorText(a.then)];
  if (first.size === 0) return noMatch(a.first);
  if (then.size === 0) return noMatch(a.then);
  let checked = 0;
  for (const s of sc.scenarios) {
    const order = requestOrder(sc.u, s).requests;
    const iy = order.findIndex((m) => then.has(m.to));
    if (iy < 0) continue;
    checked++;
    const ix = order.findIndex((m) => first.has(m.to));
    if (ix < 0 || ix > iy) {
      const where = sc.scenarios.length > 1 || a.scenario ? `In ${quote(s.name)}` : `In ${quote(sc.u.name)}`;
      return fail(
        ix < 0
          ? `${where}, ${order[iy].to} is called (${stepText(order[iy].step)}) but ${x} never is`
          : `${where}, ${order[iy].to} is called (${stepText(order[iy].step)}) before ${order[ix].to} (${stepText(order[ix].step)})`,
        `Call ${x} before the first call to ${y}`,
      );
    }
  }
  if (checked === 0) return fail(`${sc.label} never calls ${y}`, `Add a step to ${y} after the call to ${x}`);
  return pass(`${sc.label} calls ${x} before ${y}${checked > 1 ? ` in all ${checked} scenarios that call ${y}` : ''}`);
}

/**
 * `U never waits for X` (§7.1): no synchronous call (`->`, or a `-x` that
 * times out) to X on the critical path of the entry request, in any scenario.
 */
function neverWaits(run: Run, a: Extract<Assertion, { kind: 'neverWaits' }>): Check {
  const sc = scope(run, a.useCase, a.scenario);
  if (isCheck(sc)) return sc;
  const ids = idsOf(run, a.target);
  const what = selectorText(a.target);
  for (const s of sc.scenarios) {
    const hop = criticalPath(sc.u, s)
      .flat()
      .find((h) => !h.async && ids.has(h.target));
    if (hop) {
      const where = sc.scenarios.length > 1 ? quote(s.name) : sc.label;
      return fail(
        `${where} waits for ${nodeLabel(run.diagram, hop.target)} before responding: ${stepText(hop.step)}${hop.failed ? ' times out on the request path' : ' is synchronous'}`,
        `Send it with ->> (through a queue if it must not be lost), or move it after the line that answers the entry request`,
      );
    }
  }
  const calledAtAll = sc.scenarios.some((s) => s.steps.some((step) => ids.has(step.toServiceId)));
  return pass(`${sc.label} never waits for ${what}${calledAtAll ? '' : ` (it never calls ${what})`}`);
}

/**
 * `U calls Y after X` (§7.1): in every scenario that calls both, the last call
 * to Y comes after the first call to X; and some scenario calls both.
 */
function after(run: Run, a: Extract<Assertion, { kind: 'after' }>): Check {
  const sc = scope(run, a.useCase, a.scenario);
  if (isCheck(sc)) return sc;
  const targets = idsOf(run, a.target);
  const firsts = idsOf(run, a.after);
  const [y, x] = [selectorText(a.target), selectorText(a.after)];
  if (targets.size === 0) return noMatch(a.target);
  if (firsts.size === 0) return noMatch(a.after);
  let checked = 0;
  for (const s of sc.scenarios) {
    const order = requestOrder(sc.u, s).requests;
    const ix = order.findIndex((m) => firsts.has(m.to));
    const iy = order.map((m) => targets.has(m.to)).lastIndexOf(true);
    if (ix < 0 || iy < 0) continue;
    checked++;
    if (iy < ix) {
      const where = sc.scenarios.length > 1 || a.scenario ? `In ${quote(s.name)}` : `In ${quote(sc.u.name)}`;
      return fail(
        `${where}, the last call to ${y} (${stepText(order[iy].step)}) comes before the first call to ${x} (${stepText(order[ix].step)})`,
        `Call ${y} after ${x}: move the step to ${order[iy].to} below the call to ${order[ix].to}`,
      );
    }
  }
  if (checked === 0) {
    const callsY = sc.scenarios.some((s) => s.steps.some((step) => targets.has(step.toServiceId)));
    const callsX = sc.scenarios.some((s) => s.steps.some((step) => firsts.has(step.toServiceId)));
    const why = !callsY && !callsX ? `calls neither ${x} nor ${y}` : !callsY ? `never calls ${y}` : !callsX ? `never calls ${x}` : `never calls ${x} and ${y} in the same scenario`;
    return fail(`${sc.label} ${why}`, `Add a step to ${y} after the call to ${x}`);
  }
  return pass(`${sc.label} calls ${y} after ${x}${checked > 1 ? ` in all ${checked} scenarios that call both` : ''}`);
}

/** `[in U] X calls Y` / `[in U] X never calls Y` (§7.1): steps sent by a node matching X to one matching Y. */
function senderCalls(run: Run, a: Extract<Assertion, { kind: 'senderCalls' }>): Check {
  let useCases = run.diagram.useCases;
  if (a.useCase !== undefined) {
    const u = findUseCase(run.diagram, a.useCase);
    if (!u) return unknownUseCase(run, a.useCase);
    useCases = [u];
  }
  const from = idsOf(run, a.from);
  const to = idsOf(run, a.to);
  const [x, y] = [selectorText(a.from), selectorText(a.to)];
  const within = a.useCase !== undefined ? ` in ${quote(useCases[0].name)}` : '';
  for (const u of useCases) {
    for (const s of u.scenarios) {
      const step = s.steps.find((st) => from.has(st.fromServiceId) && to.has(st.toServiceId));
      if (!step) continue;
      const where = u.scenarios.length > 1 ? `${quote(u.name)} scenario ${quote(s.name)}` : quote(u.name);
      if (a.quantifier === 'some') return pass(`${x} calls ${y}${within}: ${stepText(step)} in ${where}`);
      return fail(
        `${x} calls ${y}${within}: ${stepText(step)} in ${where}`,
        `Let another node make this call (e.g. the client uploads to storage with a presigned URL), or remove the step`,
      );
    }
  }
  if (a.quantifier === 'never') return pass(`${x} never calls ${y}${within}`);
  if (from.size === 0) return noMatch(a.from);
  if (to.size === 0) return noMatch(a.to);
  return fail(`No step is sent by ${x} to ${y}${within}`, `Add a step ${[...from][0]} -> ${[...to][0]}${within}`);
}

/** `U starts at X` (§7.1): the entry request of every scenario is sent by a node matching X. */
function startsAt(run: Run, a: Extract<Assertion, { kind: 'startsAt' }>): Check {
  const u = findUseCase(run.diagram, a.useCase);
  if (!u) return unknownUseCase(run, a.useCase);
  const ids = idsOf(run, a.target);
  const what = selectorText(a.target);
  if (ids.size === 0) return noMatch(a.target);
  const entries = u.scenarios.map((s) => s.steps[0]).filter((s): s is DiagramStep => !!s);
  if (entries.length === 0) return fail(`${quote(u.name)} has no steps`, `Start "${u.name}" with a step sent by ${what}`);
  const wrong = entries.find((s) => !ids.has(s.fromServiceId));
  if (wrong) {
    return fail(
      `${quote(u.name)} starts at ${nodeLabel(run.diagram, wrong.fromServiceId)}, not ${what}: ${stepText(wrong)}`,
      `Make the first step of "${u.name}" a step sent by ${what}`,
    );
  }
  return pass(`${quote(u.name)} starts at ${nodeLabel(run.diagram, entries[0].fromServiceId)}`);
}

/** `201` exactly, or a class: `2xx`. */
function statusMatches(status: number | undefined, wanted: string): boolean {
  if (status === undefined) return false;
  const cls = /^([1-5])xx$/i.exec(wanted);
  return cls ? Math.floor(status / 100) === Number(cls[1]) : String(status) === wanted;
}

function responds(run: Run, a: Extract<Assertion, { kind: 'responds' }>): Check {
  const sc = scope(run, a.useCase, a.scenario);
  if (isCheck(sc)) return sc;
  const hit = sc.scenarios.find((s) => statusMatches(s.steps[0]?.statusCode, a.status));
  if (hit) return pass(`${sc.label} responds ${hit.steps[0].statusCode}${sc.scenarios.length > 1 ? ` in ${quote(hit.name)}` : ''}`);
  const seen = [...new Set(sc.scenarios.map((s) => (s.steps[0]?.failed ? 'a failed call' : (s.steps[0]?.statusCode ?? 'no status'))))];
  return fail(`${sc.label} never responds ${a.status}; it answers ${seen.join(', ') || 'nothing'}`, `Add a scenario (alt) whose entry request is answered with ${a.status}`);
}

/**
 * `no path from X to Y`: no architecture connection and no use case step goes
 * directly from a node matching X to one matching Y. (Chains through other
 * nodes are allowed: client → gateway → service → db is how a working design
 * reaches its database.)
 */
function noPath(run: Run, from: Selector, to: Selector): Check {
  const sources = idsOf(run, from);
  const targets = idsOf(run, to);
  const [x, y] = [selectorText(from), selectorText(to)];
  const hint = `Route it through a node that guards ${y} (a gateway or a service) instead of going there directly`;
  const edge = run.diagram.edges.find((e) => sources.has(e.source) && targets.has(e.target));
  if (edge) return fail(`The connection ${edge.source} -> ${edge.target} (${lineOf(edge.loc)}) goes directly from ${x} to ${y}`, hint);
  for (const u of run.diagram.useCases) {
    for (const s of u.scenarios) {
      const step = s.steps.find((st) => sources.has(st.fromServiceId) && targets.has(st.toServiceId));
      if (step) {
        const where = u.scenarios.length > 1 ? `${quote(u.name)} scenario ${quote(s.name)}` : quote(u.name);
        return fail(`The step ${step.fromServiceId} -> ${step.toServiceId} in ${where} (${lineOf(step.loc)}) goes directly from ${x} to ${y}`, hint);
      }
    }
  }
  return pass(`No connection or step goes directly from ${x} to ${y}`);
}
