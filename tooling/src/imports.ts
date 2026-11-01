/**
 * Multi-file documents for the CLI and the language server: resolving
 * `import "path"` from the file system (confined to the project root) and
 * from synced remote sources, and grouping the problems of a parse by the
 * file they occur in.
 */
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ImportError, isRemoteSpec, resolveImportPath } from '../../frontend/src/dsl/imports';
import { parse, type Diagnostic, type Diagram, type ImportResolver, type ParseResult } from './proschi';
import { toRange, type Range } from './analysis';
import { lockedHash, readCached, readLock, remoteError, type Lock } from './lock';
import { findConfigFile } from './openapi/config';

/** Relative to the working directory when the file is inside it, else absolute. */
export function displayPath(file: string, cwd = process.cwd()): string {
  const abs = resolve(cwd, file);
  const rel = relative(cwd, abs);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs;
}

/** Most bytes an imported file may have. Imports are data, never run, but a huge one should not hang the editor. */
export const MAX_IMPORT_BYTES = 1_000_000;
/** Most files one document may import, directly or not. */
export const MAX_IMPORT_FILES = 500;
/** Longest chain of imports from the root document. */
export const MAX_IMPORT_DEPTH = 32;

/**
 * The folder imports are confined to: the folder of the nearest proschi.json,
 * else the root of the git repository (found by its .git, without running
 * git), else the folder of the entry file. A real path, symlinks resolved.
 */
export function projectRoot(entry: string): string {
  const dir = dirname(resolve(entry));
  const config = findConfigFile(dir);
  if (config) return realpathSync(dirname(config));
  for (let current = dir; ; current = dirname(current)) {
    if (existsSync(join(current, '.git'))) return realpathSync(current);
    if (dirname(current) === current) break;
  }
  return realpathSync(existsSync(dir) ? dir : process.cwd());
}

const isInside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * Where `path` really is: the real path of its nearest existing ancestor,
 * joined with the rest. (On macOS the temp folder is a symlink, so a root
 * found through it and a path spelled without it must still match.)
 */
function realLocation(path: string): string {
  let existing = path;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  return join(realpathSync(existing), relative(existing, path));
}

const tooLarge = (what: string) => new ImportError(`'${what}' is larger than ${MAX_IMPORT_BYTES / 1_000_000} MB`);

export interface ResolverOptions {
  /** The root document, spelled as it is passed to `parse` as `path`; it decides the project root. */
  entry?: string;
  /** The text of a file (e.g. an unsaved editor buffer), consulted before the disk. */
  read?: (absolutePath: string) => string | undefined;
  /** How resolved paths are spelled in diagnostics; the result must resolve back against the working directory. */
  toPath?: (absolutePath: string) => string;
  /** The text of a remote import by canonical spec; by default from proschi.lock and the cache, never the network. */
  remote?: (spec: string) => string | undefined;
}

export interface ProjectResolver extends ImportResolver {
  root: string;
  /** Why imports failed, by `fromPath + NUL + importPath`. */
  errors: Map<string, string>;
  /**
   * Puts the reasons for failed imports (outside the project, not synced, …)
   * on their diagnostics in place of the parser's plain "Cannot find". Does
   * nothing where the parser already reported the reason.
   */
  explain<T extends ParseResult>(result: T): T;
}

/**
 * Resolves imports relative to the importing file, confined to the project
 * root: absolute paths, paths that leave the root and symlinks whose real
 * path leaves it are errors. `git:` and `https://` imports come from the
 * lockfile and cache that `proschi imports sync` fills, never the network;
 * relative imports in a remote file stay within its source.
 */
