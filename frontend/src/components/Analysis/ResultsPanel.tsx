import { CheckCircle2, ChevronRight, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Diagram, SourceLoc } from '../../dsl';
import type { Analysis, TestResult } from '../../sim';
import { AnalysisBody, NoTraffic } from './AnalysisPanel';
import ModelLink from './ModelLink';

interface ResultsPanelProps {
  diagram: Diagram;
  analysis: Analysis;
  results: TestResult[];
  /** Jumps to a requirement, test or node declaration. */
  onSelect: (loc: SourceLoc) => void;
  /** The design review (src/review/ReviewPanel.tsx), last. */
  review?: ReactNode;
}

/**
 * The editor's Results tab: what fails first, with its hint; what passes,
 * folded away; then the analysis (load, latency, availability and cost per
 * node) and the design review.
 */
export default function ResultsPanel({ diagram, analysis, results, onSelect, review }: ResultsPanelProps) {
  const hasTraffic = (diagram.traffic ?? []).length > 0;
  return (
    <div className="h-full overflow-y-auto bg-surface">
      <div className="max-w-4xl mx-auto px-4 py-4 space-y-6 text-sm">
        <Checks results={results} onSelect={onSelect} />
        {hasTraffic ? (
          <AnalysisBody diagram={diagram} analysis={analysis} results={results} onSelect={onSelect} />
        ) : (
          <section className="space-y-3 text-ink/75">
            <NoTraffic />
          </section>
        )}
        {review && (
          <section className="rounded-md border border-ink/15">
            <h2 className="px-3 pt-2 font-semibold text-ink">Review</h2>
            {review}
          </section>
        )}
      </div>
    </div>
  );
}

function Checks({ results, onSelect }: { results: TestResult[]; onSelect: (loc: SourceLoc) => void }) {
  const failing = results.filter((r) => !r.passed);
  const passing = results.filter((r) => r.passed);
  return (
    <section aria-labelledby="results-checks" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="results-checks" className="font-semibold text-ink">
          Requirements and tests
        </h2>
        <ModelLink />
      </div>
      {results.length === 0 ? (
        <NoChecks />
      ) : (
        <>
          <p className={`font-medium ${failing.length ? 'text-red-700 dark:text-red-300' : 'text-green-700 dark:text-green-300'}`}>
            {failing.length ? `${failing.length} of ${results.length} failing` : `All ${results.length} passing`}
          </p>
          {failing.length > 0 && <ResultList results={failing} onSelect={onSelect} />}
          {passing.length > 0 && (
            <details className="group rounded-md border border-ink/15">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 font-medium text-ink hover:bg-ink/5 [&::-webkit-details-marker]:hidden">
                <ChevronRight size={14} className="transition-transform group-open:rotate-90" aria-hidden="true" />
                {passing.length} passing
              </summary>
              <ResultList results={passing} onSelect={onSelect} flush />
            </details>
          )}
        </>
      )}
    </section>
  );
}

function ResultList({ results, onSelect, flush }: { results: TestResult[]; onSelect: (loc: SourceLoc) => void; flush?: boolean }) {
  return (
    <ul className={`divide-y divide-ink/10 ${flush ? 'border-t border-ink/15' : 'rounded-md border border-ink/15'}`}>
      {results.map((r) => (
        <li key={r.id} className="px-3 py-2">
          <Row passed={r.passed} title={r.name} message={r.message} hint={r.hint} loc={r.loc} onSelect={onSelect} strong />
          {r.assertions && r.assertions.length > 1 && (
            <ul className="mt-1 ml-6 space-y-1">
              {r.assertions.map((a, i) => (
                <li key={i}>
                  <Row passed={a.passed} message={a.message} hint={a.hint} loc={a.loc} onSelect={onSelect} />
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

interface RowProps {
  passed: boolean;
  title?: string;
  message: string;
  hint?: string;
  loc?: SourceLoc;
  onSelect: (loc: SourceLoc) => void;
  strong?: boolean;
}

function Row({ passed, title, message, hint, loc, onSelect, strong }: RowProps) {
  const Icon = passed ? CheckCircle2 : XCircle;
  return (
    <button
      onClick={() => loc && onSelect(loc)}
      disabled={!loc}
      className="w-full flex items-start gap-2 text-left rounded hover:bg-ink/5 disabled:hover:bg-transparent"
      title={loc ? `${loc.file ? `${loc.file}:` : 'Line '}${loc.line}` : undefined}
    >
      <Icon size={strong ? 16 : 14} className={`mt-0.5 flex-shrink-0 ${passed ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`} aria-label={passed ? 'passed' : 'failed'} />
      <span className="min-w-0">
        {title && <span className="block font-medium text-ink">{title}</span>}
        <span className={`block ${strong ? 'text-ink/75' : 'text-xs text-ink/75'}`}>{message}</span>
        {!passed && hint && <span className={`block text-amber-800 dark:text-amber-200 ${strong ? 'text-xs mt-0.5' : 'text-xs'}`}>{hint}</span>}
      </span>
      {loc && <span className="ml-auto flex-shrink-0 text-xs text-muted tabular-nums">{loc.file ? `${loc.file}:` : ''}{loc.line}</span>}
    </button>
  );
}

function NoChecks() {
  return (
    <div className="space-y-3 text-ink/75">
      <p>No requirements or tests yet. Requirements are checked against the analysis of your traffic; tests check how the flows work.</p>
      <pre className="rounded-md bg-paper border border-ink/15 px-3 py-2 text-xs text-ink overflow-x-auto">
        {`requirements {
  p99 "Redirect" < 100ms
  availability >= 99.9%
  durable "Shorten"
  survive any node failure
}

test "Redirect is served from the cache" {
  "Redirect" calls any cache before any database
}`}
      </pre>
    </div>
  );
}
