import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import landingHtml from '../../index.html?raw';
import appHtml from '../../app/index.html?raw';
import practiceHtml from '../../practice/index.html?raw';
import docsHtml from '../../docs/index.html?raw';
import themeInit from '../../public/theme-init.js?raw';
import tailwindConfig from '../../tailwind.config.js?raw';
import { renderShell } from './shell';
import { SPRINGS, springStep } from './motion';
import { THEME_COLOR, THEME_KEY, nextThemePref, resolveTheme, themeToggleLabel, type ThemePref } from './theme';

// Read from disk: vitest stubs CSS imports, ?raw included.
const tokensCss = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

const PAGES = { landing: landingHtml, app: appHtml, practice: practiceHtml, docs: docsHtml };

/** The custom properties a CSS block (by its selector's start) declares. */
function declared(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(selector);
  const block = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  return new Map([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const hex = (channels: string) => `#${channels.split(/\s+/).map((c) => Number(c).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

describe('tokens', () => {
  const light = declared(tokensCss, ':root,\n.ps-light');
  const dark = declared(tokensCss, ":root[data-theme='dark']");
  const darkMedia = declared(tokensCss, ":root:not([data-theme='light'])");

  it('defines every colour in both themes, the same in the attribute and the media query', () => {
    const colours = [...light.keys()].filter((k) => k.startsWith('--c-'));
    expect(colours.length).toBeGreaterThan(10);
    for (const name of colours) {
      if (name === '--c-on-accent') continue; // Dark text on accents in both themes.
      expect(dark.has(name), name).toBe(true);
    }
    expect(darkMedia).toEqual(dark);
  });

  it('gives Tailwind only colours that exist', () => {
    const names = [...tailwindConfig.matchAll(/token\('([\w-]+)'\)/g)].map((m) => `--c-${m[1]}`);
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) expect(light.has(name), name).toBe(true);
  });

  it('matches the theme colours the scripts set for the browser chrome', () => {
    expect(THEME_COLOR.light).toBe(hex(light.get('--c-paper')!));
    expect(THEME_COLOR.dark).toBe(hex(dark.get('--c-paper')!));
    expect(themeInit).toContain(`light: '${THEME_COLOR.light}', dark: '${THEME_COLOR.dark}'`);
    expect(themeInit).toContain(`'${THEME_KEY}'`);
  });
});

describe('theme', () => {
  it('resolves "system" to the system theme', () => {
    expect(resolveTheme('system', 'dark')).toBe('dark');
    expect(resolveTheme('light', 'dark')).toBe('light');
  });

  it('changes what you see on the first press, and comes back to the system after three', () => {
    for (const system of ['light', 'dark'] as const) {
      const seen: ThemePref[] = ['system'];
      for (let i = 0; i < 3; i++) seen.push(nextThemePref(seen[i], system));
      expect(resolveTheme(seen[1], system)).not.toBe(system);
      expect(new Set(seen.slice(0, 3)).size).toBe(3);
      expect(seen[3]).toBe('system');
    }
  });

  it('labels the toggle with the current choice and the next one', () => {
    expect(themeToggleLabel('system', 'light')).toBe('Theme: Match system. Switch to dark');
    expect(themeToggleLabel('dark', 'light')).toBe('Theme: Dark. Switch to light');
  });
});

describe('pages', () => {
  it.each(Object.entries(PAGES))('%s loads fonts from the site only and sets the theme before paint', (_, html) => {
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(html).toMatch(/font-src 'self'[ ;]/);
    expect(html).toMatch(/<script src="\.\.?\/theme-init\.js"><\/script>/);
    expect(html).toContain('<meta name="color-scheme" content="light dark" />');
    // Before any stylesheet or module script.
    expect(html.indexOf('theme-init.js')).toBeLessThan(html.indexOf('type="module"'));
  });

  it.each([
    ['landing', landingHtml],
    ['docs', docsHtml],
  ])('%s gets the shared header and footer', (_, html) => {
    expect(html).toContain('<!--shell:header-->');
    expect(html).toContain('<!--shell:footer-->');
  });
});

describe('shell', () => {
  const header = renderShell('header', { base: '../', current: 'practice' });
  const footer = renderShell('footer', { base: './' });

  it('links relative to the page', () => {
    expect(header).toContain('href="../practice/"');
    expect(header).toContain('href="../app/"');
    expect(header).toMatch(/class="ps-wordmark" href="\.\.\/"/);
    expect(footer).toContain('href="./docs/model/"');
    expect(footer).toContain('https://github.com/gvart/proschi');
  });

  it('marks the current page', () => {
    expect(header.match(/aria-current="page"/g)).toHaveLength(2); // The bar and the phone menu.
    expect(header).toMatch(/href="\.\.\/practice\/" aria-current="page"/);
  });

  it('links to the blog in the bar and the phone menu, current on the blog', () => {
    expect(header.match(/href="\.\.\/blog\/"/g)).toHaveLength(2);
    const blog = renderShell('header', { base: '../', current: 'blog' });
    expect(blog.match(/href="\.\.\/blog\/" aria-current="page"/g)).toHaveLength(2);
  });

  it('has the hooks enhance.ts and the view transitions need', () => {
    expect(header).toContain('class="ps-header"');
    expect(header.match(/data-theme-toggle=""/g)).toHaveLength(1);
    // Not magnetic: pulled toward the pointer, it slid over the theme toggle beside it.
    expect(header).not.toContain('data-magnetic');
    expect(header).toMatch(/<details class="ps-menu"><summary class="ps-iconbtn ps-menu__button" aria-label="Menu">/);
  });

  it('has an empty account slot for enhance.ts to fill', () => {
    expect(header).toContain('<div data-account="" data-base="../" hidden="">');
  });

  it('has no inline styles, which the static pages’ CSP blocks', () => {
    expect(header + footer).not.toMatch(/\sstyle="/);
  });
});

describe('springs', () => {
  it.each(Object.entries(SPRINGS))('%s settles on its target within a second', (_, config) => {
    let [x, v] = [0, 0];
    for (let t = 0; t < 1; t += 1 / 120) [x, v] = springStep(x, v, 1, config, 1 / 120);
    expect(x).toBeCloseTo(1, 1);
  });
});
