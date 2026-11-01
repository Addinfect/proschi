import { bracketDepth, tokenizeLine, type Token } from './lexer';
import { parse } from './parser';
import type { CapacityOverride, DiagramNode, InstanceSize } from './types';

/**
 * Source-to-source edits used when the diagram is changed on the canvas. Each
 * edit touches as little text as possible so comments and formatting survive.
 */

export function setNodePosition(source: string, id: string, position: { x: number; y: number }): string {
  const pos = `pos ${Math.round(position.x)},${Math.round(position.y)}`;
  const decl = findDeclaration(source, id);
  if (!decl) return insertDeclaration(source, `${id} ${pos}`);

  const { tokens, lineText, firstProp } = decl;
  const at = tokens.findIndex((t, i) => i >= firstProp && t.kind === 'ident' && t.value === 'pos');
  if (at !== -1 && tokens[at + 3]?.kind === 'number') {
    return replaceInLine(source, decl.line, tokens[at].col - 1, end(tokens[at + 3]), pos);
  }

  const brace = tokens.findIndex((t) => t.kind === 'lbrace');
  if ((decl.node.kind === 'group' || decl.node.kind === 'system') && brace !== -1) {
    return replaceInLine(source, decl.line, tokens[brace].col - 1, tokens[brace].col - 1, `${pos} `);
  }
  const last = end(tokens[tokens.length - 1]);
  return replaceInLine(source, decl.line, last, last, ` ${pos}`, lineText);
}

export function renameNode(source: string, id: string, name: string): string {
  const clean = name.replace(/[\r\n]+/g, ' ').trim();
  if (!clean) return source;
  const quoted = `"${clean.replace(/[\\"]/g, '\\$&')}"`;
  const decl = findDeclaration(source, id);
  if (!decl) return insertDeclaration(source, `${id} ${quoted}`);

  const { tokens, firstProp } = decl;
  const current = tokens[firstProp];
  if (current?.kind === 'string') return replaceInLine(source, decl.line, current.col - 1, end(current), quoted);
  const idToken = tokens[firstProp - 1];
  return replaceInLine(source, decl.line, end(idToken), end(idToken), ` ${quoted}`);
}

export function addConnection(source: string, from: string, to: string): string {
  if (from === to) return source;
  const { diagram } = parse(source);
  if (diagram.edges.some((e) => e.source === from && e.target === to)) return source;
  return insertDeclaration(source, `${from} -> ${to}`);
}

export type EditResult = { source: string; error?: undefined } | { source?: undefined; error: string };

/** Deletes architecture connections by their parsed ids (e.g. `a->b`, `a->b#2`). */
export function removeConnections(source: string, edgeIds: string[]): string {
  const { diagram } = parse(source);
  const lines = diagram.edges.filter((e) => edgeIds.includes(e.id)).map((e) => e.loc.line);
  return removeStatementLines(source, lines);
}

/**
 * Deletes a node's declaration and its connections. Refuses when the node is a
 * group or appears in a use case, since that would need edits the user should see.
 */
export function removeNode(source: string, id: string): EditResult {
  const { diagram } = parse(source);
  const node = diagram.nodes.find((n) => n.id === id);
  if (!node) return { source };
  if (node.kind === 'group') return { error: `"${node.name}" is a group; delete it in the text so its members are handled too.` };
  if (node.kind === 'system') return { error: `"${node.name}" is a system; delete its block in the text.` };
  const useCase = diagram.useCases.find((u) =>
    u.scenarios.some((sc) => sc.steps.some((s) => s.fromServiceId === id || s.toServiceId === id)),
  );
  if (useCase) return { error: `"${node.name}" is used in the use case "${useCase.name}"; remove those steps first.` };

  const lines = diagram.edges.filter((e) => e.source === id || e.target === id).map((e) => e.loc.line);
  if (!node.implicit) lines.push(node.loc.line);
  return { source: removeStatementLines(source, lines) };
}

/** Removes whole statements starting at the given lines, including multi-line payloads. */
function removeStatementLines(source: string, starts: number[]): string {
  const lines = source.split('\n');
  const drop = new Set<number>();
  for (const start of starts) {
    let index = start - 1;
    drop.add(index);
    const label = tokenizeLine(lines[index] ?? '', start).tokens.find((t) => t.kind === 'label')?.value ?? '';
    let depth = bracketDepth(label);
    while (depth > 0 && index + 1 < lines.length) {
      index++;
      drop.add(index);
      depth += bracketDepth(lines[index]);
    }
  }
  return lines.filter((_, i) => !drop.has(i)).join('\n');
}

