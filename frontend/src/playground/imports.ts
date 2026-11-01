import { joinImportPath, mapResolver, type Diagram, type ImportResolver, type ParseResult } from '../dsl';
import { fileNameOf, type SavedDiagram } from './documents';

/**
 * The files the imports of `current` can see: every other saved diagram under
 * its file name (the most recently changed one wins when names clash), then
 * the files that came with the share link it was opened from.
 */
export function importableFiles(docs: SavedDiagram[], current: SavedDiagram): Record<string, string> {
  const files: Record<string, string> = {};
  const others = docs.filter((d) => d.id !== current.id).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const doc of others) files[fileNameOf(doc)] = doc.source;
  return { ...files, ...current.imports };
}

/**
 * Resolves imports against `files`; the root document itself resolves too, so
 * a cycle back to it is reported. Never fetches: `git:` and `https://` imports
 * resolve only to files bundled under their exact spec (by `proschi share-link`).
 */
export function filesResolver(files: Record<string, string>, rootPath: string): ImportResolver {
  const resolve = mapResolver(files);
  return (importPath, fromPath) => {
    if (joinImportPath(fromPath, importPath) === rootPath) return { path: rootPath, source: '' };
    return resolve(importPath, fromPath);
  };
}

/** The imported files a parse actually read, path → source, e.g. to put them in a share link. */
export function usedImports(result: ParseResult, files: Record<string, string>, rootPath: string): Record<string, string> {
  const used: Record<string, string> = {};
  const add = (resolved: string | undefined) => {
    if (resolved !== undefined && resolved !== rootPath && Object.prototype.hasOwnProperty.call(files, resolved)) used[resolved] = files[resolved];
  };
  for (const { resolved } of result.imports ?? []) add(resolved);
  // Team files of `system … { from "…" }`, and what they import in turn (their nodes and use cases say which file they came from).
  const teams = (diagram: Diagram) => {
    for (const system of diagram.systems ?? []) {
      if (!system.diagram) continue;
      add(system.resolved);
      for (const item of [...system.diagram.nodes, ...system.diagram.useCases]) add(item.loc.file);
      teams(system.diagram);
    }
  };
  teams(result.diagram);
  return used;
}

/** A team file as the code pane shows it when navigated into its system. */
export interface TeamFile {
  path: string;
  source: string;
  /** The saved diagram that holds it, when it can be edited here. */
  docId?: string;
  /** Why it cannot be edited here, when it cannot. */
  readOnly?: string;
}

/**
 * The file at `path` that `current`'s imports read: editable when it is a
 * diagram saved in this browser; read-only when it came with the share link
 * `current` was opened from, or from a remote source (bundled, never fetched).
 */
export function teamFileOf(docs: SavedDiagram[], current: SavedDiagram, path: string): TeamFile | undefined {
  const source = importableFiles(docs, current)[path];
  if (source === undefined) return undefined;
  if (/^(git:|https?:)/.test(path)) return { path, source, readOnly: 'It comes from a remote source; change it in its repository.' };
  if (current.imports?.[path] !== undefined) return { path, source, readOnly: 'It came with the link this diagram was opened from.' };
  // The most recently changed one, the one imports read (importableFiles).
  const doc = docs.filter((d) => d.id !== current.id && fileNameOf(d) === path).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return doc ? { path, source, docId: doc.id } : undefined;
}
