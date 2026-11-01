import { AlertTriangle, Info, ShieldAlert } from 'lucide-react';
import type { Diagram, SourceLoc } from '../../dsl';
import ModelLink from './ModelLink';
import { HOT, formatAvailability, formatMs, formatPercent, formatRps, formatUsd, type Analysis, type NodeAnalysis, type TestResult } from '../../sim';
import { systemSummaries } from '../Canvas/systemSummary';

interface AnalysisPanelProps {
  diagram: Diagram;
  analysis: Analysis;
  /** Jumps to a node's declaration. */
  onSelect: (loc: SourceLoc) => void;
  /** The test results, for who to ask about a system that cannot take its load. */
  results?: TestResult[];
}

const PERCENTILES = ['p50', 'p95', 'p99', 'p999'] as const;

/** Capacity, latency, availability and cost of the design under its `traffic`, as a pane of its own (practice). */
export default function AnalysisPanel(props: AnalysisPanelProps) {
  if ((props.diagram.traffic ?? []).length === 0) return <EmptyState />;
  return (
    <div className="h-full overflow-y-auto bg-surface">
      <div className="max-w-4xl mx-auto px-4 py-4 space-y-6 text-sm">
        <ModelLink />
        <AnalysisBody {...props} />
      </div>
    </div>
  );
}

