import { createRoot } from 'react-dom/client';
import { parse } from '../dsl';
import LiveExample from './LiveExample';
import { litByLine, type Lit } from './annotations';

/** Decodes the base64 UTF-8 source plugins/docsSite.ts put on the figure. */
export function decodeSource(base64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
}

/** Turns a `<figure data-live>` into a live example below its code. Loaded on demand by main.ts. */
export function mountLiveExample(figure: HTMLElement, siteRoot: string): void {
  const source = decodeSource(figure.dataset.source ?? '');
  const slot = document.createElement('div');
  slot.className = 'live__slot';
  figure.append(slot);
  figure.classList.add('is-live');
  const root = createRoot(slot);
  const render = (lit?: Lit) => root.render(<LiveExample source={source} siteRoot={siteRoot} lit={lit} />);
  render();
  if (figure.dataset.annotated !== undefined) annotate(figure, slot, source, render);
}

const HINT = 'Hover, tap or tab to a marked line to see what it draws.';

/**
 * An annotated example (```proschi annotated): pointing at, tapping or
 * focusing a marked line shows its note in a live region by the diagram and
 * lights up what the line draws. Arrow keys move between the marked lines.
 */
function annotate(figure: HTMLElement, slot: HTMLElement, source: string, render: (lit?: Lit) => void): void {
  const diagram = parse(source).diagram;
  const allLines = [...figure.querySelectorAll<HTMLElement>('pre code > .line')];
  const lines = allLines.filter((l) => l.dataset.note !== undefined);
  const notes = [...figure.querySelectorAll<HTMLElement>('.annotated__notes > li')];
  const noteHtml = (i: number) => notes[i]?.querySelector('.annotated__text')?.innerHTML ?? '';

  const panel = document.createElement('p');
  panel.className = 'annotated__note';
  panel.setAttribute('aria-live', 'polite');
  // The note and the diagram stay together: beside the code on wide screens, docked under it on phones.
  const dock = document.createElement('div');
  dock.className = 'annotated__dock';
  slot.before(dock);
  dock.append(panel, slot);

  let pinned = -1;
  let shown = -2;
  const show = (i: number) => {
    if (i === shown) return;
    shown = i;
    lines.forEach((l, j) => l.classList.toggle('is-active', j === i));
    if (i < 0) {
      panel.classList.remove('has-note');
      panel.textContent = HINT;
      render();
      return;
    }
    const line = allLines.indexOf(lines[i]) + 1;
    panel.classList.add('has-note');
    panel.innerHTML = `<span class="annotated__where">Line ${line}</span> ${noteHtml(i)}`;
    render(litByLine(diagram, line));
  };
  show(-1);

  const pin = (i: number) => {
    pinned = i;
    show(i);
  };
  const focusLine = (i: number) => {
    lines.forEach((l, j) => (l.tabIndex = j === i ? 0 : -1));
    lines[i].focus();
  };

  lines.forEach((line, i) => {
    line.tabIndex = i === 0 ? 0 : -1;
    line.classList.add('is-annotated');
    line.addEventListener('mouseenter', () => show(i));
    line.addEventListener('mouseleave', () => show(pinned));
    line.addEventListener('focus', () => {
      lines.forEach((l, j) => (l.tabIndex = j === i ? 0 : -1));
      pin(i);
    });
    // A tap (or click) on the line that is already shown hides it again. Focus comes before the click, so look before it.
    let wasPinned = false;
    line.addEventListener('pointerdown', () => (wasPinned = pinned === i));
    line.addEventListener('click', () => {
      if (wasPinned) {
        pin(-1);
        line.blur();
      } else focusLine(i);
      wasPinned = false;
    });
    line.addEventListener('keydown', (e) => {
      const to =
        e.key === 'ArrowDown' || e.key === 'ArrowRight'
          ? Math.min(i + 1, lines.length - 1)
          : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
            ? Math.max(i - 1, 0)
            : e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? lines.length - 1
                : undefined;
      if (to !== undefined) {
        e.preventDefault();
        focusLine(to);
      } else if (e.key === 'Escape') {
        pin(-1);
      }
    });
  });
}
