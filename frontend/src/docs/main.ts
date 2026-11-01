import '../design/site.css';
import './docs.css';
import { enhance } from '../design/enhance';
import { anchorRedirect } from './anchorRedirect';
import { enableZoom } from './zoom';

/*
 * The docs pages are static HTML (plugins/docsSite.ts) and read fine without
 * this script: the sidebar opens as a :target drawer on phones, and the live
 * examples stay highlighted code. With it: the shared header's controls, a
 * drawer that closes on Escape or a tap outside, the "On this page" list
 * following the reading position, pictures that open enlarged, and live
 * examples once they near the screen.
 */

enhance();
enableZoom();

const docs = document.querySelector<HTMLElement>('.docs');
const siteRoot = docs?.dataset.siteRoot ?? '../';

// ---------- old anchors that moved to another page ----------

const redirects = docs?.dataset.anchorRedirects;
if (redirects) {
  const map = JSON.parse(redirects) as Record<string, string>;
  const follow = () => {
    const to = location.hash && anchorRedirect(map, location.hash, new URL(`${siteRoot}docs/`, location.href).href);
    if (to) location.replace(to);
  };
  follow();
  window.addEventListener('hashchange', follow);
}

// ---------- the sidebar drawer (phones) ----------

const nav = document.getElementById('docs-nav');
const openLink = document.querySelector<HTMLAnchorElement>('.docs-drawer-open');
const closeLink = document.querySelector<HTMLAnchorElement>('.docs-drawer-close');

function setDrawer(open: boolean, focus = true): void {
  if (!nav || !openLink) return;
  nav.classList.toggle('is-open', open);
  openLink.setAttribute('aria-expanded', String(open));
  document.documentElement.classList.toggle('docs-drawer-locked', open);
  if (!focus) return;
  if (open) nav.querySelector<HTMLElement>('[aria-current="page"], a')?.focus();
  else openLink.focus();
}

if (nav && openLink && closeLink) {
  openLink.setAttribute('role', 'button');
  openLink.setAttribute('aria-expanded', 'false');
  closeLink.setAttribute('role', 'button');
  openLink.addEventListener('click', (e) => {
    e.preventDefault();
    setDrawer(true);
  });
  closeLink.addEventListener('click', (e) => {
    e.preventDefault();
    setDrawer(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nav.classList.contains('is-open')) setDrawer(false);
  });
  // A tap on the dimmed page beside the drawer closes it; a link inside it navigates as usual.
  document.addEventListener('click', (e) => {
    const target = e.target as Node;
    if (nav.classList.contains('is-open') && !nav.contains(target) && !openLink.contains(target)) setDrawer(false, false);
  });
  nav.addEventListener('click', (e) => {
    if ((e.target as Element).closest('a[href*="#"]') && nav.classList.contains('is-open')) setDrawer(false, false);
  });
  // Opened without JavaScript's help (a #docs-nav link): drop the :target state.
  if (location.hash === '#docs-nav') history.replaceState(null, '', location.pathname + location.search);
}

// ---------- "On this page": the section being read, and how far along ----------

const tocLinks = [...document.querySelectorAll<HTMLAnchorElement>('.docs-toc a[data-toc]')];
const headings = tocLinks
  .map((a) => document.getElementById(a.dataset.toc ?? ''))
  .filter((h): h is HTMLElement => h !== null);
const progress = document.querySelector<HTMLElement>('.toc__progress span');

function onScroll(): void {
  // The current section is the last heading above a line a third down the screen.
  const line = window.innerHeight / 3;
  let current = headings[0];
  for (const h of headings) {
    if (h.getBoundingClientRect().top <= line) current = h;
    else break;
  }
  for (const a of tocLinks) {
    const on = a.dataset.toc === current?.id;
    a.classList.toggle('is-current', on);
    if (on) a.setAttribute('aria-current', 'location');
    else a.removeAttribute('aria-current');
  }
  if (progress) {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    progress.style.transform = `scaleX(${max > 0 ? Math.min(1, window.scrollY / max) : 1})`;
  }
}

if (headings.length > 0) {
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      onScroll();
    });
  };
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  onScroll();
}

// ---------- live examples ----------

const figures = [...document.querySelectorAll<HTMLElement>('figure[data-live]')];
if (figures.length > 0) {
  const load = () => import('./liveIsland');
  const mount = (figure: HTMLElement) =>
    load()
      .then(({ mountLiveExample }) => mountLiveExample(figure, siteRoot))
      .catch((error) => console.error('Live example failed:', error));
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          void mount(entry.target as HTMLElement);
        }
      },
      { rootMargin: '400px 0px' },
    );
    figures.forEach((f) => observer.observe(f));
  } else figures.forEach((f) => void mount(f));
}
