import { BracketCounter, qualify, stripTrailingComment, tokenizeLine, type Token } from './lexer';

/**
 * The canonical layout of a Proschi document: two spaces per open block,
 * aligned columns within runs of node declarations and of connections, single
 * blank lines, one trailing newline.
 *
 * The formatter works on token shapes, never on the parser's meaning, so it
 * also lays out statements the parser rejects. Each rewritten line is lexed
 * again and must give the same tokens as the original, or the original text is
 * kept; lines the lexer cannot read, strings, labels, comments and multi-line
 * payloads are kept verbatim apart from their indentation.
 */
export function format(source: string): string {
  const entries = classify(source.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)));
  const out: string[] = [];
  let run: Entry[] = [];
  const flush = () => {
    if (run.length) out.push(...renderRun(run));
    run = [];
  };

  tidyBlankLines(entries).forEach((entry) => {
    const last = run[run.length - 1];
    if (
      last &&
      (entry.kind !== last.kind ||
        entry.depth !== last.depth ||
        (last.kind === 'connection' && last.continuation.length) ||
        (last.kind === 'cells' && entry.kind === 'cells' && entry.section !== last.section))
    )
      flush();
    if (entry.kind === 'node' || entry.kind === 'connection' || entry.kind === 'cells') run.push(entry);
    else {
      flush();
      out.push(entry.kind === 'blank' ? '' : indent(entry.depth) + entry.text);
    }
  });
  flush();

  return out.length ? out.join('\n') + '\n' : '';
}

/**
 * Where `offset` in `before` ends up in `after`, its formatted text. Formatting
 * only moves whitespace, so the position after the same number of
 * non-whitespace characters is the same place in the code.
 */
export function formattedOffset(before: string, after: string, offset: number): number {
  let count = 0;
  for (let i = 0; i < offset && i < before.length; i++) if (!/\s/.test(before[i])) count++;
  let i = 0;
  for (; i < after.length && count > 0; i++) if (!/\s/.test(after[i])) count--;
  // A cursor right before a token stays right before it, past any new indentation.
  if (offset < before.length && !/\s/.test(before[offset])) while (i < after.length && /\s/.test(after[i])) i++;
  return i;
}

const INDENT = '  ';
/** Words that start a statement other than a node declaration. */
const KEYWORDS = new Set(['title', 'import', 'group', 'usecase', 'par', 'alt']);
/** Sections whose lines are laid out in aligned columns. */
type Section = 'traffic' | 'requirements' | 'capacity' | 'entity' | 'decision' | 'test';

interface Base {
  depth: number;
  /** The line as written, without leading and trailing whitespace: the fallback. */
  original: string;
  tokens: Token[];
  comment: string;
}

/** `id "Name" [Tech] @team rest…`: the cells that are aligned in columns. */
interface NodeEntry extends Base {
  kind: 'node';
  cells: [id: string, name: string, tech: string, team: string, rest: string];
}

interface ConnectionEntry extends Base {
  kind: 'connection';
  from: string;
  arrow: string;
  to: string;
  /** `.planned` between the target and the label. */
  tag?: string;
  label?: string;
  /** Payload lines after the first, already re-indented. */
  continuation: string[];
}

/**
 * A line inside a section whose parts line up in columns: traffic (use case,
 * rate, mix), capacity (node, overrides) and entity fields (name, type,
 * flags). Every cell but the last is padded.
 */
interface CellsEntry extends Base {
  kind: 'cells';
  section: Section;
  cells: string[];
}

/** Any other line, written out as is at its depth. */
interface LineEntry {
  kind: 'line' | 'blank';
  depth: number;
  text: string;
  /** Ends with `{` (opens a block) / starts with `}` (closes one). */
  opens?: boolean;
  closes?: boolean;
}

type Entry = NodeEntry | ConnectionEntry | CellsEntry | LineEntry;

