/**
 * Proschi language server (LSP over stdio). Any editor with an LSP client
 * gets the same diagnostics as the web editor, plus completion, hover,
 * go-to-definition, references, an outline, formatting and links on import
 * paths, and failing requirements and tests as warnings (source `proschi-test`). Imports resolve from disk relative to the document, preferring the
 * text of open (possibly unsaved) documents, confined to the project root;
 * git and https imports come from the cache of `proschi imports sync`.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CodeActionKind,
  CompletionItemKind,
  DiagnosticSeverity,
  InsertTextFormat,
  MarkupKind,
  ProposedFeatures,
  SymbolKind,
  TextDocumentSyncKind,
  TextDocuments,
  createConnection,
  type CodeAction,
  type DocumentSymbol,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { statSync } from 'node:fs';
import { openApiDiagnostics, watchedFiles } from './openapi/config';
import { analyze, complete, declaration, hover, outline, quickFix, references, semanticTokens, toRange, type Analysis, type OutlineSymbol, type TokenKind } from './analysis';
import { fileResolver, importLinks, ownDiagnostics } from './imports';
import { format } from './proschi';
import { testDiagnostics } from './simulation';

declare const PROSCHI_VERSION: string;

if (process.argv.includes('--version')) {
  console.log(typeof PROSCHI_VERSION === 'string' ? PROSCHI_VERSION : 'dev');
  process.exit(0);
}

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
/** Analyses by URI, with the files their imports read, so a change to one of those re-validates them. */
const cache = new Map<string, { version: number; analysis: Analysis; files: Set<string> }>();

const pathOf = (uri: string): string | undefined => (uri.startsWith('file:') ? fileURLToPath(uri) : undefined);
const uriOf = (path: string): string => pathToFileURL(path).href;

/** Open documents by file path; their text wins over what is on disk. */
function openText(path: string): string | undefined {
  return documents.all().find((d) => pathOf(d.uri) === path)?.getText();
}

function analysisOf(doc: TextDocument): Analysis {
  const cached = cache.get(doc.uri);
  if (cached?.version === doc.version) return cached.analysis;
  const path = pathOf(doc.uri);
  // Per document: its project root confines its imports; remote ones come from the sync cache only.
  const resolve = fileResolver({ entry: path, read: openText });
  const analysis = analyze(doc.getText(), { path, resolve });
  resolve.explain(analysis.result);
  const files = new Set((analysis.result.imports ?? []).flatMap((i) => (i.resolved ? [i.resolved] : [])));
  cache.set(doc.uri, { version: doc.version, analysis, files });
  return analysis;
}

/** Re-validates the open documents that import `uri`, directly or through other files. */
function publishDependents(uri: string) {
  const path = pathOf(uri);
  if (!path) return;
  for (const doc of documents.all()) {
    if (doc.uri === uri || !cache.get(doc.uri)?.files.has(path)) continue;
    cache.delete(doc.uri);
    validate(doc);
  }
}

// Standard token types, so every theme colours them: node ids, tech stacks, teams, legend tags.
const TOKEN_TYPE: Record<TokenKind, string> = { node: 'variable', tech: 'type', team: 'decorator', tag: 'enumMember' };
const TOKEN_TYPES = Object.values(TOKEN_TYPE);

connection.onInitialize(() => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    completionProvider: { triggerCharacters: ['[', ' '] },
    hoverProvider: true,
    definitionProvider: true,
    referencesProvider: true,
    documentSymbolProvider: true,
    documentLinkProvider: { resolveProvider: false },
    documentFormattingProvider: true,
    codeActionProvider: { codeActionKinds: [CodeActionKind.QuickFix] },
    semanticTokensProvider: { legend: { tokenTypes: TOKEN_TYPES, tokenModifiers: [] }, full: true },
  },
  serverInfo: { name: 'proschi-language-server', version: typeof PROSCHI_VERSION === 'string' ? PROSCHI_VERSION : 'dev' },
}));

function validate(document: TextDocument) {
  const analysis = analysisOf(document);
  const toLsp = (source: string) => (d: Analysis['diagnostics'][number]) => ({
    range: toRange(d),
    severity: d.severity === 'error' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
    source,
    message: d.message,
  });
  connection.sendDiagnostics({
    uri: document.uri,
    version: document.version,
    diagnostics: [
      ...ownDiagnostics(analysis.result).map(toLsp('proschi')),
      // Findings on steps in imported files belong to those files.
      ...openApiFindings(document, analysis.diagram)
        .filter((d) => d.file === undefined)
        .map(toLsp('proschi-openapi')),
      ...simulationFindings(analysis.diagram).map(toLsp('proschi-test')),
    ],
  });
}

/** Failing requirements and tests; the simulation must never take the other diagnostics down with it. */
function simulationFindings(diagram: Analysis['diagram']) {
  try {
    return testDiagnostics(diagram);
  } catch (e) {
    connection.console.error(`Simulation failed: ${String(e)}`);
    return [];
  }
}

/** Findings against the specs named in the nearest proschi.json, for documents saved on disk. */
function openApiFindings(document: TextDocument, diagram: Analysis['diagram']) {
  if (!document.uri.startsWith('file:')) return [];
  try {
    return openApiDiagnostics(fileURLToPath(document.uri), diagram);
  } catch {
    return [];
  }
}