/** Removes every `pos x,y` so the whole diagram is auto-laid-out again. */
export function clearPositions(source: string): string {
  const { diagram } = parse(source);
  let result = source;
  const pinned = diagram.nodes.filter((n) => n.position && !n.implicit).sort((a, b) => b.loc.line - a.loc.line);
  for (const node of pinned) {
    const decl = findDeclaration(result, node.id);
    if (!decl) continue;
    const { tokens, firstProp } = decl;
    const at = tokens.findIndex((t, i) => i >= firstProp && t.kind === 'ident' && t.value === 'pos');
    if (at === -1 || tokens[at + 3]?.kind !== 'number') continue;
    const prev = tokens[at - 1];
    const next = tokens[at + 4];
    // Remove the space before `pos` too, unless `pos` sits right before `{`.
    const from = next?.kind === 'lbrace' ? tokens[at].col - 1 : end(prev);
    const to = next?.kind === 'lbrace' ? next.col - 1 : end(tokens[at + 3]);
    result = replaceInLine(result, decl.line, from, to, '');
  }
  return result;
}

/** Words that start statements, so a new node never takes them as its id. */
const RESERVED = new Set(['title', 'summary', 'group', 'usecase', 'par', 'alt', 'import', 'traffic', 'requirements', 'capacity', 'entity', 'decision', 'test', 'pos', 'direction', 'layout', 'rank']);

/** An id based on `base` (a name or a tech) that no node uses yet: `redis`, `redis2`, … */
export function uniqueId(source: string, base: string): string {
  const words = base.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  let stem = words.join('_').slice(0, 24).replace(/_+$/, '') || 'node';
  if (!/^[a-z_]/.test(stem)) stem = `n${stem}`;
  const taken = new Set(parse(source).diagram.nodes.map((n) => n.id));
  const free = (id: string) => !taken.has(id) && !RESERVED.has(id) && !/^x\d+$/.test(id);
  if (free(stem)) return stem;
  for (let n = 2; ; n++) if (free(`${stem}${n}`)) return `${stem}${n}`;
}

export interface NewNode {
  /** Defaults to an id made from the name. */
  id?: string;
  name: string;
  /** A catalog tech stack such as `Redis`; left out for a plain shape. */
  tech?: string;
  position?: { x: number; y: number };
}

/** Declares a new node before the first use case and returns it with its id. */
export function addNode(source: string, node: NewNode): { source: string; id: string } {
  const id = node.id ?? uniqueId(source, node.name || node.tech || 'node');
  const parts = [id];
  const name = cleanText(node.name);
  if (name && name !== id) parts.push(quote(name));
  if (node.tech) parts.push(`[${cleanTech(node.tech)}]`);
  if (node.position) parts.push(`pos ${Math.round(node.position.x)},${Math.round(node.position.y)}`);
  return { source: insertDeclaration(source, parts.join(' ')), id };
}

/** Sets or clears the `[tech]` of a node. */
export function setTech(source: string, id: string, tech: string | null): string {
  const text = tech ? `[${cleanTech(tech)}]` : null;
  return setProperty(source, id, (t) => t.kind === 'tech', text);
}

/** Sets the `x3` replica count of a node; 1 removes it. */
export function setReplicas(source: string, id: string, replicas: number): string {
  const n = Math.max(1, Math.floor(replicas));
  return setProperty(source, id, (t) => t.kind === 'ident' && /^x\d+$/.test(t.value), n > 1 ? `x${n}` : null);
}

