import { useMemo, useState } from 'react';
import { parse } from '../dsl';
import { filesResolver } from '../playground/imports';
import { encodeShareHash, type PlaybackTarget } from '../playground/share';
import DiagramCanvas from '../components/Diagram/DiagramCanvas';
import { useDiagramLayout } from '../components/Diagram/useDiagramLayout';
import { UseCasePlayback } from '../components/UseCases/UseCasePlayback';
import { PLAYBACK_EDGE_TYPES } from '../components/UseCases/playbackView';
import { systemSummaries } from '../components/Canvas/systemSummary';
import { analyze, runTests } from '../sim';
import type { Edge, Node } from 'reactflow';
import type { Lit } from './annotations';
import './live.css';

interface LiveExampleProps {
  source: string;
  /** The way from this page to the site root, for the editor link. */
  siteRoot: string;
  /** Imported files (path → source) the source reads. */
  imports?: Record<string, string>;
  /** Where the editor link goes instead of the source in a `#code=` link (e.g. a short link). */
  editorHref?: string;
  /** The editor link's text. */
  openLabel?: string;
  /** Open the editor in a new tab (from inside an iframe). */
  newTab?: boolean;
  /** A heading at the start of the bar (the embed page's diagram title). */
  title?: string;
  /** Boxes and arrows to light up (an annotated example's current line); the rest dims. */
  lit?: Lit;
}

/** Marks the lit nodes and edges (docs.css styles them) and dims the rest; a lit arrow keeps its two ends, a lit group its members. */
function withLit(nodes: Node[], edges: Edge[], lit: Lit | undefined): { nodes: Node[]; edges: Edge[] } {
  if (!lit || (lit.nodes.length === 0 && lit.edges.length === 0)) return { nodes, edges };
  const litNodes = new Set(lit.nodes);
  const litEdges = new Set(lit.edges);
  const kept = new Set(lit.nodes);
  for (const e of edges) if (litEdges.has(e.id)) kept.add(e.source).add(e.target);
  const mark = (className: string | undefined, cls: string) => `${className ?? ''} ${cls}`.trim();
  return {
    nodes: nodes.map((n) => ({
      ...n,
      className: mark(n.className, litNodes.has(n.id) ? 'doc-lit' : kept.has(n.id) || (n.parentNode && litNodes.has(n.parentNode)) ? '' : 'doc-dim'),
    })),
    edges: edges.map((e) => ({ ...e, className: mark(e.className, litEdges.has(e.id) ? 'doc-lit' : 'doc-dim') })),
  };
}

/** The root file name imports resolve against, as a top-level file of the editor's. */
const ROOT_PATH = 'embedded.proschi';

/**
 * A docs example come alive: the diagram the code above it draws, a picker for
 * its scenarios, Play to run one over the diagram, and a link that opens the
 * code in the editor. Nothing is saved: the editor gets the code in the link.
 */
export default function LiveExample({ source, siteRoot, imports, editorHref, openLabel = 'Open in editor', newTab, title, lit }: LiveExampleProps) {
  const diagram = useMemo(
    () => parse(source, imports ? { path: ROOT_PATH, resolve: filesResolver(imports, ROOT_PATH) } : undefined).diagram,
    [source, imports],
  );
  const { nodes: laidOut, edges, settled } = useDiagramLayout(diagram);
  // System boxes show their status and headroom, as in the editor.
  const summaries = useMemo(() => {
    if (!diagram.systems?.length) return undefined;
    const analysis = analyze(diagram);
    return systemSummaries(diagram, analysis, runTests(diagram, analysis), diagram, '');
  }, [diagram]);
  const nodes = useMemo(
    () =>
      summaries
        ? laidOut.map((n) => {
            const system = summaries.get(n.id);
            return system ? { ...n, data: { ...n.data, system } } : n;
          })
        : laidOut,
    [laidOut, summaries],
  );
  const scenarios = useMemo(
    () =>
      diagram.useCases.flatMap((u) =>
        u.scenarios
          .filter((s) => s.steps.length > 0)
          .map((s) => ({
            key: `${u.id}/${s.id}`,
            label: u.scenarios.length > 1 ? `${u.name} › ${s.name}` : u.name,
            target: { useCase: u.id, ...(u.scenarios.length > 1 ? { scenario: s.id } : {}), step: 1 } as PlaybackTarget,
            played: { id: `${u.id}/${s.id}`, name: u.name, steps: s.steps, condition: s.condition },
          })),
      ),
    [diagram],
  );
  const [selected, setSelected] = useState(0);
  // Bumped by Play, so pressing it again restarts the player.
  const [run, setRun] = useState(0);
  const current = scenarios[Math.min(selected, scenarios.length - 1)];
  const playing = run > 0 && current;
  const editor = editorHref ?? `${siteRoot}app/${encodeShareHash(source, playing ? current.target : undefined, imports)}`;
  const played = useMemo(() => (playing ? { ...playing.played, id: `${playing.key}#${run}` } : undefined), [playing, run]);
  const label = `Diagram of the example${playing ? `, playing ${current.label}` : ''}`;

  return (
    <div className="live__island">
      <div className="live__bar">
        {title && <h1 className="live__title">{title}</h1>}
        {scenarios.length > 1 && (
          <label className="live__pick">
            <span className="live__pick-label">Scenario</span>
            <select
              value={selected}
              onChange={(e) => {
                setSelected(Number(e.target.value));
                if (run > 0) setRun((n) => n + 1);
              }}
            >
              {scenarios.map((s, i) => (
                <option key={s.key} value={i}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {scenarios.length === 1 && <span className="live__pick-label live__single">{current.label}</span>}
        <span className="live__spacer" />
        {current && (
          <button type="button" className="ps-btn ps-btn--primary ps-btn--sm" onClick={() => setRun((n) => n + 1)}>
            <svg className="ps-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7 5v14l11-7z" fill="currentColor" />
            </svg>
            {playing ? 'Replay' : 'Play'}
          </button>
        )}
        <a className="ps-btn ps-btn--sm" href={editor} {...(newTab ? { target: '_blank', rel: 'noopener' } : {})}>
          {openLabel}
          <svg className="ps-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 12h15M13 6l6 6-6 6" />
          </svg>
        </a>
      </div>
      <div className={`live__stage ${playing ? 'live__stage--playing' : ''}`} role="region" aria-label={label}>
        {/* One canvas throughout: Play and Replay restyle it rather than swapping it for another. */}
        <UseCasePlayback
          // A new run gets a new id, so Replay starts over without remounting the canvas.
          useCase={played}
          nodes={nodes}
          edges={edges}
          onBack={() => setRun(0)}
          showHeader={false}
          autoPlay
        >
          {(view) => {
            const shown = withLit(view.nodes, view.edges, lit);
            return <DiagramCanvas nodes={shown.nodes} edges={shown.edges} edgeTypes={PLAYBACK_EDGE_TYPES} fitKey={String(settled)} compact />;
          }}
        </UseCasePlayback>
      </div>
    </div>
  );
}