documents.onDidChangeContent(({ document }) => {
  validate(document);
  publishDependents(document.uri);
});

// Specs and proschi.json change outside the editor; re-check open documents when they do.
// Spec and config reads are cached by modification time, so this costs a stat per file.
function watchedStamp(): string {
  return watchedFiles()
    .map((file) => {
      try {
        return `${file}:${statSync(file).mtimeMs}`;
      } catch {
        return `${file}:missing`;
      }
    })
    .join('\n');
}

let stamp = '';
setInterval(() => {
  const next = watchedStamp();
  if (stamp && next !== stamp) documents.all().forEach(validate);
  stamp = next;
}, 2000).unref();

documents.onDidClose(({ document }) => {
  cache.delete(document.uri);
  connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
  // Dependents now read the file from disk again.
  publishDependents(document.uri);
});

const withDoc =
  <T>(fallback: T, fn: (analysis: Analysis, params: { position: { line: number; character: number } }) => T) =>
  (params: { textDocument: { uri: string }; position: { line: number; character: number } }): T => {
    const doc = documents.get(params.textDocument.uri);
    return doc ? fn(analysisOf(doc), params) : fallback;
  };

const COMPLETION_KIND = { keyword: CompletionItemKind.Keyword, node: CompletionItemKind.Variable, tech: CompletionItemKind.Class };

connection.onCompletion(
  withDoc([], (analysis, { position }) =>
    complete(analysis, position).map((item) => ({
      label: item.label,
      kind: COMPLETION_KIND[item.kind],
      detail: item.detail,
      textEdit: { range: item.range, newText: item.snippet ?? item.insertText ?? item.label },
      ...(item.filterText ? { filterText: item.filterText } : {}),
      insertTextFormat: item.snippet ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
    })),
  ),
);

connection.onHover(
  withDoc(null, (analysis, { position }) => {
    const result = hover(analysis, position);
    return result && { contents: { kind: MarkupKind.Markdown, value: result.markdown }, range: result.range };
  }),
);

connection.onDefinition((params) => {
  const doc = documents.get(params.textDocument.uri);
  const found = doc && declaration(analysisOf(doc), params.position);
  if (!found) return null;
  return { uri: found.file ? uriOf(found.file) : params.textDocument.uri, range: found.range };
});

connection.onDocumentLinks((params) => {
  const doc = documents.get(params.textDocument.uri);
  return doc ? importLinks(analysisOf(doc).result).map(({ range, target }) => ({ range, target: uriOf(target) })) : [];
});

connection.onReferences((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  return references(analysisOf(doc), params.position).map((range) => ({ uri: params.textDocument.uri, range }));
});

const SYMBOL_KIND: Record<OutlineSymbol['kind'], SymbolKind> = {
  node: SymbolKind.Object,
  group: SymbolKind.Namespace,
  usecase: SymbolKind.Function,
  scenario: SymbolKind.Event,
  section: SymbolKind.Module,
  traffic: SymbolKind.Property,
  requirement: SymbolKind.Constant,
  entity: SymbolKind.Struct,
  decision: SymbolKind.Key,
  test: SymbolKind.Method,
};

function toSymbol(s: OutlineSymbol): DocumentSymbol {
  return { name: s.name, detail: s.detail, kind: SYMBOL_KIND[s.kind], range: s.range, selectionRange: s.range, children: s.children.map(toSymbol) };
}

connection.onDocumentSymbol((params) => {
  const doc = documents.get(params.textDocument.uri);
  return doc ? outline(analysisOf(doc)).map(toSymbol) : [];
});

// One edit that replaces the whole document, or none when it is already formatted.
connection.onDocumentFormatting((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const text = doc.getText();
  const formatted = format(text);
  return formatted === text ? [] : [{ range: { start: { line: 0, character: 0 }, end: doc.positionAt(text.length) }, newText: formatted }];
});

connection.onCodeAction((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const analysis = analysisOf(doc);
  const actions: CodeAction[] = [];
  for (const diagnostic of params.context.diagnostics) {
    if (diagnostic.source !== 'proschi') continue;
    const fix = typeof diagnostic.message === 'string' && quickFix(analysis, diagnostic.message, diagnostic.range);
    if (!fix) continue;
    actions.push({
      title: fix.title,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      isPreferred: true,
      edit: { changes: { [params.textDocument.uri]: [fix.edit] } },
    });
  }
  return actions;
});

// Each token as [deltaLine, deltaStart, length, type, modifiers], relative to the previous one.
connection.languages.semanticTokens.on((params) => {
  const doc = documents.get(params.textDocument.uri);
  const data: number[] = [];
  let line = 0;
  let character = 0;
  for (const t of doc ? semanticTokens(analysisOf(doc)) : []) {
    data.push(t.line - line, t.line === line ? t.character - character : t.character, t.length, TOKEN_TYPES.indexOf(TOKEN_TYPE[t.kind]), 0);
    line = t.line;
    character = t.character;
  }
  return { data };
});

documents.listen(connection);
connection.listen();
