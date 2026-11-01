import * as vscode from 'vscode';
import { fileResolver } from '../../src/imports';
import { makeNonce, previewHtml, renderPreviewContent } from '../../src/render/preview';

const DEBOUNCE_MS = 300;

/**
 * `Proschi: Open Preview to the Side`: one webview panel that renders the
 * active Proschi document (architecture plus a scenario picker), re-rendering
 * as it changes and following whichever Proschi editor is active.
 */
export class PreviewPanel {
  private static current: PreviewPanel | undefined;

  private document: vscode.TextDocument;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private version = 0;
  private lastGood = '';
  /** The content last shown; written into a fresh page when the panel is shown again. */
  private body = '<p>Rendering…</p>';
  private loaded = false;
  private readonly disposables: vscode.Disposable[] = [];

  static show(document: vscode.TextDocument) {
    if (PreviewPanel.current) {
      PreviewPanel.current.follow(document);
      PreviewPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    const panel = vscode.window.createWebviewPanel('proschi.preview', 'Proschi Preview', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
      enableScripts: true,
      localResourceRoots: [],
    });
    PreviewPanel.current = new PreviewPanel(panel, document);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    document: vscode.TextDocument,
  ) {
    this.document = document;
    this.load();
    // Messages sent before the page has loaded can be lost, so the first render replaces the page.
    this.loaded = false;
    this.update(0);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    // A hidden webview is discarded; it comes back with the last page set, so set a current one.
    this.panel.onDidChangeViewState(() => this.panel.visible && this.load(), null, this.disposables);
    vscode.workspace.onDidChangeTextDocument(
      (e) => {
        // An imported file may have changed too.
        if (e.document === this.document || e.document.languageId === 'proschi') this.update(DEBOUNCE_MS);
      },
      null,
      this.disposables,
    );
    vscode.window.onDidChangeActiveTextEditor(
      (editor) => {
        if (editor?.document.languageId === 'proschi' && editor.document !== this.document) this.follow(editor.document);
      },
      null,
      this.disposables,
    );
  }

  /** Replaces the whole page; later renders only swap its content (keeping scroll and the picked scenario). */
  private load() {
    this.panel.webview.html = previewHtml({ nonce: makeNonce(), cspSource: this.panel.webview.cspSource, title: this.title(), body: this.body });
    this.loaded = true;
  }

  private title(): string {
    return `Preview ${this.document.uri.path.split('/').pop() ?? ''}`;
  }

  private follow(document: vscode.TextDocument) {
    if (document === this.document) return;
    this.document = document;
    this.lastGood = '';
    this.update(0);
  }

  private update(delay: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.render(), delay);
  }

  private async render() {
    const version = ++this.version;
    const document = this.document;
    let html: string;
    try {
      const content = await renderPreviewContent(document.getText(), parseOptions(document));
      if (content.ok) this.lastGood = content.html;
      html = content.ok ? content.html : content.html + this.lastGood;
    } catch (error) {
      html = `<div class="errors">The preview could not be rendered: ${String((error as Error).message).replace(/[&<>]/g, '')}</div>${this.lastGood}`;
    }
    // A newer render (or a different document) has started meanwhile.
    if (version !== this.version || document !== this.document) return;
    this.panel.title = this.title();
    this.body = html;
    if (this.loaded) await this.panel.webview.postMessage({ type: 'update', html });
    else this.load();
  }

  private dispose() {
    PreviewPanel.current = undefined;
    clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }
}

/** Imports resolve relative to the document, preferring the text of open (possibly unsaved) documents. */
function parseOptions(document: vscode.TextDocument) {
  if (document.uri.scheme !== 'file') return undefined;
  const open = (path: string) => vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === path)?.getText();
  return { path: document.uri.fsPath, resolve: fileResolver({ entry: document.uri.fsPath, read: open }) };
}

export function registerPreview(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('proschi.openPreview', (uri?: vscode.Uri) => {
      const editor = vscode.window.activeTextEditor;
      const fromUri = uri && vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
      const document = fromUri ?? (editor?.document.languageId === 'proschi' ? editor.document : undefined);
      if (!document) {
        vscode.window.showInformationMessage('Open a .proschi file to preview it.');
        return;
      }
      PreviewPanel.show(document);
    }),
  );
}
