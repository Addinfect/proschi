import { useMemo, useState } from 'react';
import type { Graph, Id } from '../../engine';
import { COMPOSES, DEPENDS_ON, USES } from '../../ontology/architecture';
import ScopeCanvas from '../ScopeCanvas';
import { layoutScope } from '../layout';
import { costSplit, measure } from '../metrics';
import { readScope } from '../scope';
import { FAN, labels, SHOP } from './model';

/**
 * The spike page: the chain from the model to the screen, end to end, in one
 * component.
 *
 * The chain is four calls and no state of its own. `readScope` reads one level out
 * of the flat graph, `layoutScope` places it, `ink` writes the words, `ScopeCanvas`
 * draws it. Everything that moves lives here: which model is on screen, which node
 * is open, which box is marked. That is the split the views were built for, and this
 * page is the evidence for it -- there is nothing between the model and the picture
 * that could go wrong quietly.
 *
 * The numbers under the picture are `metrics.ts` reading the same layout the picture
 * is drawn from. They are the reason this page exists past the first screenshot: a
 * change to the router shows up here as a number, not as a feeling about a picture.
 *
 * Not a product page. It has no route, no loader and no YAML; it is here to be
 * looked at, and to be thrown away once the real renderer has a home.
 */

/** What one level of the shop shows: the tree is `composes`, the arrows are these. */
const SPEC = { nests: COMPOSES, draws: [USES, DEPENDS_ON] } as const;

/** The models this page can draw. `fan` is one box calling five, and nothing else. */
const MODELS = { shop: SHOP, fan: FAN } as const;
type ModelName = keyof typeof MODELS;
const NAMES: readonly ModelName[] = Object.keys(MODELS) as ModelName[];

export default function Spike() {
  const [name, setName] = useState<ModelName>('shop');
  /** The boxes opened so far, outermost first; empty is the top level. */
  const [opened, setOpened] = useState<readonly Id[]>([]);
  const [selected, setSelected] = useState<Id | undefined>(undefined);

  const graph: Graph = MODELS[name];
  const label = useMemo(() => labels(graph), [graph]);

  const root = opened.at(-1);
  const scope = readScope(graph, root === undefined ? SPEC : { ...SPEC, root });
  const layout = layoutScope(scope, { labelOf: label });
  // Both read the layout the canvas gets, so the numbers cannot drift from the picture.
  const metrics = measure(layout);
  const split = costSplit(layout);

  const pick = (next: ModelName): void => {
    setName(next);
    setOpened([]);
    setSelected(undefined);
  };

  return (
    <main className="min-h-screen bg-paper px-6 py-10 font-mono text-ink">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <p className="text-xs tracking-wide text-muted uppercase">SEAL \u00b7 views \u00b7 spike</p>
          <div className="flex flex-wrap items-center gap-4">
            <nav aria-label="Model" className="flex gap-1 text-sm">
              {NAMES.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  aria-pressed={candidate === name}
                  className={
                    candidate === name
                      ? 'rounded-brutal border-bw-1 border-ink bg-pop-yellow px-2 py-0.5'
                      : 'rounded-brutal border-bw-1 border-ink px-2 py-0.5 hover:bg-pop-yellow'
                  }
                  onClick={() => pick(candidate)}
                >
                  {candidate}
                </button>
              ))}
            </nav>
            <Breadcrumb
              label={label}
              opened={opened}
              onOpen={(depth) => setOpened(opened.slice(0, depth))}
            />
          </div>
        </header>

        <div className="rounded-brutal border-bw-1 border-ink bg-surface p-4">
          <ScopeCanvas
            layout={layout}
            label={`${name}, level ${opened.length}`}
            onOpen={(id) => {
              setSelected(undefined);
              setOpened([...opened, id]);
            }}
            onSelect={setSelected}
            selected={selected}
          />
        </div>

        <footer className="flex flex-col gap-3 text-xs text-muted">
          <p>
            {layout.boxes.length} boxes, {layout.edges.length} arrows.
            {layout.issues.length > 0
              ? ` ${layout.issues.length} issues.`
              : ' Nothing to report.'}
          </p>
          <dl className="grid grid-cols-2 gap-x-8 gap-y-1 sm:grid-cols-3">
            <Figure label="crossings" value={metrics.crossings} />
            <Figure label="bends" value={metrics.bends} />
            <Figure label="shared" value={metrics.shared} />
            <Figure label="crowding" value={metrics.crowding} />
            <Figure label="through a box" value={metrics.throughBox} />
            <Figure label="diagonal" value={metrics.diagonal} />
            <Figure label="labels on a box" value={metrics.labelsOnBox} />
            <Figure label="labels together" value={metrics.labelsTogether} />
            <Figure label="area" value={metrics.area} />
          </dl>
          <p>
            Split by who pays: crossings {split.crossings.detour} detour,{' '}
            {split.crossings.mixed} mixed, {split.crossings.grid} grid; bends{' '}
            {split.bends.detour} detour, {split.bends.grid} grid.
          </p>
          <p>Marked: {selected ?? 'nothing'}</p>
          <p>Wheel zooms, drag pans, double click gives the whole picture back.</p>
        </footer>
      </div>
    </main>
  );
}

/** One number from `metrics.ts`, labelled with what it counts. */
function Figure({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt>{label}</dt>
      <dd className="tabular-nums text-ink">{value}</dd>
    </div>
  );
}

/** The way back up: the model, then each box opened on the way here. */
function Breadcrumb({
  label,
  opened,
  onOpen,
}: {
  readonly label: (id: Id) => string;
  readonly opened: readonly Id[];
  readonly onOpen: (depth: number) => void;
}) {
  return (
    <nav aria-label="Opened boxes" className="flex flex-wrap items-center gap-1 text-sm">
      <button
        type="button"
        className="rounded-brutal border-bw-1 border-ink px-2 py-0.5 hover:bg-pop-yellow"
        onClick={() => onOpen(0)}
      >
        top
      </button>
      {opened.map((id, index) => (
        <span key={id} className="flex items-center gap-1">
          <span className="text-muted">/</span>
          <button
            type="button"
            className="rounded-brutal border-bw-1 border-ink px-2 py-0.5 hover:bg-pop-yellow"
            onClick={() => onOpen(index + 1)}
          >
            {label(id)}
          </button>
        </span>
      ))}
    </nav>
  );
}
