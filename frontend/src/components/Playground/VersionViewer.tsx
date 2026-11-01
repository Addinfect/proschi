import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, History, RotateCcw } from 'lucide-react';
import { diffDiagrams, parse, summarizeDiff, type Diagram, type DiagramDiff } from '../../dsl';
import { DIFF_SECTIONS, type DiffSection, type FieldChange } from '../../dsl/diff';
import { analyze, formatAvailability, formatMs, formatRps, formatUsd, requirementName, runTests } from '../../sim';
import { filesResolver } from '../../playground/imports';
import { getVersion, type VersionContent, type VersionInfo } from '../../playground/versions';
import DiagramCanvas from '../Diagram/DiagramCanvas';
import { useDiagramLayout } from '../Diagram/useDiagramLayout';
import CodeEditor from './CodeEditor';
import { eyebrow, field, outlineButton, primaryButton, subBar } from './ui';

/** A side of a comparison: a version's tag, or DRAFT for the diagram being edited. */
const DRAFT = '';
const NO_IDS: string[] = [];

export type VersionMode = { kind: 'view'; tag: string } | { kind: 'compare'; base: string; target: string };

interface VersionViewerProps {
  docId: string;
  fileName: string;
  versions: VersionInfo[];
  mode: VersionMode;
  onMode: (mode: VersionMode) => void;
  /** The draft and the files its imports read. */
  draft: { source: string; files: Record<string, string> };
  /** The cloud versions fetched for the draft, which a version may read too. */
  cloudFiles: Record<string, string>;
  onClose: () => void;
  /** Replaces the draft's text with a version's. */
  onRestore: (source: string, tag: string) => void;
}

const SECTION_LABEL: Record<DiffSection, string> = {
  nodes: 'Components',
  edges: 'Connections',
  useCases: 'Use cases',
  scenarios: 'Scenarios',
  requirements: 'Requirements',
  traffic: 'Traffic',
  capacity: 'Capacity',
  systems: 'Systems',
};

/** How an added or removed item reads in the change list. */
function itemLabel(section: DiffSection, item: unknown): string {
  const any = item as Record<string, unknown>;
  switch (section) {
    case 'nodes':
      return any.name && any.name !== any.id ? `${String(any.name)} (${String(any.id)})` : String(any.id);
    case 'edges':
      return `${String(any.source)} → ${String(any.target)}${any.label ? ` : ${String(any.label)}` : ''}`;
    case 'useCases':
      return String(any.name);
    case 'scenarios': {
      const { useCase, scenario } = item as { useCase: string; scenario: { name: string } };
      return `${useCase} › ${scenario.name}`;
    }
    case 'requirements':
      return requirementName(item as Parameters<typeof requirementName>[0]);
    case 'traffic':
      return String(any.useCase);
    case 'capacity':
      return String(any.node);
    case 'systems':
      return String(any.id);
  }
}

function valueText(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.length ? value.join('; ') : '—';
  return JSON.stringify(value);
}

/** A few numbers of the simulation, to put two designs side by side. */
function keyNumbers(diagram: Diagram): [string, string][] {
  const analysis = analyze(diagram);
  const tests = runTests(diagram, analysis);
  const busy = analysis.useCases.filter((u) => u.rps > 0);
  const p99 = Math.max(...busy.map((u) => u.percentiles.p99).filter(Number.isFinite));
  return [
    ['Traffic', busy.length ? formatRps(busy.reduce((sum, u) => sum + u.rps, 0)) : '—'],
    ['Worst p99', busy.length && Number.isFinite(p99) ? formatMs(p99) : '—'],
    ['Availability', busy.length ? formatAvailability(Math.min(...busy.map((u) => u.availability))) : '—'],
    ['Cost', analysis.totalCostUsd > 0 ? formatUsd(analysis.totalCostUsd) : '—'],
    ['Tests', tests.length ? `${tests.filter((t) => t.passed).length} of ${tests.length} pass` : '—'],
  ];
}

