import './zoom.css';

/*
 * Click-to-zoom for the pictures in a docs page or blog post. Without this
 * script they show as plain images. With it, each one opens in a modal
 * <dialog>: fitted to the screen, up to its own size, with its caption. A
 * click on the enlarged picture (or the "Actual size" button) then shows it
 * pixel for pixel, panned by scrolling or dragging. Pinch-zoom still works on
 * phones, because nothing here blocks touch gestures.
 */

/** Pictures this small (icons, badges) stay as they are. */
const MIN_WIDTH = 96;

function caption(img: HTMLImageElement): string {
  return img.closest('figure')?.querySelector('figcaption')?.textContent?.trim() || img.alt;
}

let dialog: HTMLDialogElement | undefined;
let opener: HTMLImageElement | undefined;

function build(): HTMLDialogElement {
  const d = document.createElement('dialog');
  d.className = 'zoom';
  d.setAttribute('aria-label', 'Enlarged image');
  d.innerHTML = `<div class="zoom__bar">
<button type="button" class="ps-btn ps-btn--sm zoom__size" aria-pressed="false">Actual size</button>
<button type="button" class="ps-btn ps-btn--sm zoom__close">Close<span class="zoom__x" aria-hidden="true">×</span></button>
</div>
<div class="zoom__stage"><img class="zoom__img" alt="" draggable="false" /></div>
<p class="zoom__caption"></p>`;
  const stage = d.querySelector<HTMLElement>('.zoom__stage')!;
  const big = d.querySelector<HTMLImageElement>('.zoom__img')!;
  const size = d.querySelector<HTMLButtonElement>('.zoom__size')!;
  let drag: { x: number; y: number; left: number; top: number } | undefined;
  let dragged = false;

  const setActual = (on: boolean) => {
    d.classList.toggle('is-actual', on);
    size.setAttribute('aria-pressed', String(on));
  };
  size.addEventListener('click', () => setActual(!d.classList.contains('is-actual')));
  d.querySelector('.zoom__close')!.addEventListener('click', () => d.close());
  // A click beside the picture (the dark backdrop) closes; a click on it toggles the size.
  d.addEventListener('click', (e) => {
    if (dragged) return;
    if (e.target === big) {
      if (d.classList.contains('can-zoom')) setActual(!d.classList.contains('is-actual'));
    } else if (!(e.target as Element).closest('button, .zoom__caption')) d.close();
  });
  // Tab and Shift+Tab cycle through the dialog's buttons, never out to the browser.
  d.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const buttons = [...d.querySelectorAll<HTMLButtonElement>('button:not([hidden])')];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    e.preventDefault();
    buttons[(at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
  });
  d.addEventListener('close', () => {
    document.documentElement.classList.remove('zoom-locked');
    setActual(false);
    big.removeAttribute('src');
    opener?.focus();
  });

  // Mouse drag pans the picture at actual size; touch scrolls and pinches natively.
  stage.addEventListener('pointerdown', (e) => {
    dragged = false;
    if (e.pointerType !== 'mouse' || e.button !== 0 || !d.classList.contains('is-actual')) return;
    drag = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!dragged && Math.hypot(dx, dy) < 4) return;
    if (!dragged) stage.setPointerCapture(e.pointerId);
    dragged = true;
    stage.classList.add('is-dragging');
    stage.scrollLeft = drag.left - dx;
    stage.scrollTop = drag.top - dy;
  });
  const endDrag = () => {
    drag = undefined;
    stage.classList.remove('is-dragging');
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  document.body.append(d);
  return d;
}

function open(img: HTMLImageElement): void {
  dialog ??= build();
  const d = dialog;
  const big = d.querySelector<HTMLImageElement>('.zoom__img')!;
  opener = img;
  big.alt = img.alt;
  // The page's picture may not have loaded yet (loading="lazy"): this one loads now.
  big.src = img.currentSrc || img.src;
  d.querySelector('.zoom__caption')!.textContent = caption(img);
  const fits = () => {
    // Worth an actual-size view only when the picture is bigger than the screen.
    const stage = d.querySelector<HTMLElement>('.zoom__stage')!;
    const can = big.naturalWidth > stage.clientWidth || big.naturalHeight > stage.clientHeight;
    d.classList.toggle('can-zoom', can);
    d.querySelector<HTMLButtonElement>('.zoom__size')!.hidden = !can;
  };
  d.classList.remove('can-zoom');
  d.querySelector<HTMLButtonElement>('.zoom__size')!.hidden = true;
  if (big.complete && big.naturalWidth) requestAnimationFrame(fits);
  else big.addEventListener('load', fits, { once: true });
  document.documentElement.classList.add('zoom-locked');
  d.showModal();
  d.querySelector<HTMLElement>('.zoom__close')!.focus();
}

/** Makes the article's pictures open enlarged. */
export function enableZoom(root: ParentNode = document): void {
  for (const img of root.querySelectorAll<HTMLImageElement>('.doc-body img')) {
    if (img.closest('a, button, [data-live], .zoom')) continue;
    const width = Number(img.getAttribute('width')) || img.naturalWidth;
    if (width && width < MIN_WIDTH) continue;
    img.classList.add('is-zoomable');
    img.tabIndex = 0;
    img.setAttribute('role', 'button');
    img.setAttribute('aria-haspopup', 'dialog');
    img.setAttribute('aria-label', `Enlarge image: ${img.alt}`);
    img.addEventListener('click', () => open(img));
    img.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      open(img);
    });
  }
}
