/**
 * `proschi share-link` prints a link that opens a file in the web editor, the
 * same `#code=` link the editor's *Share* button copies (frontend/src/playground/share.ts).
 * The files the document imports travel along in the link, keyed the way the
 * editor resolves them: relative to the document, which the editor knows only
 * by its name, and remote (git/https) ones by their spec, read from the cache
 * of `proschi imports sync`. Files are read through the same root-confined
 * resolver as `proschi check`, so nothing outside the project gets into a link.
 */
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { encodeShareHash } from '../../frontend/src/playground/share';
import { resolveImportPath } from '../../frontend/src/dsl/imports';
import { fileResolver } from './imports';
import { parse } from './proschi';

export const SHARE_USAGE = `  proschi share-link [--base <url>] <file>`;

export const DEFAULT_BASE = 'https://proschi.app/app/';

export const SHARE_HELP = `share-link
        Prints a link that opens the file (with the files it imports) in the
        web editor; nothing is uploaded, the diagram is in the link. --base
        sets the editor's address (default ${DEFAULT_BASE}).`;

/**
 * The share link for the document in `file`, or why it cannot be made: an
 * import that leaves the project root, or a remote one not synced yet.
 */
export function shareLink(file: string, base = DEFAULT_BASE): { url: string } | { errors: string[] } {
  const entry = resolve(file);
  const name = basename(entry);
  const source = readFileSync(entry, 'utf8');
  const disk = fileResolver({ entry });
  // Key in the link → path (or spec) on disk, to resolve the key's own imports from.
  const where = new Map<string, string>([[name, entry]]);
  const read: Record<string, string> = {};
  const result = parse(source, {
    path: name,
    resolve: (importPath, fromKey) => {
      // The disk first: it records why an import is refused.
      const found = disk(importPath, fromKey === undefined ? entry : where.get(fromKey));
      const key = resolveImportPath(fromKey, importPath);
      if (key === name) return { path: key, source: '' };
      if (!found) return undefined;
      where.set(key, found.path);
      read[key] ??= found.source;
      return { path: key, source: read[key] };
    },
  });
  if (disk.errors.size) return { errors: [...new Set(disk.errors.values())] };
  const imports: Record<string, string> = {};
  for (const { resolved } of result.imports ?? []) {
    if (resolved !== undefined && resolved !== name && Object.prototype.hasOwnProperty.call(read, resolved)) imports[resolved] = read[resolved];
  }
  return { url: base.replace(/#.*$/, '') + encodeShareHash(source, undefined, imports) };
}

export function runShareLink(args: string[], out: (s: string) => void, err: (s: string) => void): number {
  let base = DEFAULT_BASE;
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--base') {
      const value = args[++i];
      if (!value || !/^https?:\/\//.test(value)) {
        err(`Expected --base <http(s) url>, got '${value ?? ''}'`);
        return 2;
      }
      base = value;
    } else if (arg.startsWith('-')) {
      err(`Unknown option ${arg}\n\nUsage:\n${SHARE_USAGE}`);
      return 2;
    } else paths.push(arg);
  }
  if (paths.length !== 1) {
    err(`Usage:\n${SHARE_USAGE}`);
    return 2;
  }
  let link: ReturnType<typeof shareLink>;
  try {
    link = shareLink(paths[0], base);
  } catch (e) {
    err(String((e as Error).message));
    return 2;
  }
  if ('errors' in link) {
    err(link.errors.map((e) => `error: ${e}`).join('\n'));
    return 1;
  }
  out(link.url);
  return 0;
}
