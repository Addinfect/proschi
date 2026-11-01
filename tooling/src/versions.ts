/**
 * `proschi versions list|diff`: the saved versions of a diagram in your
 * account, and what changed between two of them (or a version and a local
 * file), with the editor's structural diff (frontend/src/dsl/diff.ts).
 * Read-only: like `whoami` they call the account's API, an agreed exception
 * to "only imports sync uses the network" (versions are an account
 * feature), and never write proschi.lock or the cache.
 */
import { LATEST_TAG, VERSION_TAG, mapResolver } from '../../frontend/src/dsl/imports';
import type { ScenarioRef } from '../../frontend/src/dsl/diff';
import type { DiagramEdge, DiagramSystem, Requirement } from '../../frontend/src/dsl/types';
import { ApiClient, type Fetch } from './api';
import { cloudName, findDocument, listVersions, resolveVersion, type ResolvedVersion, type VersionInfo } from './cloud';
import { CredentialStore, DEFAULT_SITE, normalizeBase } from './credentials';
import { displayPath, parseFile } from './imports';
import { DIFF_SECTIONS, diffDiagrams, parse, requirementKey, summarizeDiff, type DiagramDiff, type DiffSection, type FieldChange, type ParseResult } from './proschi';

export const VERSIONS_USAGE = `  proschi versions list [--json] [--base <url>] <name>
  proschi versions diff [--json] [--base <url>] <name> <base-tag> [<target-tag>|<file.proschi>]`;

export const VERSIONS_HELP = `versions
        Reads the saved versions of a diagram in your account (proschi login
        first; <name> is its file name, with or without .proschi). list
        prints them, newest first. diff prints what changed from <base-tag>
        to <target-tag> (default: latest), or to a local file (a target
        ending in .proschi or containing a /). --json prints the result for
        scripts. Never changes proschi.lock or the cache.`;

const SECTION_TITLES: Record<DiffSection, string> = {
  nodes: 'Nodes',
  edges: 'Edges',
  useCases: 'Use cases',
  scenarios: 'Scenarios',
  requirements: 'Requirements',
  traffic: 'Traffic',
  capacity: 'Capacity',
  systems: 'Systems',
};

/** How an added or removed item is named: the identity the diff matched it by. */
function itemLabel(section: DiffSection, item: unknown): string {
  switch (section) {
    case 'edges': {
      const e = item as DiagramEdge;
      return `${e.source} -> ${e.target}${e.label ? ` : ${e.label}` : ''}`;
    }
    case 'scenarios': {
      const s = item as ScenarioRef;
      return `${s.useCase}/${s.scenario.id}`;
    }
    case 'requirements':
      return requirementKey(item as Requirement);
    case 'traffic':
      return (item as { useCase: string }).useCase;
    case 'capacity':
      return (item as { node: string }).node;
    case 'systems':
      return (item as DiagramSystem).id;
    default:
      return (item as { id: string }).id;
  }
}