export function fileResolver({ entry, read = () => undefined, toPath = (p) => p, remote }: ResolverOptions = {}): ProjectResolver {
  const root = projectRoot(entry ?? join(process.cwd(), 'stdin.proschi'));
  const errors = new Map<string, string>();
  const levels = new Map<string, number>();
  let lock: Lock | undefined | null = null;
  const fromCache = (spec: string): string => {
    if (lock === null) lock = readLock(root);
    if (!lock) throw remoteError.noLock(spec);
    const hash = lockedHash(lock, spec);
    if (!hash) throw remoteError.notLocked(spec);
    const bytes = readCached(root, hash, spec);
    if (!bytes) throw remoteError.notCached(spec);
    return bytes.toString('utf8');
  };
  const loadRemote = remote ?? fromCache;

  const found = (path: string, source: string, level: number) => {
    if (!levels.has(path)) {
      if (levels.size >= MAX_IMPORT_FILES) throw new ImportError(`More than ${MAX_IMPORT_FILES} imported files; split the diagram`);
      levels.set(path, level);
    }
    return { path, source };
  };

  const resolveOne = (importPath: string, fromPath: string | undefined) => {
    const level = (fromPath === undefined ? 0 : (levels.get(fromPath) ?? 0)) + 1;
    if (level > MAX_IMPORT_DEPTH) throw new ImportError(`Imports nest more than ${MAX_IMPORT_DEPTH} files deep`);
    if (isRemoteSpec(importPath) || (fromPath !== undefined && isRemoteSpec(fromPath))) {
      const spec = resolveImportPath(fromPath, importPath);
      const source = loadRemote(spec);
      if (source === undefined) return undefined;
      if (Buffer.byteLength(source) > MAX_IMPORT_BYTES) throw tooLarge(spec);
      return found(spec, source, level);
    }
    // Absolute paths and NUL characters: the same rule as the browser's.
    resolveImportPath(undefined, importPath);
    const abs = resolve(fromPath ? dirname(resolve(fromPath)) : root, importPath);
    if (!isInside(root, realLocation(abs))) {
      const link = existsSync(abs) && lstatSync(abs).isSymbolicLink();
      throw new ImportError(
        link
          ? `'${importPath}' is a symlink to a file outside the project root ${displayPath(root)}`
          : `'${importPath}' is outside the project root ${displayPath(root)}; imports must stay inside the folder of proschi.json (else the git root)`,
      );
    }
    const text = read(abs);
    if (text !== undefined) {
      if (Buffer.byteLength(text) > MAX_IMPORT_BYTES) throw tooLarge(importPath);
      return found(toPath(abs), text, level);
    }
    if (!existsSync(abs)) return undefined;
    const stat = statSync(abs);
    if (!stat.isFile()) return undefined;
    if (stat.size > MAX_IMPORT_BYTES) throw tooLarge(importPath);
    return found(toPath(abs), readFileSync(realpathSync(abs), 'utf8'), level);
  };

  const resolver = ((importPath: string, fromPath: string | undefined) => {
    try {
      return resolveOne(importPath, fromPath);
    } catch (e) {
      if (e instanceof ImportError) errors.set(`${fromPath ?? ''}\0${importPath}`, e.message);
      throw e;
    }
  }) as ProjectResolver;
  resolver.root = root;
  resolver.errors = errors;
  resolver.explain = (result) => {
    for (const i of result.imports ?? []) {
      if (i.resolved !== undefined) continue;
      const reason = errors.get(`${i.loc.file ?? entry ?? ''}\0${i.path}`);
      const d =
        reason &&
        result.diagnostics.find((d) => d.file === i.loc.file && d.line === i.loc.line && d.col === i.loc.col && d.message === `Cannot find '${i.path}'`);
      if (d) d.message = reason;
    }
    return result;
  };
  return resolver;
}

/** Parses a file from disk, following its imports; paths in the result are relative to the working directory. */
export function parseFile(file: string): ParseResult {
  const path = displayPath(file);
  const resolver = fileResolver({ entry: path, toPath: (p) => displayPath(p) });
  return resolver.explain(parse(readFileSync(file, 'utf8'), { path, resolve: resolver }));
}

export interface FileDiagnostics {
  file: string;
  diagnostics: Diagnostic[];
}

/**
 * Checks files and reports every problem under the file it occurs in. Each
 * checked file gets an entry; an imported file gets one when it has problems.
 * A file imported by several checked files has its problems reported once.
 * `extra` adds findings of other checks (OpenAPI) for the merged diagram;
 * those with `file` set are reported under that file too.
 */
export function checkFiles(files: string[], extra?: (file: string, diagram: Diagram) => Diagnostic[]): FileDiagnostics[] {
  const byFile = new Map<string, Diagnostic[]>();
  const seen = new Set<string>();
  for (const file of files) {
    const root = displayPath(file);
    if (!byFile.has(root)) byFile.set(root, []);
    const { diagram, diagnostics } = parseFile(file);
    for (const { file: where, ...d } of [...diagnostics, ...(extra?.(file, diagram) ?? [])]) {
      const target = where ?? root;
      const key = `${target}:${d.line}:${d.col}:${d.severity}:${d.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!byFile.has(target)) byFile.set(target, []);
      byFile.get(target)!.push(d);
    }
  }
  return [...byFile].map(([file, diagnostics]) => ({ file, diagnostics: diagnostics.sort((x, y) => x.line - y.line || x.col - y.col) }));
}

/** Imported files reached through an import of the root document, the file itself included. */
function reachableFrom(result: ParseResult, start: string): Set<string> {
  const reached = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const file = queue.shift()!;
    for (const i of result.imports ?? []) {
      if (i.loc.file === file && i.resolved !== undefined && !reached.has(i.resolved)) {
        reached.add(i.resolved);
        queue.push(i.resolved);
      }
    }
  }
  return reached;
}

/**
 * The root document's own problems, plus an error on each of its imports
 * whose file (or a file it imports in turn) has errors, since an editor shows
 * one file's diagnostics at a time.
 */
export function ownDiagnostics(result: ParseResult): Diagnostic[] {
  const own = result.diagnostics.filter((d) => d.file === undefined);
  for (const i of result.imports ?? []) {
    if (i.loc.file !== undefined || i.resolved === undefined) continue;
    const files = reachableFrom(result, i.resolved);
    const errors = result.diagnostics.filter((d) => d.severity === 'error' && d.file !== undefined && files.has(d.file)).length;
    if (errors) own.push({ severity: 'error', message: `'${basename(i.path)}' has ${errors} error${errors === 1 ? '' : 's'}`, ...i.loc });
  }
  return own.sort((a, b) => a.line - b.line || a.col - b.col);
}

/** Links from the root document's import paths (inside the quotes) to the files they resolved to. */
export function importLinks(result: ParseResult): { range: Range; target: string }[] {
  return (result.imports ?? [])
    .filter((i) => i.loc.file === undefined && i.resolved !== undefined && !isRemoteSpec(i.resolved))
    .map((i) => {
      const range = toRange(i.loc);
      return {
        range: { start: { ...range.start, character: range.start.character + 1 }, end: { ...range.end, character: Math.max(range.start.character + 1, range.end.character - 1) } },
        target: i.resolved!,
      };
    });
}
