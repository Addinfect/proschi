import { useState } from 'react';
import type { Id } from '../../engine';
import { COMPOSES, DEPENDS_ON, USES } from '../../ontology/architecture';
import ScopeCanvas from '../ScopeCanvas';
import { layoutScope } from '../layout';
import { readScope } from '../scope';
import { labelOf, SHOP } from './model';

/**
 * The spike page: the chain from the model to the screen, end to end, in one
 * component.
 *
 * The chain is four calls and no state of its own. `readScope` reads one level out
 * of the flat graph, `layoutScope` places it, `ink` writes the words, `ScopeCanvas`
 * draws it. Everything that moves lives here: which node is open, which box is
 * marked. That is the split the views were built for, and this page is the
 * evidence for it -- there is nothing between the model and the picture that
 * could go wrong quietly.
 *
 * Not a product page. It has no route, no loader and no YAML; it is here to be
 * looked at, and to be thrown away once the real renderer has a home.
 */

/** What one level of the shop shows: the tree is `composes`, the arrows are these. */
const SPEC = { nests: COMPOSES, draws: [USES, DEPENDS_ON] } as const;

export default function Spike() {
  /** The boxes opened so far, outermost first; empty is the top level. */
  const [opened, setOpened] = useState<readonly Id[]>([]);
  const [selected, setSelected] = useState<Id | undefined>(undefined);

  const root = opened.at(-1);
  const scope = readScope(SHOP, root === undefined ? SPEC : { ...SPEC, root });
  const layout = layoutScope(scope, { labelOf });

  return (
    <main className="min-h-screen bg-paper px-6 py-10 font-mono text-ink">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <p className="text-xs tracking-wide text-muted uppercase">SEAL · views · spike</p>
          <Breadcrumb opened={opened} onOpen={(depth) => setOpened(opened.slice(0, depth))} />
        </header>

        <div className="rounded-brutal border-bw-1 border-ink bg-surface p-4">
          <ScopeCanvas
            layout={layout}
            label={`The shop, level ${opened.length}`}
            onOpen={(id) => {
              setSelected(undefined);
              setOpened([...opened, id]);
            }}
            onSelect={setSelected}
            selected={selected}
          />
        </div>

        <footer className="flex flex-col gap-1 text-xs text-muted">
          <p>
            {layout.boxes.length} boxes, {layout.edges.length} arrows.
            {layout.issues.length > 0
              ? ` ${layout.issues.length} issues.`
              : ' Nothing to report.'}
          </p>
          <p>Marked: {selected ?? 'nothing'}</p>
          <p>Wheel zooms, drag pans, double click gives the whole picture back.</p>
        </footer>
      </div>
    </main>
  );
}

/** The way back up: the shop, then each box opened on the way here. */
function Breadcrumb({
  opened,
  onOpen,
}: {
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
        shop
      </button>
      {opened.map((id, index) => (
        <span key={id} className="flex items-center gap-1">
          <span className="text-muted">/</span>
          <button
            type="button"
            className="rounded-brutal border-bw-1 border-ink px-2 py-0.5 hover:bg-pop-yellow"
            onClick={() => onOpen(index + 1)}
          >
            {labelOf(id)}
          </button>
        </span>
      ))}
    </nav>
  );
}