function classify(lines: string[]): Entry[] {
  const entries: Entry[] = [];
  let depth = 0;
  /** The top-level section block the line is in, if any. */
  let section: Section | undefined;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const original = raw.trim();
    if (!original) {
      entries.push({ kind: 'blank', depth, text: '' });
      continue;
    }

    // `orders.api` by an arrow is one id to the parser, so it is one token here and stays tight.
    const { tokens: lexed, diagnostics } = tokenizeLine(raw, i + 1);
    const tokens = qualify(lexed);
    // Lines the lexer cannot read are skipped by the parser; keep them as written.
    if (diagnostics.some((d) => d.severity === 'error') || tokens.length === 0) {
      entries.push({ kind: 'line', depth, text: original });
      continue;
    }

    const comment = commentOf(raw, tokens);
    const base = { depth, original, tokens, comment };
    const [first, second, third, fourth] = tokens;

    // Lines of a section are never nodes or connections (the parser reads them by the section's rules).
    const inSection = section !== undefined && depth === 1 && first.kind !== 'rbrace';
    const cells = inSection ? sectionCells(section!, raw, tokens) : undefined;
    if (cells) {
      entries.push({ ...base, kind: 'cells', section: section!, cells });
      continue;
    }

    // Same shape test as the parser, so multi-line payloads are found the same way.
    const tag = fourth?.kind === 'tag' ? fourth : undefined;
    const labelToken = tokens[tag ? 4 : 3];
    if (
      !inSection &&
      first.kind === 'ident' &&
      second?.kind === 'arrow' &&
      third?.kind === 'ident' &&
      tokens.length <= (tag ? 5 : 4) &&
      (!labelToken || labelToken.kind === 'label')
    ) {
      const entry: ConnectionEntry = { ...base, kind: 'connection', from: first.value, arrow: second.value, to: third.value, tag: tag?.value, label: labelToken?.value, continuation: [] };
      const brackets = new BracketCounter();
      if (labelToken && brackets.feed(labelToken.value) > 0) {
        // The payload continues until its brackets balance; keep its own indentation relative to the step.
        const delta = indent(depth).length - width(leadingSpace(raw));
        while (i + 1 < lines.length) {
          const next = lines[++i];
          entry.continuation.push(reindent(next, delta));
          if (brackets.feed('\n' + next) <= 0) break;
        }
        // An unclosed payload runs to the end of the file; its trailing blank lines are not part of it.
        while (entry.continuation[entry.continuation.length - 1] === '') entry.continuation.pop();
      }
      entries.push(entry);
      continue;
    }

    const oneLineDecision = first.value === 'decision' && second?.kind === 'string' && third?.kind === 'ident' && third.value === 'because';
    if (!inSection && first.kind === 'ident' && !KEYWORDS.has(first.value) && !oneLineDecision && !isLayoutHint(tokens) && tokens.slice(1).every((t) => ['string', 'tech', 'team', 'ident', 'number', 'comma', 'tag', 'hex'].includes(t.kind))) {
      let k = 1;
      const take = (kind: Token['kind']) => (tokens[k]?.kind === kind ? source(raw, tokens[k++]) : '');
      const cells: NodeEntry['cells'] = [first.value, take('string'), take('tech'), take('team'), join(raw, tokens.slice(k))];
      entries.push({ ...base, kind: 'node', cells });
      continue;
    }

    const closes = first.kind === 'rbrace';
    const opens = tokens[tokens.length - 1].kind === 'lbrace';
    const code = join(raw, tokens);
    const text = withComment(code, comment);
    entries.push({ kind: 'line', depth: Math.max(0, depth - (closes ? 1 : 0)), text: sameTokens(text, tokens) ? text : original, opens, closes });
    if (depth === 0) section = sectionOpenedBy(tokens);
    for (const t of tokens) depth = Math.max(0, depth + (t.kind === 'lbrace' ? 1 : t.kind === 'rbrace' ? -1 : 0));
    if (depth === 0) section = undefined;
  }

  return entries;
}

/** `direction right` or `layout ordered`, recognised by the same shape as the parser: a statement, not a node. */
function isLayoutHint(tokens: Token[]): boolean {
  const [first, second] = tokens;
  return (
    tokens.length === 2 &&
    (first.value === 'direction' || first.value === 'layout') &&
    second.kind === 'ident' &&
    !['pos', 'critical', 'color', 'rank'].includes(second.value) &&
    !/^x\d+$/.test(second.value)
  );
}