const value = (v: unknown): string => (v === undefined || v === null ? '(none)' : typeof v === 'string' ? JSON.stringify(v) : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** One changed attribute: `field: old → new`, or for lists (steps, entries) the lines removed and added. */
function changeLines({ field, before, after }: FieldChange, indent: string): string[] {
  const list = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  if ((list(before) || before === undefined) && (list(after) || after === undefined) && (before !== undefined || after !== undefined)) {
    const old = (before as string[] | undefined) ?? [];
    const next = (after as string[] | undefined) ?? [];
    const lines = [`${indent}${field}:`];
    for (const line of old) if (!next.includes(line)) lines.push(`${indent}  - ${line}`);
    for (const line of next) if (!old.includes(line)) lines.push(`${indent}  + ${line}`);
    if (lines.length === 1) lines.push(`${indent}  (reordered)`);
    return lines;
  }
  return [`${indent}${field}: ${value(before)} → ${value(after)}`];
}

/** The diff as text: a heading per section with `+` added, `-` removed and `~` changed items, then the counts. */
export function formatDiff(diff: DiagramDiff, from: string, to: string): string {
  const lines = [`${from} → ${to}`, ''];
  if (diff.diagram.length) {
    lines.push('Diagram');
    for (const c of diff.diagram) lines.push(...changeLines(c, '  ~ '));
  }
  for (const section of DIFF_SECTIONS) {
    const { added, removed, changed } = diff[section] as { added: unknown[]; removed: unknown[]; changed: { key: string; changes: FieldChange[] }[] };
    if (!added.length && !removed.length && !changed.length) continue;
    lines.push(SECTION_TITLES[section]);
    for (const item of added) lines.push(`  + ${itemLabel(section, item)}`);
    for (const item of removed) lines.push(`  - ${itemLabel(section, item)}`);
    for (const item of changed) {
      lines.push(`  ~ ${item.key}`);
      for (const c of item.changes) lines.push(...changeLines(c, '      '));
    }
  }
  const { total } = summarizeDiff(diff);
  if (lines.length === 2) lines.push('No changes');
  else lines.push('', `${total.added} added, ${total.removed} removed, ${total.changed} changed`);
  return lines.join('\n');
}

/** A saved version parsed with the files saved with it. */
const parseVersion = (v: ResolvedVersion): ParseResult => parse(v.source, { path: v.name, resolve: mapResolver(v.imports) });

const date = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const bytes = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

/** The versions as a table, newest first. */
export function formatVersionList(name: string, versions: VersionInfo[], limit: number | undefined): string {
  const head = `${name}: ${versions.length} version${versions.length === 1 ? '' : 's'}${limit !== undefined ? ` (keeps up to ${limit})` : ''}`;
  if (!versions.length) return `${head}\n  Save one in the editor (Versions) to import it as cloud:${name.replace(/\.proschi$/, '')}:<tag>`;
  const rows = [['TAG', 'SEQ', 'SAVED (UTC)', 'SIZE', 'NOTE'], ...versions.map((v) => [v.tag, `#${v.seq}`, date(v.createdAt), bytes(v.size), v.note ?? ''])];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return [head, ...rows.map((r) => `  ${r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]))).join('  ')}`.trimEnd())].join('\n');
}

export interface VersionsDeps {
  store?: CredentialStore;
  fetch?: Fetch;
}

export async function runVersions(args: string[], out: (s: string) => void, err: (s: string) => void, deps: VersionsDeps = {}): Promise<number> {
  const [sub, ...rest] = args;
  let json = false;
  let base = DEFAULT_SITE;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json') json = true;
    else if (arg === '--base') {
      try {
        base = normalizeBase(rest[++i] ?? '');
      } catch (e) {
        err((e as Error).message);
        return 2;
      }
    } else if (arg.startsWith('-')) {
      err(`Unknown option ${arg}\n\nUsage:\n${VERSIONS_USAGE}`);
      return 2;
    } else positional.push(arg);
  }
  const usage = () => (err(`Usage:\n${VERSIONS_USAGE}`), 2);
  if (sub === 'list' ? positional.length !== 1 : sub === 'diff' ? positional.length < 2 || positional.length > 3 : true) return usage();

  const client = new ApiClient({ base, store: deps.store, fetch: deps.fetch });
  try {
    const spec = cloudName(positional[0]);
    if (sub === 'list') {
      const doc = await findDocument(client, spec);
      const { versions, limit } = await listVersions(client, doc.id);
      out(json ? JSON.stringify({ name: doc.name, documentId: doc.id, versions, limit }, null, 2) : formatVersionList(doc.name, versions, limit));
      return 0;
    }
    const [, baseTag, target = LATEST_TAG] = positional;
    const isFile = target.endsWith('.proschi') || target.includes('/') || target.includes('\\');
    for (const tag of isFile ? [baseTag] : [baseTag, target]) {
      if (!VERSION_TAG.test(tag)) throw new Error(`'${tag}' is not a version tag (letters, digits, '.', '_' and '-'), or latest`);
    }
    const before = await resolveVersion(client, spec, baseTag);
    const after = isFile ? undefined : await resolveVersion(client, spec, target);
    const left = parseVersion(before);
    const right = after ? parseVersion(after) : parseFile(target);
    const label = (v: ResolvedVersion, asked: string) => `cloud:${spec.name}:${v.tag} (#${v.seq}${asked === LATEST_TAG ? ', latest' : ''})`;
    const toLabel = after ? label(after, target) : displayPath(target);
    for (const [what, r] of [[label(before, baseTag), left], [toLabel, right]] as const) {
      const errors = r.diagnostics.filter((d) => d.severity === 'error').length;
      if (errors) err(`warning: ${what} has ${errors} error(s); the diff covers what parsed`);
    }
    const diff = diffDiagrams(left.diagram, right.diagram);
    if (json) {
      const side = (v: ResolvedVersion) => ({ tag: v.tag, seq: v.seq, sha256: v.sha256 });
      out(JSON.stringify({ name: spec.name, base: side(before), target: after ? side(after) : { file: displayPath(target) }, summary: summarizeDiff(diff), diff }, null, 2));
    } else out(formatDiff(diff, label(before, baseTag), toLabel));
    return 0;
  } catch (e) {
    err(`error: ${(e as Error).message}`);
    return 1;
  }
}
