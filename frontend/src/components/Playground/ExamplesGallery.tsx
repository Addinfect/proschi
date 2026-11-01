import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Lock, Search, X } from 'lucide-react';
import listings from 'virtual:practice-listings';
import { examples, mapResolver, parse } from '../../dsl';
import { DRONE_ORG_PATH, DRONE_TEAM_FILES, droneOrgSource } from '../../playground/droneStartup';
import { TAG_ORDER, matchesGallery, patternTags, solutionSource, type GalleryItem } from '../../playground/gallery';
import { loadProgress, statusOf } from '../../practice/progress';
import { eyebrow, field } from './ui';

interface ExamplesGalleryProps {
  /** Opens a source as a new diagram, with the files it imports (path → source) saved beside it. */
  onPick: (source: string, files?: Readonly<Record<string, string>>) => void;
  onClose: () => void;
}

type Entry = GalleryItem & { source: string; files?: Readonly<Record<string, string>>; stats: string };

function entryOf(id: string, title: string, description: string, source: string, files?: Readonly<Record<string, string>>): Entry {
  const { diagram } = parse(source, files ? { path: DRONE_ORG_PATH, resolve: mapResolver({ ...files }) } : undefined);
  const useCases = diagram.useCases.length;
  return {
    id,
    title,
    description,
    source,
    ...(files ? { files } : {}),
    tags: patternTags(diagram),
    keywords: [...new Set(diagram.nodes.map((n) => n.techStack))].join(' '),
    stats: `${diagram.nodes.filter((n) => n.kind === 'component' || n.kind === 'system').length} nodes · ${useCases} use case${useCases === 1 ? '' : 's'}`,
  };
}

const card = 'ps-card text-left !p-4 !shadow-brutal-sm';

/**
 * "Start from…": the bundled examples and the reference solutions of the
 * practice problems solved in this browser, searchable and filtered by
 * pattern tags derived from each design. Unsolved problems are listed
 * without their solution, with a link to solve them: a solution is the
 * answer to a problem, so it is only shown once the problem is solved.
 */