/** Marks the nodes the target added or changed, and the others as the same (canvas.css styles them). */
function highlighted<T extends { id: string; className?: string }>(nodes: T[], diff: DiagramDiff | null): T[] {
  if (!diff) return nodes;
  const added = new Set(diff.nodes.added.map((n) => n.id));
  const changed = new Set(diff.nodes.changed.map((c) => c.key));
  if (added.size + changed.size === 0) return nodes;
  // The rest steps back, so what changed reads first.
  return nodes.map((n) => ({ ...n, className: added.has(n.id) ? 'pc-diff-added' : changed.has(n.id) ? 'pc-diff-changed' : 'pc-diff-same' }));
}

/**
 * A saved version, read-only, or two states of the diagram compared: the
 * target drawn with what it added or changed marked, the list of changes,
 * and a few simulation numbers side by side. Over the whole editor; the
 * draft underneath is untouched.
 */
export default function VersionViewer({ docId, fileName, versions, mode, onMode, draft, cloudFiles, onClose, onRestore }: VersionViewerProps) {
  const [contents, setContents] = useState<Record<string, VersionContent | { error: string }>>({});
  const needed = mode.kind === 'view' ? [mode.tag] : [mode.base, mode.target].filter((t) => t !== DRAFT);
  const neededKey = needed.join('\n');

  useEffect(() => {
    let cancelled = false;
    for (const tag of neededKey.split('\n')) {
      if (!tag || contents[tag]) continue;
      getVersion(docId, tag).then(
        (version) => !cancelled && setContents((c) => ({ ...c, [tag]: version })),
        (e: unknown) => !cancelled && setContents((c) => ({ ...c, [tag]: { error: e instanceof Error ? e.message : String(e) } })),
      );
    }
    return () => {
      cancelled = true;
    };
    // `contents` is read to skip what is fetched already; fetching again on its change would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, neededKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const versionOf = (tag: string) => {
    const c = contents[tag];
    return c && 'source' in c ? c : undefined;
  };
  const errorOf = needed.map((t) => contents[t]).find((c): c is { error: string } => !!c && 'error' in c)?.error;

  /** The parsed side, or null while its version loads. */
  const sideOf = (tag: string): Diagram | null => {
    if (tag === DRAFT) return parse(draft.source, { path: fileName, resolve: filesResolver(draft.files, fileName) }).diagram;
    const v = versionOf(tag);
    return v ? parse(v.source, { path: fileName, resolve: filesResolver({ ...cloudFiles, ...(v.imports ?? {}) }, fileName) }).diagram : null;
  };
  const shownTag = mode.kind === 'view' ? mode.tag : mode.target;
  const baseTag = mode.kind === 'compare' ? mode.base : undefined;
  const loaded = needed.every((t) => versionOf(t));
  // Parsed once per side and content, not on every render.
  const sideKey = `${shownTag}\n${baseTag ?? ''}\n${loaded}`;
  const { target, base } = useMemo(
    () => ({ target: sideOf(shownTag), base: baseTag === undefined ? null : sideOf(baseTag) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sideKey, draft, cloudFiles],
  );
  const empty = useMemo(() => parse('').diagram, []);
  const { nodes, edges, settled } = useDiagramLayout(target ?? empty);
  const diff = useMemo(() => (base && target ? diffDiagrams(base, target) : null), [base, target]);
  const shownNodes = useMemo(() => highlighted(nodes, diff), [nodes, diff]);
  const numbers = useMemo(() => (mode.kind === 'compare' && base && target ? { base: keyNumbers(base), target: keyNumbers(target) } : null), [mode.kind, base, target]);

  // Zoom buttons would cover the small canvas of a phone; pinching still zooms.
  const phone = window.matchMedia('(max-width: 767px)').matches;
  const label = (tag: string) => (tag === DRAFT ? 'Current draft' : tag);
  const sidePicker = (value: string, aria: string, onPick: (tag: string) => void) => (
    <select aria-label={aria} value={value} onChange={(e) => onPick(e.target.value)} className={`${field} min-w-0 max-sm:flex-1 sm:max-w-[11rem]`}>
      <option value={DRAFT}>Current draft</option>
      {versions.map((v, i) => (
        <option key={v.tag} value={v.tag}>
          {v.tag}
          {i === 0 ? ' (latest)' : ''}
        </option>
      ))}
    </select>
  );

  const canvas = (
    <div className="relative min-h-0 flex-1 bg-paper" data-testid="version-canvas">
      {target ? (
        <DiagramCanvas nodes={shownNodes} edges={edges} fitKey={`${shownTag}:${settled}`} legend={target.legend} compact={phone} />
      ) : (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-muted">{errorOf ? `Could not open the version: ${errorOf}` : 'Loading the version…'}</p>
      )}
      {diff && (diff.nodes.added.length > 0 || diff.nodes.changed.length > 0) && (
        <div className="pointer-events-none absolute left-3 top-3 flex gap-2 text-xs font-semibold">
          <span className="rounded border border-pass/50 bg-surface px-1.5 py-0.5 text-ink"><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-pass" />new</span>
          <span className="rounded border border-pop-blue/50 bg-surface px-1.5 py-0.5 text-ink"><span className="mr-1 inline-block h-2 w-2 rounded-sm bg-pop-blue" />changed</span>
        </div>
      )}
    </div>
  );

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-paper text-ink" role="dialog" aria-label={mode.kind === 'view' ? `Version ${mode.tag}` : 'Compare versions'}>
      <div className={`flex flex-wrap items-center gap-2 px-3 py-2 ${subBar}`}>
        <button type="button" onClick={onClose} aria-label="Back to draft" className={outlineButton}>
          <ArrowLeft size={16} />
          <span className="max-sm:hidden">Back to draft</span>
        </button>
        {mode.kind === 'view' ? (
          <>
            <p role="status" className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-semibold max-sm:order-first max-sm:basis-full">
              <History size={16} aria-hidden="true" className="flex-none text-muted" />
              <span className="truncate">
                Version <span className="font-mono">{mode.tag}</span> · read-only
              </span>
            </p>
            <button type="button" className={outlineButton} onClick={() => onMode({ kind: 'compare', base: mode.tag, target: DRAFT })}>
              <span>Compare<span className="max-sm:hidden"> with draft</span></span>
            </button>
            <button
              type="button"
              className={primaryButton}
              disabled={!versionOf(mode.tag)}
              onClick={() => {
                const v = versionOf(mode.tag);
                if (v) onRestore(v.source, mode.tag);
              }}
            >
              <RotateCcw size={16} />
              <span>Restore<span className="max-sm:hidden"> into draft</span></span>
            </button>
          </>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className={`max-sm:hidden ${eyebrow}`}>Compare</span>
            {sidePicker(mode.base, 'Base', (tag) => onMode({ ...mode, base: tag }))}
            <ArrowRight size={16} aria-hidden="true" className="flex-none text-muted" />
            {sidePicker(mode.target, 'Target', (tag) => onMode({ ...mode, target: tag }))}
          </div>
        )}
      </div>

      {mode.kind === 'view' ? (
        <div className="flex min-h-0 flex-1 flex-col md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div className="flex min-h-0 flex-1 flex-col max-md:order-2 md:border-r-bw-1 md:border-ink">
            {versionOf(mode.tag)?.note && <p className="border-b border-ink/15 px-3 py-1.5 text-sm text-ink/80">{versionOf(mode.tag)!.note}</p>}
            <div className="min-h-0 flex-1">
              <CodeEditor key={mode.tag} value={versionOf(mode.tag)?.source ?? ''} onChange={() => undefined} diagnostics={[]} nodeIds={NO_IDS} readOnly />
            </div>
          </div>
          <div className="flex min-h-[45%] flex-1 flex-col max-md:order-1 max-md:border-b-bw-1 max-md:border-ink">{canvas}</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:grid md:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)]">
          <aside className="min-h-0 overflow-y-auto p-4 max-md:order-2 max-md:flex-1 md:border-r-bw-1 md:border-ink" aria-label="Changes">
            {diff && numbers ? <Summary diff={diff} numbers={numbers} base={label(mode.base)} target={label(mode.target)} /> : <p className="text-sm text-muted">{errorOf ?? 'Loading…'}</p>}
          </aside>
          <div className="flex min-h-[45%] flex-1 flex-col max-md:order-1 max-md:border-b-bw-1 max-md:border-ink">{canvas}</div>
        </div>
      )}
    </div>
  );
}