/** The section a top-level line opens, recognised by the same shapes as the parser. */
function sectionOpenedBy(tokens: Token[]): Section | undefined {
  const [first, second] = tokens;
  if (first.kind !== 'ident' || tokens[tokens.length - 1].kind !== 'lbrace') return undefined;
  switch (first.value) {
    case 'traffic':
    case 'requirements':
    case 'capacity':
      return second?.kind === 'lbrace' ? first.value : undefined;
    case 'entity':
      return second?.kind === 'ident' ? 'entity' : undefined;
    case 'decision':
    case 'test':
      return second?.kind === 'string' ? first.value : undefined;
    default:
      return undefined;
  }
}

/** The columns of a section line, or undefined to write it as a plain line. */
function sectionCells(section: Section, raw: string, tokens: Token[]): string[] | undefined {
  const [first, second] = tokens;
  if (tokens.some((t) => t.kind === 'lbrace' || t.kind === 'rbrace' || t.kind === 'arrow' || t.kind === 'label')) return undefined;
  const rest = (from: number) => (tokens.length > from ? [join(raw, tokens.slice(from))] : []);
  switch (section) {
    case 'traffic':
      return first.kind === 'string' && (second?.kind === 'quantity' || second?.kind === 'number') ? [source(raw, first), source(raw, second), ...rest(2)] : undefined;
    case 'capacity':
      return first.kind === 'ident' && tokens.length > 1 ? [first.value, ...rest(1)] : undefined;
    case 'entity':
      return first.kind === 'ident' && second?.kind === 'ident' ? [first.value, second.value, ...rest(2)] : undefined;
    default:
      return undefined;
  }
}

/** Drops blank lines at the ends, after `{`, before `}` and after another blank line. */
function tidyBlankLines(entries: Entry[]): Entry[] {
  const kept: Entry[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'blank') {
      if (entry.kind === 'line' && entry.closes) while (kept[kept.length - 1]?.kind === 'blank') kept.pop();
      kept.push(entry);
      continue;
    }
    const prev = kept[kept.length - 1];
    if (!prev || prev.kind === 'blank' || (prev.kind === 'line' && prev.opens)) continue;
    kept.push(entry);
  }
  while (kept[kept.length - 1]?.kind === 'blank') kept.pop();
  return kept;
}

/** Lays out a run of node declarations or connections at one depth, with aligned columns. */
function renderRun(run: Entry[]): string[] {
  const codes =
    run[0].kind === 'node' ? alignNodes(run as NodeEntry[]) : run[0].kind === 'cells' ? alignCells(run as CellsEntry[]) : alignConnections(run as ConnectionEntry[]);
  const items = run as (NodeEntry | ConnectionEntry | CellsEntry)[];

  // Trailing comments line up when more than one line of the run has one.
  const commented = items.filter((e) => e.comment);
  const commentCol = commented.length > 1 ? Math.max(...items.map((e, i) => (e.comment ? len(codes[i]) : 0))) + 1 : 0;

  return items.flatMap((entry, i) => {
    const code = entry.comment && commentCol ? pad(codes[i], commentCol) + entry.comment : withComment(codes[i], entry.comment);
    const text = sameTokens(code, entry.tokens) ? code : entry.original;
    return [indent(entry.depth) + text, ...(entry.kind === 'connection' ? entry.continuation : [])];
  });
}

function alignNodes(run: NodeEntry[]): string[] {
  const widths = [0, 1, 2, 3].map((c) => Math.max(...run.map((e) => len(e.cells[c]))));
  return run.map(({ cells }) => {
    let line = '';
    // Without a team, the rest (a description, `pos`) moves into the team column instead of leaving a gap.
    const columns = !cells[3] && cells[4] ? 3 : 4;
    for (let c = 0; c < columns; c++) if (widths[c]) line += pad(cells[c], widths[c] + 1);
    return (line + cells[4]).trimEnd();
  });
}

