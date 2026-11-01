import { isRemoteSpec, joinImportPath, mapResolver } from '../../../frontend/src/dsl/imports';
import { parse } from '../../../frontend/src/dsl/parser';
import type { Diagram, Diagnostic } from '../../../frontend/src/dsl/types';
import { encodeShareHash, type PlaybackTarget } from '../../../frontend/src/playground/share';
import { analyze, runTests, type TestResult } from '../../../frontend/src/sim';
import type { NodeOverlay } from '../../../frontend/src/sim/overlay';
import { applyView, viewOverlay, type SystemBadge, type SystemNote, type SystemsView } from './systems';

/**
 * A Proschi document as the terminal view needs it: the diagram as its view
 * draws it (systems collapsed, expanded or focused, systems.ts), its errors,
 * the simulation's per-node overlay, system badges and warnings, and
 * requirement results (when the document has `traffic`), and the link that
 * opens it in the web editor.
 */

export interface Source {
  source: string;
  /** The document's name, for resolving its imports. */
  path?: string;
  /** Imported files by the path the document's imports resolve to. */
  imports?: Record<string, string>;
  /** Which systems are drawn open, or focused into. */
  view?: SystemsView;
}

export interface Document {
  /** The diagram as the view draws it. */
  diagram: Diagram;
  /** The document as parsed, every system collapsed. */
  root: Diagram;
  errors: Diagnostic[];
  overlay?: Record<string, NodeOverlay>;
  /** Promise, headroom and status of each system box and expanded frame, by its id in the view. */
  systems: Record<string, SystemBadge>;
  /** The simulation's warnings about systems. */
  notes: SystemNote[];
  tests: TestResult[];
  /** The web editor's link to the document, opened at a playback step when given one. */
  link: (playback?: PlaybackTarget) => string;
}

export const EDITOR = 'https://proschi.app/app/';

export function parseSource({ source, path = 'diagram.proschi', imports = {} }: Source): { diagram: Diagram; errors: Diagnostic[] } {
  const result = parse(source, { path, resolve: mapResolver(imports) });
  return { diagram: result.diagram, errors: result.diagnostics.filter((d) => d.severity === 'error') };
}

/** The diagram a document's view draws, for laying it out. */
export function viewSource(input: Source): { diagram: Diagram; errors: Diagnostic[] } {
  const { diagram, errors } = parseSource(input);
  return { diagram: errors.length ? diagram : applyView(diagram, input.view), errors };
}

export function loadDocument(input: Source): Document {
  const { diagram, errors } = parseSource(input);
  const simulated = errors.length === 0 && (diagram.traffic?.length ?? 0) > 0;
  const analysis = simulated ? analyze(diagram) : undefined;
  const imports = input.imports && Object.keys(input.imports).length ? input.imports : undefined;
  const view = errors.length ? {} : (input.view ?? {});
  const sim = errors.length ? undefined : viewOverlay(diagram, analysis, view);
  const top = view.focus === undefined;
  if (sim && analysis && top) for (const c of diagram.capacity ?? []) if (c.size && sim.nodes[c.node]) sim.nodes[c.node].size = c.size;
  const overlay = sim && Object.keys(sim.nodes).length ? sim.nodes : undefined;
  return {
    diagram: errors.length ? diagram : applyView(diagram, view),
    root: diagram,
    errors,
    ...(overlay ? { overlay } : {}),
    systems: sim?.systems ?? {},
    notes: sim?.notes ?? [],
    tests: analysis ? runTests(diagram, analysis) : [],
    link: (playback) => EDITOR + encodeShareHash(input.source, playback, imports),
  };
}

/** Import paths a document names that `imports` does not hold yet, resolved against `path`. */
export function missingImports(input: Source): string[] {
  const missing = new Set<string>();
  const imports = input.imports ?? {};
  const known = mapResolver(imports);
  parse(input.source, {
    path: input.path ?? 'diagram.proschi',
    resolve: (importPath, fromPath) => {
      const found = known(importPath, fromPath);
      const key = joinImportPath(fromPath, importPath);
      if (!found && key !== undefined) missing.add(key);
      return found;
    },
  });
  return [...missing];
}

/**
 * The file an import key (relative to the document in `dir`, from
 * missingImports) names, `/`-separated, or undefined when it is remote or
 * leaves `root`, the project root: imports never read outside the project.
 */
export function importFilePath(dir: string, root: string, key: string): string | undefined {
  if (isRemoteSpec(key) || key.startsWith('/')) return undefined;
  const parts = dir.split('/').filter(Boolean);
  for (const part of key.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  const path = `/${parts.join('/')}`;
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`) ? path : undefined;
}

/** A short stable key for a document's text and imports (FNV-1a). */
export function keyOf(input: Source): string {
  const text = input.source + '\u0000' + JSON.stringify(input.imports ?? {}) + (input.view ? '\u0000' + JSON.stringify(input.view) : '');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + text.length.toString(36);
}