function Summary({ diff, numbers, base, target }: { diff: DiagramDiff; numbers: { base: [string, string][]; target: [string, string][] }; base: string; target: string }) {
  const counts = summarizeDiff(diff).total;
  const sections = DIFF_SECTIONS.filter((s) => {
    const d = diff[s];
    return d.added.length + d.removed.length + d.changed.length > 0;
  });
  const none = sections.length === 0 && diff.diagram.length === 0;
  return (
    <div className="grid gap-5">
      <section>
        <h3 className={eyebrow}>Simulation</h3>
        <table className="mt-1.5 w-full text-sm tabular-nums">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="py-1 font-semibold" />
              <th className="py-1 font-mono font-semibold">{base}</th>
              <th className="py-1 font-mono font-semibold">{target}</th>
            </tr>
          </thead>
          <tbody>
            {numbers.target.map(([name, after], i) => {
              const before = numbers.base[i][1];
              return (
                <tr key={name} className="border-t border-ink/10">
                  <th scope="row" className="py-1 pr-2 text-left font-semibold">
                    {name}
                  </th>
                  <td className="py-1 pr-2 text-muted">{before}</td>
                  <td className={`py-1 ${before !== after ? 'font-bold' : 'text-muted'}`}>{after}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section>
        <h3 className={eyebrow}>Changes</h3>
        {none ? (
          <p className="mt-1.5 text-sm text-muted">No changes: the two are the same design.</p>
        ) : (
          <p className="mt-1.5 text-sm" data-testid="diff-counts">
            <span className="font-semibold text-pass">{counts.added} added</span> · <span className="font-semibold text-fail">{counts.removed} removed</span> ·{' '}
            <span className="font-semibold text-pop-blue">{counts.changed} changed</span>
          </p>
        )}
        {diff.diagram.length > 0 && <FieldList changes={diff.diagram} />}
        {sections.map((s) => {
          const d = diff[s];
          return (
            <div key={s} className="mt-3">
              <h4 className="text-sm font-bold">{SECTION_LABEL[s]}</h4>
              <ul className="mt-1 grid gap-1 text-sm">
                {d.added.map((item, i) => (
                  <li key={`a${i}`} className="flex gap-2">
                    <span aria-label="added" className="w-4 flex-none text-center font-bold text-pass">+</span>
                    <span className="min-w-0 break-words">{itemLabel(s, item)}</span>
                  </li>
                ))}
                {d.removed.map((item, i) => (
                  <li key={`r${i}`} className="flex gap-2">
                    <span aria-label="removed" className="w-4 flex-none text-center font-bold text-fail">−</span>
                    <span className="min-w-0 break-words line-through decoration-ink/30">{itemLabel(s, item)}</span>
                  </li>
                ))}
                {d.changed.map((c) => (
                  <li key={c.key} className="flex gap-2">
                    <span aria-label="changed" className="w-4 flex-none text-center font-bold text-pop-blue">~</span>
                    <div className="min-w-0">
                      <span className="break-words">{itemLabel(s, c.after)}</span>
                      <FieldList changes={c.changes} />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </section>
    </div>
  );
}

function FieldList({ changes }: { changes: FieldChange[] }) {
  return (
    <ul className="mt-0.5 grid gap-0.5 text-xs text-muted">
      {changes.map((c) => (
        <li key={c.field} className="break-words">
          <span className="font-semibold text-ink/80">{c.field}</span> <span className="font-mono">{valueText(c.before)}</span> → <span className="font-mono text-ink">{valueText(c.after)}</span>
        </li>
      ))}
    </ul>
  );
}