/** Pads every cell but a row's last to the widest cell of its column. */
function alignCells(run: CellsEntry[]): string[] {
  const widths: number[] = [];
  for (const { cells } of run) cells.slice(0, -1).forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, len(c))));
  return run.map(({ cells }) => cells.map((c, i) => (i < cells.length - 1 ? pad(c, widths[i] + 1) : c)).join(''));
}

/** `from` and the arrow are right-aligned, so targets start in one column; then ` .tag` and ` : label`. */
function alignConnections(run: ConnectionEntry[]): string[] {
  const head = Math.max(...run.map((e) => len(e.from) + 1 + e.arrow.length));
  const end = (e: ConnectionEntry) => (e.tag ? `${e.to} .${e.tag}` : e.to);
  const labelled = run.filter((e) => e.label !== undefined);
  const target = labelled.length ? Math.max(...labelled.map((e) => len(end(e)))) : 0;
  return run.map((e) => {
    const start = e.from + ' '.repeat(head - len(e.from) - e.arrow.length) + e.arrow + ' ';
    if (e.label === undefined) return start + end(e);
    return start + pad(end(e), target) + ' :' + (e.label ? ' ' + e.label : '');
  });
}

/** The trailing `# comment` of a line, or ''. For a label it is what the lexer cut off. */
function commentOf(raw: string, tokens: Token[]): string {
  const last = tokens[tokens.length - 1];
  if (last.kind === 'label') {
    const after = raw.slice(last.col);
    return after.slice(stripTrailingComment(after).length).trim();
  }
  return raw.slice(last.col - 1 + last.length).trim();
}

/** Tokens as written, one space apart; `x,y` stays tight, other commas are followed by a space, and a label is `: text`. */
function join(raw: string, tokens: Token[]): string {
  let out = '';
  for (const [i, t] of tokens.entries()) {
    const text = t.kind === 'label' ? ':' + (t.value ? ' ' + t.value : '') : source(raw, t);
    const tight = t.kind === 'comma' || (tokens[i - 1]?.kind === 'comma' && t.kind === 'number');
    out += (i === 0 || tight ? '' : ' ') + text;
  }
  return out;
}

/** True when the rewritten line lexes to exactly the original tokens. */
function sameTokens(text: string, tokens: Token[]): boolean {
  const { tokens: lexed, diagnostics } = tokenizeLine(text, 1);
  const again = qualify(lexed);
  return diagnostics.length === 0 && again.length === tokens.length && again.every((t, i) => t.kind === tokens[i].kind && t.value === tokens[i].value);
}

/** Shifts a payload line by `delta` columns, keeping its content verbatim. */
function reindent(line: string, delta: number): string {
  const lead = leadingSpace(line);
  const body = line.slice(lead.length).trimEnd();
  return body ? ' '.repeat(Math.max(0, width(lead) + delta)) + body : '';
}

/** A token as written; the space inside a quantity such as `100k   rps` becomes one. */
const source = (raw: string, t: Token) => {
  const text = raw.slice(t.col - 1, t.col - 1 + t.length);
  return t.kind === 'quantity' ? text.replace(/[ \t]+/g, ' ') : text;
};
const withComment = (code: string, comment: string) => (comment ? code + ' ' + comment : code);
const leadingSpace = (line: string) => /^[ \t]*/.exec(line)![0];
/** Columns of leading whitespace; a tab counts as one indentation step. */
const width = (space: string) => [...space].reduce((n, ch) => n + (ch === '\t' ? INDENT.length : 1), 0);
/** Indentation stops growing past MAX_INDENT levels, so a crafted file of `{` lines cannot blow up the output. */
const MAX_INDENT = 32;
const indent = (depth: number) => INDENT.repeat(Math.min(depth, MAX_INDENT));
/** Length in code points, so names with accents or emoji align as well as a monospace font allows. */
const len = (s: string) => [...s].length;
const pad = (s: string, to: number) => s + ' '.repeat(Math.max(0, to - len(s)));
