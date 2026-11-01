/**
 * The HTML of the VS Code preview panel, as pure functions so it can be
 * tested without VS Code. The page shows the architecture SVG and one
 * scenario's sequence SVG, picked from a list; the extension swaps the
 * content in place (a `postMessage`) as the document changes.
 */
import { randomBytes } from 'node:crypto';
import { analyze } from '../../../frontend/src/sim/analyze';
import type { ProjectResolver } from '../imports';
import { parse, type ParseOptions } from '../proschi';
import { viewOverlay } from '../terminal/systems';
import { renderSvgs } from './index';
import { esc } from './svg';

export interface PreviewContent {
  /** False when the document has errors; `html` then lists them. */
  ok: boolean;
  html: string;
}

/**
 * Renders a document's preview content: the diagrams, or the list of errors
 * that stop it rendering. `options` resolves imports, as for `parse`; a
 * project resolver (`fileResolver`) also gives the reason an import failed,
 * as `proschi check` and the language server do. System boxes show the
 * simulation as `proschi render` draws them.
 */
export async function renderPreviewContent(source: string, options?: ParseOptions & { resolve?: ProjectResolver | ParseOptions['resolve'] }): Promise<PreviewContent> {
  const result = parse(source, options);
  const resolver = options?.resolve;
  if (resolver && 'explain' in resolver) resolver.explain(result);
  const { diagram, diagnostics } = result;
  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (errors.length) {
    const items = errors.map((d) => `<li>${d.file ? `${esc(d.file)}: ` : ''}Line ${d.line}:${d.col}: ${esc(d.message)}</li>`).join('');
    return { ok: false, html: `<div class="errors"><strong>${errors.length} error(s)</strong>; the preview updates when they are fixed.<ul>${items}</ul></div>` };
  }

  const analysis = diagram.systems?.length && diagram.traffic?.length ? analyze(diagram) : undefined;
  const { architecture, scenarios } = await renderSvgs(diagram, true, { systems: viewOverlay(diagram, analysis).systems });
  const parts = [`<h1>${esc(diagram.title ?? 'Architecture')}</h1>`, `<section><div class="figure">${architecture}</div></section>`];
  if (scenarios.length) {
    const groups = diagram.useCases
      .map((uc) => {
        const options = scenarios
          .filter((s) => s.useCase === uc)
          .map((s) => `<option value="${esc(s.slug)}">${esc(uc.scenarios.length > 1 ? s.scenario.name : uc.name)}${s.scenario.outcome === 'error' ? ' (error)' : ''}</option>`)
          .join('');
        return `<optgroup label="${esc(uc.name)}">${options}</optgroup>`;
      })
      .join('');
    parts.push(
      `<section><label class="picker">Scenario <select id="scenario">${groups}</select></label>`,
      ...scenarios.map((s, i) => `<div class="figure scenario" data-slug="${esc(s.slug)}"${i ? ' hidden' : ''}>${s.svg}</div>`),
      '</section>',
    );
  } else {
    parts.push('<p class="hint">Add a <code>usecase</code> to see its sequence diagram here.</p>');
  }
  return { ok: true, html: parts.join('\n') };
}

const STYLE = `
body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px 16px; }
h1 { font-size: 16px; margin: 0 0 12px; }
section { margin-bottom: 20px; }
.figure { overflow: auto; border: 2px solid var(--vscode-foreground, #111111); border-radius: 4px; background: #fff8e7; }
.figure svg { display: block; max-width: 100%; height: auto; }
.picker { display: inline-flex; gap: 8px; align-items: center; margin-bottom: 8px; font-size: 13px; }
select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, #8884); padding: 2px 4px; }
.errors { border: 1px solid var(--vscode-inputValidation-errorBorder, #d33); background: var(--vscode-inputValidation-errorBackground, #d331); padding: 8px 12px; margin-bottom: 16px; border-radius: 4px; }
.errors ul { margin: 6px 0 0; padding-left: 18px; }
.hint { opacity: 0.8; }
[hidden] { display: none !important; }
`;

// Restores the picked scenario across updates and reloads (via the webview state).
const SCRIPT = `
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');
function show(slug) {
  root.querySelectorAll('.scenario').forEach((el) => { el.hidden = el.dataset.slug !== slug; });
}
function wire() {
  const select = root.querySelector('#scenario');
  if (!select) return;
  const saved = (vscode.getState() || {}).scenario;
  if (saved && Array.from(select.options).some((o) => o.value === saved)) select.value = saved;
  show(select.value);
  select.addEventListener('change', () => {
    vscode.setState({ ...(vscode.getState() || {}), scenario: select.value });
    show(select.value);
  });
}
window.addEventListener('message', (event) => {
  const message = event.data;
  if (message && message.type === 'update' && typeof message.html === 'string') {
    root.innerHTML = message.html;
    wire();
  }
});
wire();
`;

/**
 * The whole webview page. The Content-Security-Policy allows nothing remote:
 * only the nonce'd style and script, and data: images.
 */
export function previewHtml(options: { nonce: string; cspSource: string; title: string; body: string }): string {
  const { nonce, cspSource, title, body } = options;
  const csp = [`default-src 'none'`, `img-src ${cspSource} data:`, `style-src 'nonce-${nonce}'`, `script-src 'nonce-${nonce}'`].join('; ');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(title)}</title>`,
    `<style nonce="${nonce}">${STYLE}</style>`,
    '</head>',
    '<body>',
    `<div id="root">${body}</div>`,
    `<script nonce="${nonce}">${SCRIPT}</script>`,
    '</body>',
    '</html>',
  ].join('\n');
}

/** A random nonce for the CSP. */
export function makeNonce(): string {
  return randomBytes(16).toString('hex');
}