/** The analysis itself, for a document with traffic: headline numbers, nodes, use cases and single points of failure. */
export function AnalysisBody({ diagram, analysis, onSelect, results }: AnalysisPanelProps) {
  const byId = new Map(diagram.nodes.map((n) => [n.id, n]));
  const nodes = analysis.nodes.filter((n) => n.kind !== 'client' && n.kind !== 'other');
  const saturated = nodes.filter((n) => n.saturated).length;

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat
          label="Total cost"
          value={formatUsd(analysis.totalCostUsd)}
          note={analysis.totalEgressUsd > 0 ? `incl. ${formatUsd(analysis.totalEgressUsd).replace('/month', '')} egress` : undefined}
        />
        <Stat label="Saturated nodes" value={String(saturated)} tone={saturated ? 'bad' : 'good'} />
        <Stat label="Single points of failure" value={String(analysis.singlePointsOfFailure.length)} tone={analysis.singlePointsOfFailure.length ? 'warn' : 'good'} />
        <Stat label="Use cases with traffic" value={String(analysis.useCases.filter((u) => u.rps > 0).length)} />
      </div>

      {analysis.warnings.length > 0 && (
        <ul className="space-y-1">
          {analysis.warnings.map((w) => (
            <li key={w} className="flex items-start gap-2 rounded-md bg-amber-50 dark:bg-amber-950/40 px-3 py-1.5 text-amber-900 dark:text-amber-100">
              <AlertTriangle size={14} className="mt-0.5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
              {w}
            </li>
          ))}
        </ul>
      )}

      {(analysis.systems?.length ?? 0) > 0 && <Systems diagram={diagram} analysis={analysis} results={results ?? []} onSelect={onSelect} />}

      <section>
        <h2 className="mb-2 font-semibold text-ink">Nodes</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left tabular-nums">
            <thead className="text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-1 pr-3 font-medium">Node</th>
                <th className="py-1 pr-3 font-medium">Load / capacity</th>
                <th className="py-1 pr-3 font-medium w-40">Utilisation</th>
                <th className="py-1 pr-3 font-medium text-right">Latency</th>
                <th className="py-1 pr-3 font-medium text-right">Availability</th>
                <th className="py-1 font-medium text-right">Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink/10">
              {nodes.map((n) => {
                const node = byId.get(n.id);
                return (
                  <tr key={n.id}>
                    <td className="py-1.5 pr-3">
                      <button
                        onClick={() => node && !node.loc.file && onSelect(node.loc)}
                        className="text-left hover:underline"
                        title={node?.loc.file ? `Declared in ${node.loc.file}` : 'Go to the declaration'}
                      >
                        <span className="font-medium text-ink">{n.id}</span>
                        {n.replicas > 1 && <span className="ml-1 text-muted">×{n.replicas}</span>}
                        <span className="block text-xs text-muted">
                          {node && !node.implicit ? node.techStack : n.kind} · {n.kind}
                          {n.durable ? ' · durable' : ''}
                          {n.consistency ? ` · ${n.consistency}` : ''}
                        </span>
                      </button>
                    </td>
                    <td className="py-1.5 pr-3 text-ink/85 whitespace-nowrap">
                      {splitsReadsAndWrites(n) ? (
                        <>
                          <span className="block" title="Reads: load / capacity">
                            <span className="text-xs text-muted">R </span>
                            {formatRps(n.readLoadRps)} <span className="text-muted">/ {formatRps(n.readCapacityRps)}</span>
                          </span>
                          <span className="block" title={n.writeScaling === 'shards' ? 'Writes: load / capacity (one primary per shard)' : 'Writes: load / capacity'}>
                            <span className="text-xs text-muted">W </span>
                            {formatRps(n.writeLoadRps)} <span className="text-muted">/ {formatRps(n.writeCapacityRps)}</span>
                          </span>
                        </>
                      ) : (
                        <>
                          {formatRps(n.loadRps)} <span className="text-muted">/ {formatRps(n.capacityRps)}</span>
                        </>
                      )}
                    </td>
                    <td className="py-1.5 pr-3">
                      <UtilizationBar node={n} />
                    </td>
                    <td className="py-1.5 pr-3 text-right text-ink/85 whitespace-nowrap">{formatMs(n.latencyMs)}</td>
                    <td className="py-1.5 pr-3 text-right text-ink/85">{formatAvailability(n.availability)}</td>
                    <td className="py-1.5 text-right text-ink/85">
                      {formatUsd(n.costUsd).replace('/month', '')}
                      {n.egressUsd > 0 && (
                        <span className="block text-xs text-muted" title={`${formatGb(n.egressGbPerMonth)} a month sent to clients and third parties`}>
                          {formatUsd(n.egressUsd).replace('/month', '')} egress
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-1 font-semibold text-ink">Use cases</h2>
        <p className="mb-2 text-xs text-muted">
          Percentiles are over all requests, the scenarios mixed by their shares: with 10% cache misses, p99 is close to the miss path's
          p90.
        </p>
        <div className="space-y-3">
          {analysis.useCases.map((u) => (
            <div key={u.id} className="rounded-md border border-ink/15">
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-3 py-2 bg-paper border-b border-ink/15">
                <span className="font-medium text-ink">{u.name}</span>
                <span className="text-muted tabular-nums">{u.rps > 0 ? formatRps(u.rps) : 'no traffic'}</span>
                <span className="text-muted tabular-nums">availability {formatAvailability(u.availability)}</span>
                <span className="ml-auto flex gap-3 tabular-nums">
                  {PERCENTILES.map((p) => (
                    <span key={p} className="text-ink/85">
                      <span className="text-xs text-muted">{p} </span>
                      {formatMs(u.percentiles[p])}
                    </span>
                  ))}
                </span>
              </div>
              {u.scenarios.length > 1 && (
                <table className="w-full text-left tabular-nums text-xs">
                  <tbody className="divide-y divide-ink/10">
                    {u.scenarios.map((s) => (
                      <tr key={s.id} className={s.share > 0 ? 'text-ink/85' : 'text-muted'}>
                        <td className="px-3 py-1">{s.name}</td>
                        <td className="px-3 py-1 text-right">{formatPercent(s.share)} of traffic</td>
                        <td className="px-3 py-1 text-right">mean {formatMs(s.meanMs)}</td>
                        <td className="px-3 py-1 text-right">p99 {formatMs(s.percentiles.p99)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      </section>

      {analysis.singlePointsOfFailure.length > 0 && (
        <section>
          <h2 className="mb-2 font-semibold text-ink">Single points of failure</h2>
          <p className="flex items-start gap-2 text-ink/85">
            <ShieldAlert size={16} className="mt-0.5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
            <span>
              {analysis.singlePointsOfFailure.join(', ')}: one replica, and a use case cannot do without it. Add <code>x2</code> to the declaration or a
              fallback scenario that calls it with <code>-x</code> and still completes.
            </span>
          </p>
        </section>
      )}

      <p className="flex items-start gap-2 text-xs text-muted">
        <Info size={14} className="mt-px flex-shrink-0" />
        <span>
          The numbers come from default profiles per technology (teaching values, right to an order of magnitude) and a simple queueing
          model. Relational databases take writes on one primary per shard, so read replicas add reads only; egress is charged for data a node sends to
          clients and third parties ($0.09/GB, from a CDN $0.02/GB). Override the numbers with <code>capacity {'{ … }'}</code>.
        </span>
      </p>
    </>
  );
}

/** Per system (docs/design/team-systems-and-imports.md): what it is sent against what its design takes, and whether it holds its promise. */
function Systems({ diagram, analysis, results, onSelect }: Required<AnalysisPanelProps>) {
  const summaries = systemSummaries(diagram, analysis, results, diagram, '');
  return (
    <section aria-labelledby="analysis-systems">
      <h2 id="analysis-systems" className="mb-1 font-semibold text-ink">
        Systems
      </h2>
      <p className="mb-2 text-xs text-muted">Each team's design under its own traffic plus what this diagram sends it; it takes the extra load shown before a node saturates.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left tabular-nums">
          <thead className="text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="py-1 pr-3 font-medium">System</th>
              <th className="py-1 pr-3 font-medium">Sent / takes</th>
              <th className="py-1 pr-3 font-medium">Promise</th>
              <th className="py-1 pr-3 font-medium text-right whitespace-nowrap">p99 seen</th>
              <th className="py-1 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink/10">
            {(analysis.systems ?? []).map((sa) => {
              const s = summaries.get(sa.id);
              const node = diagram.nodes.find((n) => n.id === sa.id);
              const system = diagram.systems?.find((x) => x.id === sa.id);
              if (!s || !node) return null;
              const tone = s.status === 'over' ? 'text-red-700 dark:text-red-300 font-semibold' : s.status === 'hot' ? 'text-amber-700 dark:text-amber-300 font-semibold' : 'text-ink/75';
              const p99 = Math.max(0, ...sa.entries.map((e) => e.p99Ms));
              return (
                <tr key={sa.id} className="align-top">
                  <td className="py-1.5 pr-3">
                    <button onClick={() => system && onSelect(system.loc)} className="text-left hover:underline" title="Go to the system block">
                      <span className="font-medium text-ink">{node.name}</span>
                      <span className="block text-xs text-muted">
                        {node.ownerTeam ? `@${node.ownerTeam} · ` : ''}
                        {s.linked ? s.file : s.stub ? 'declared, no design linked' : 'not simulated'}
                      </span>
                    </button>
                  </td>
                  <td className="py-1.5 pr-3 text-ink/85 whitespace-nowrap">
                    {s.ports.map((p) => (
                      <span key={p.id} className="block" title={p.useCase ? `Into "${p.useCase}"` : undefined}>
                        <span className="text-xs text-muted">{p.id} </span>
                        {formatRps(p.sentRps)} <span className="text-muted">/ {Number.isFinite(p.limitRps) ? formatRps(p.limitRps) : 'any'}</span>
                      </span>
                    ))}
                  </td>
                  <td className="py-1.5 pr-3 text-ink/85 whitespace-nowrap">{s.promise ?? <span className="text-muted">none stated</span>}</td>
                  <td className="py-1.5 pr-3 text-right text-ink/85 whitespace-nowrap">{s.status === 'unsimulated' ? '—' : formatMs(p99)}</td>
                  <td className="py-1.5">
                    <span className={`text-xs ${tone}`}>{s.label}</span>
                    {s.hint && <span className="block text-xs text-amber-800 dark:text-amber-200">{s.hint}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Stat({ label, value, tone, note }: { label: string; value: string; tone?: 'good' | 'warn' | 'bad'; note?: string }) {
  const color = tone === 'bad' ? 'text-red-700 dark:text-red-300' : tone === 'warn' ? 'text-amber-700 dark:text-amber-300' : tone === 'good' ? 'text-green-700 dark:text-green-300' : 'text-ink';
  return (
    <div className="rounded-md border border-ink/15 px-3 py-2">
      <div className="text-xs text-muted">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${color}`}>{value}</div>
      {note && <div className="text-xs text-muted tabular-nums">{note}</div>}
    </div>
  );
}

/**
 * Reads and writes get their own line when they have separate capacity: a
 * single-primary store (writes on the primary), or overrides that differ.
 */
function splitsReadsAndWrites(n: NodeAnalysis): boolean {
  return n.writeLoadRps > 0 && (n.writeScaling === 'shards' || n.readCapacityRps !== n.writeCapacityRps);
}

/** `2.6 TB`, `260 GB` */
function formatGb(gb: number): string {
  return gb >= 1000 ? `${Number((gb / 1000).toFixed(1))} TB` : `${Number(gb.toFixed(gb < 10 ? 1 : 0))} GB`;
}

/** Red when saturated, amber above 70%, green otherwise. */
function UtilizationBar({ node }: { node: NodeAnalysis }) {
  const color = node.saturated ? 'bg-red-500' : node.utilization > HOT ? 'bg-amber-500' : 'bg-green-500';
  const text = node.saturated ? 'text-red-700 dark:text-red-300 font-medium' : node.utilization > HOT ? 'text-amber-700 dark:text-amber-300' : 'text-ink/75';
  return (
    <div className="flex flex-wrap items-center gap-x-2" title={node.saturated ? 'Saturated: more load than capacity' : undefined}>
      <div className="h-2 w-24 rounded-full bg-ink/5 overflow-hidden" role="meter" aria-valuenow={Math.round(node.utilization * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full ${color}`} style={{ width: `${Math.min(100, node.utilization * 100)}%` }} />
      </div>
      <span className={`text-xs ${text}`}>{formatPercent(node.utilization)}</span>
      {splitsReadsAndWrites(node) && (
        <span className="text-xs text-muted whitespace-nowrap" title="Read and write utilisation">
          R {formatPercent(node.readUtilization)} · W {formatPercent(node.writeUtilization)}
        </span>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="h-full overflow-y-auto bg-surface">
      <div className="max-w-lg mx-auto px-6 py-10 text-sm text-ink/75 space-y-3">
        <NoTraffic />
        <p>
          Add <code>requirements {'{ … }'}</code> (latency, availability, durability, cost) and <code>test "…" {'{ … }'}</code> blocks to check the design
          against it.
        </p>
      </div>
    </div>
  );
}

/** What to add for an analysis: a `traffic` block. */
export function NoTraffic() {
  return (
    <>
      <h2 className="text-base font-semibold text-ink">No traffic yet</h2>
      <p>Say how many requests each use case gets, and Proschi estimates load, latency, availability and cost for every node:</p>
      <pre className="rounded-md bg-paper border border-ink/15 px-3 py-2 text-xs text-ink overflow-x-auto">
        {`traffic {
  "Redirect" 10k rps  mix "Cache hit" 90%, "Cache miss" 10%
  "Shorten"  100 rps
}`}
      </pre>
    </>
  );
}