export default function ExamplesGallery({ onPick, onClose }: ExamplesGalleryProps) {
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | undefined>();
  const exampleEntries = useMemo(
    () => [
      ...examples.map((e) => entryOf(e.id, e.name, e.description, e.source)),
      // An org diagram whose teams are systems, each team's design in its own file.
      entryOf('drone-startup', 'Drone startup (team systems)', 'An org of teams, each a system box with its own design in a file: open one to edit it.', droneOrgSource(), DRONE_TEAM_FILES),
    ],
    [],
  );
  const progress = useMemo(loadProgress, []);
  const solved = useMemo(() => listings.filter((p) => statusOf(progress, p.id) === 'solved'), [progress]);
  const locked = useMemo(() => listings.filter((p) => statusOf(progress, p.id) !== 'solved'), [progress]);
  const [solutions, setSolutions] = useState<Entry[] | null>(solved.length ? null : []);

  useEffect(() => {
    if (solutions) return;
    let live = true;
    // The answers load only for a browser that has solved something, and only the solved ones are shown.
    import('../../playground/referenceSolutions').then(({ referenceSolution }) => {
      if (!live) return;
      const entries = solved.flatMap((p) => {
        const files = referenceSolution(p.id);
        return files ? [entryOf(`solution-${p.id}`, p.title, p.summary, solutionSource(files.given, files.solution, p.title))] : [];
      });
      setSolutions(entries);
    });
    return () => {
      live = false;
    };
  }, [solutions, solved]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const all = [...exampleEntries, ...(solutions ?? [])];
  const tags = TAG_ORDER.filter((t) => all.some((e) => e.tags.includes(t)));
  const shownExamples = exampleEntries.filter((e) => matchesGallery(e, query, tag));
  const shownSolutions = (solutions ?? []).filter((e) => matchesGallery(e, query, tag));
  // Locked problems match on their public tags and summary only; pattern tags would give their designs away.
  const shownLocked = tag ? [] : locked.filter((p) => matchesGallery({ id: p.id, title: p.title, description: p.summary, tags: p.tags }, query));
  const nothing = !shownExamples.length && !shownSolutions.length && !shownLocked.length;

  const entryButton = (entry: Entry, solution: boolean) => (
    <button
      key={entry.id}
      onClick={() => onPick(entry.source, entry.files)}
      aria-label={solution ? `Reference solution: ${entry.title}` : entry.title}
      className={`${card} ps-card--interactive hover:!shadow-brutal-md`}
    >
      {solution && (
        <div className={`${eyebrow} mb-1 flex items-center gap-1 !text-pass`}>
          <CheckCircle2 size={12} aria-hidden="true" /> Solved · reference solution
        </div>
      )}
      <div className="font-display text-lg font-bold leading-tight text-ink">{entry.title}</div>
      <div className="mt-1 text-sm text-ink/75">{entry.description}</div>
      <div className="mt-2 font-mono text-xs text-muted">{entry.stats}</div>
      {entry.tags.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1" aria-label="Patterns">
          {entry.tags.map((t) => (
            <li key={t} className="rounded border border-ink/20 px-1.5 py-px text-[11px] text-ink/80">
              {t}
            </li>
          ))}
        </ul>
      )}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="Examples"
        className="flex w-full max-w-4xl max-h-[88vh] flex-col overflow-hidden rounded-brutal border-bw-2 border-ink bg-surface text-ink shadow-brutal-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b-bw-2 border-ink">
          <div>
            <h2 className="font-display text-2xl font-extrabold tracking-[-0.02em] text-ink">Start from…</h2>
            <p className="text-sm text-muted">Each one opens as a new diagram; your work stays in the diagrams menu.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-md text-muted hover:bg-ink/10">
            <X size={18} />
          </button>
        </div>
        <div className="flex flex-col gap-2 px-5 pt-4">
          <label className="relative block">
            <span className="sr-only">Search examples and solutions</span>
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search: cache, Kafka, feed…"
              autoFocus
              className={`${field} w-full !pl-8`}
            />
          </label>
          <div role="group" aria-label="Filter by pattern" className="flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <button
                key={t}
                aria-pressed={tag === t}
                onClick={() => setTag(tag === t ? undefined : t)}
                className="rounded-full border-bw-1 border-ink/40 px-2.5 py-0.5 text-xs font-semibold text-ink hover:border-ink aria-pressed:border-ink aria-pressed:bg-pop-yellow aria-pressed:text-on-accent"
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5 pt-3">
          {shownExamples.length > 0 && (
            <section aria-label="Examples list">
              <h3 className={`${eyebrow} mb-2`}>Examples</h3>
              <div className="grid gap-3 sm:grid-cols-2">{shownExamples.map((e) => entryButton(e, false))}</div>
            </section>
          )}
          {shownSolutions.length > 0 && (
            <section aria-label="Reference solutions" className="mt-5">
              <h3 className={`${eyebrow} mb-2`}>Your solved problems: reference solutions</h3>
              <div className="grid gap-3 sm:grid-cols-2">{shownSolutions.map((e) => entryButton(e, true))}</div>
            </section>
          )}
          {solutions === null && <p className="mt-5 text-sm text-muted">Loading your solved problems…</p>}
          {shownLocked.length > 0 && (
            <section aria-label="Locked solutions" className="mt-5">
              <h3 className={`${eyebrow} mb-1`}>Reference solutions to unlock</h3>
              <p className="mb-2 text-xs text-muted">A solution is the answer to its practice problem, so it shows here once you have solved the problem in this browser.</p>
              <ul className="grid gap-2 sm:grid-cols-2">
                {shownLocked.map((p) => (
                  <li key={p.id}>
                    <a href={`../practice/${p.id}/`} className={`${card} flex items-start gap-2 !p-3 hover:!shadow-brutal-md`}>
                      <Lock size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="block text-sm font-bold text-ink">Solve {p.title} to unlock</span>
                        <span className="block text-xs text-muted">
                          {p.difficulty} · {p.tags.join(', ')}
                        </span>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {nothing && <p className="py-8 text-center text-sm text-muted">Nothing matches{tag ? ` the ${tag} pattern` : ''}{query ? ` “${query}”` : ''}.</p>}
        </div>
      </div>
    </div>
  );
}