/** Sets or clears the `@team` that owns a node. */
export function setOwner(source: string, id: string, team: string | null): string {
  const clean = team?.replace(/^@/, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return setProperty(source, id, (t) => t.kind === 'team', clean ? `@${clean}` : null);
}

/** Sets or clears a node's description, the second quoted string after its id. */
export function setDescription(source: string, id: string, description: string | null): string {
  const text = description ? cleanText(description) : '';
  const decl = findDeclaration(source, id);
  if (!decl) {
    if (!text) return source;
    return insertDeclaration(source, `${id} ${quote(id)} ${quote(text)}`);
  }
  const { tokens, firstProp } = decl;
  const strings = tokens.map((t, i) => ({ t, i })).filter(({ t, i }) => i >= firstProp && t.kind === 'string');
  const [name, current] = strings;
  if (current) {
    if (text) return replaceInLine(source, decl.line, current.t.col - 1, end(current.t), quote(text));
    return replaceInLine(source, decl.line, end(tokens[current.i - 1]), end(current.t), '');
  }
  if (!text) return source;
  if (name) return replaceInLine(source, decl.line, end(name.t), end(name.t), ` ${quote(text)}`);
  // A description needs a name before it.
  const idToken = tokens[firstProp - 1];
  return replaceInLine(source, decl.line, end(idToken), end(idToken), ` ${quote(decl.node.name)} ${quote(text)}`);
}

/**
 * Replaces the node property `match` finds, removes it (`text` null), or adds
 * it after the node's id, name and tech. Implicit nodes are declared first.
 */
function setProperty(source: string, id: string, match: (t: Token) => boolean, text: string | null): string {
  const decl = findDeclaration(source, id);
  if (!decl) {
    const node = parse(source).diagram.nodes.find((n) => n.id === id);
    return node && text ? insertDeclaration(source, `${id} ${text}`) : source;
  }
  const { tokens, firstProp } = decl;
  const at = tokens.findIndex((t, i) => i >= firstProp && match(t));
  if (at !== -1) {
    if (text) return replaceInLine(source, decl.line, tokens[at].col - 1, end(tokens[at]), text);
    return replaceInLine(source, decl.line, end(tokens[at - 1]), end(tokens[at]), '');
  }
  if (!text) return source;
  let head = firstProp - 1;
  while (tokens[head + 1] && (tokens[head + 1].kind === 'string' || tokens[head + 1].kind === 'tech')) head++;
  return replaceInLine(source, decl.line, end(tokens[head]), end(tokens[head]), ` ${text}`);
}

/** A capacity override the inspector can set; `rate` is the plain rps of a node. */
export type CapacityPart = 'rate' | 'reads' | 'writes' | 'latency' | 'availability' | 'cost' | 'timeout' | 'shards';

const CAPACITY_UNIT: Record<CapacityPart, (n: number) => string> = {
  rate: (n) => `${n} rps`,
  reads: (n) => `reads ${n} rps`,
  writes: (n) => `writes ${n} rps`,
  latency: (n) => `latency ${n}ms`,
  availability: (n) => `availability ${n}%`,
  cost: (n) => `cost ${n} usd/month`,
  timeout: (n) => `timeout ${n}ms`,
  shards: (n) => `shards ${Math.max(1, Math.floor(n))}`,
};

/** The parsed field of each part, so a caller can read the current value. */
export const CAPACITY_FIELD: Record<CapacityPart, keyof CapacityOverride> = {
  rate: 'rps',
  reads: 'readRps',
  writes: 'writeRps',
  latency: 'latencyMs',
  availability: 'availability',
  cost: 'costUsd',
  timeout: 'timeoutMs',
  shards: 'shards',
};

/**
 * Sets or clears one part of a node's line in the `capacity` block, adding the
 * line, or the block, when there is none. A rate replaces reads and writes and
 * the other way round, since they cannot be combined.
 */
export function setCapacity(source: string, node: string, part: CapacityPart, value: number | null): string {
  return setCapacityPart(source, node, part, value === null || !Number.isFinite(value) ? null : CAPACITY_UNIT[part](value));
}

/** Sets or clears a node's instance size (`size S|M|L`) in the `capacity` block. */
export function setSize(source: string, node: string, size: InstanceSize | null): string {
  return setCapacityPart(source, node, 'size', size ? `size ${size}` : null);
}

function setCapacityPart(source: string, node: string, part: CapacityPart | 'size', text: string | null): string {
  const parsed = parse(source);
  const existing = parsed.diagram.capacity?.find((c) => c.node === node && c.loc.file === undefined);

  if (!existing) {
    if (!text) return source;
    const block = parsed.blocks?.find((b) => b.kind === 'capacity');
    if (!block) return insertDeclaration(source, `capacity {\n  ${node} ${text}\n}`);
    const lines = source.split('\n');
    const indent = /^\s*/.exec(lines[block.start] ?? '')?.[0] || '  ';
    lines.splice(block.end - 1, 0, `${indent}${node} ${text}`);
    return lines.join('\n');
  }

  const line = existing.loc.line;
  const lineText = source.split('\n')[line - 1];
  const { tokens } = tokenizeLine(lineText, line);
  const spans = capacitySpans(tokens);
  const clashes: CapacityPart[] = part === 'rate' ? ['reads', 'writes'] : part === 'reads' || part === 'writes' ? ['rate'] : [];
  // Edit right to left so earlier columns stay valid.
  const edits: { from: number; to: number; insert: string }[] = [];
  const own = spans.find((s) => s.part === part);
  if (own) edits.push(text ? { from: own.from, to: own.to, insert: text } : { from: own.before, to: own.to, insert: '' });
  for (const s of spans) if (clashes.includes(s.part as CapacityPart) && text) edits.push({ from: s.before, to: s.to, insert: '' });
  if (!own && text) {
    const last = spans.length ? spans[spans.length - 1].to : end(tokens[0]);
    edits.push({ from: last, to: last, insert: ` ${text}` });
  }
  let updated = lineText;
  for (const e of edits.sort((a, b) => b.from - a.from)) updated = updated.slice(0, e.from) + e.insert + updated.slice(e.to);
  if (capacitySpans(tokenizeLine(updated, line).tokens).length === 0) return removeStatementLines(source, [line]);
  const lines = source.split('\n');
  lines[line - 1] = updated;
  return lines.join('\n');
}

/** The parts of a capacity line: their columns, and where the space before them starts. */
function capacitySpans(tokens: Token[]): { part: string; before: number; from: number; to: number }[] {
  const spans: { part: string; before: number; from: number; to: number }[] = [];
  const word = (t: Token | undefined, ...words: string[]) => t?.kind === 'ident' && words.includes(t.value);
  for (let i = 1; i < tokens.length; ) {
    const t = tokens[i];
    let size = 1;
    let part = t.value;
    if (t.kind === 'quantity' || t.kind === 'number') part = 'rate';
    else if (word(t, 'latency', 'availability', 'cost', 'timeout', 'reads', 'writes', 'shards', 'size', 'consistency', 'bandwidth', 'egress')) size = 2;
    else if (!word(t, 'durable', 'volatile')) break;
    const last = tokens[Math.min(i + size, tokens.length) - 1];
    spans.push({ part, before: end(tokens[i - 1]), from: t.col - 1, to: end(last) });
    i += size;
  }
  return spans;
}

/** Sets or clears the label of an architecture connection; multi-line payloads are left alone. */
export function setEdgeLabel(source: string, edgeId: string, label: string | null): string {
  const edge = parse(source).diagram.edges.find((e) => e.id === edgeId);
  if (!edge || edge.loc.file !== undefined) return source;
  const lineText = source.split('\n')[edge.loc.line - 1] ?? '';
  const { tokens } = tokenizeLine(lineText, edge.loc.line);
  const current = tokens.find((t) => t.kind === 'label');
  if (current && bracketDepth(current.value) > 0) return source;
  const clean = label ? cleanText(label) : '';
  // The label goes after the target, or after its `.tag`.
  const target = tokens[3]?.kind === 'tag' ? tokens[3] : tokens[2];
  if (!target) return source;
  const from = end(target);
  const to = current ? end(current) : from;
  return replaceInLine(source, edge.loc.line, from, to, clean ? ` : ${clean}` : '');
}

function cleanText(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').trim();
}

function cleanTech(tech: string): string {
  return cleanText(tech).replace(/[[\]]/g, '');
}

function quote(text: string): string {
  return `"${text.replace(/[\\"]/g, '\\$&')}"`;
}

interface Declaration {
  node: DiagramNode;
  line: number;
  lineText: string;
  tokens: Token[];
  /** Index of the first token after the id. */
  firstProp: number;
}

function findDeclaration(source: string, id: string): Declaration | null {
  const node = parse(source).diagram.nodes.find((n) => n.id === id && !n.implicit);
  if (!node) return null;
  const lineText = source.split('\n')[node.loc.line - 1] ?? '';
  const { tokens } = tokenizeLine(lineText, node.loc.line);
  const idIndex = tokens.findIndex((t) => t.kind === 'ident' && t.value === id && t.col === node.loc.col);
  if (idIndex === -1) return null;
  return { node, line: node.loc.line, lineText, tokens, firstProp: idIndex + 1 };
}

/** Adds a line before the first use case (they must stay last), or at the end. */
function insertDeclaration(source: string, text: string): string {
  const lines = source.split('\n');
  const useCaseLine = parse(source).diagram.useCases[0]?.loc.line;
  if (useCaseLine) {
    // Go above the blank lines that separate declarations from use cases.
    let at = useCaseLine - 1;
    while (at > 0 && lines[at - 1].trim() === '') at--;
    lines.splice(at, 0, text);
    return lines.join('\n');
  }
  if (source === '') return `${text}\n`;
  return source.endsWith('\n') ? `${source}${text}\n` : `${source}\n${text}\n`;
}

function replaceInLine(source: string, line: number, from: number, to: number, insert: string, lineText?: string): string {
  const lines = source.split('\n');
  const text = lineText ?? lines[line - 1];
  lines[line - 1] = text.slice(0, from) + insert + text.slice(to);
  return lines.join('\n');
}

function end(token: Token): number {
  return token.col - 1 + token.length;
}
