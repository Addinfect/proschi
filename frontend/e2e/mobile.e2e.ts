import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { mockProfile, PROFILE } from './profile';

/**
 * Every page at phone width: nothing may stick out past the right edge, which
 * on a phone means the whole page pans sideways. Wide content (code, tables,
 * the editor's tab strips) scrolls inside its own box instead. A failure names
 * the elements that stick out.
 */

const DIST = new URL('../dist/', import.meta.url);

/** The docs pages, from docs/site.json (plugins/docsSite.ts writes each to docs/<slug>/index.html). */
const DOCS_PAGES = (JSON.parse(readFileSync(new URL('../../docs/site.json', import.meta.url), 'utf8')) as { pages: { slug: string }[] }).pages.map((p) => `docs/${p.slug ? `${p.slug}/` : ''}`);

/** The elements whose box crosses the viewport's edges, unless an ancestor inside the viewport clips or scrolls them. */
function offenders(): string[] {
  const vw = document.documentElement.clientWidth;
  const clippedInside = (el: Element) => {
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      if (!/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowX)) continue;
      const r = p.getBoundingClientRect();
      if (r.left >= -0.5 && r.right <= vw + 0.5) return true;
    }
    return false;
  };
  const describe = (el: Element) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}` : '';
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return `${el.tagName.toLowerCase()}${id}${cls} "${text}"`;
  };
  const out: string[] = [];
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 1) continue;
    if ((r.right > vw + 0.5 || r.left < -0.5) && !clippedInside(el)) out.push(`${describe(el)} spans ${Math.round(r.left)}..${Math.round(r.right)}px`);
  }
  return out;
}

async function expectNoHorizontalOverflow(page: Page, where: string): Promise<void> {
  const { scrollWidth, width } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, width: document.documentElement.clientWidth }));
  if (scrollWidth <= width) return;
  const culprits = await page.evaluate(offenders);
  expect(scrollWidth, `${where}: the page is ${scrollWidth}px wide in a ${width}px viewport. Sticking out:\n${culprits.slice(0, 10).join('\n')}`).toBeLessThanOrEqual(width);
}

/** Opens `path`, waits for it to settle, and checks it. */
async function visit(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  await expectNoHorizontalOverflow(page, path);
}

/** Clicks every visible tab in turn (new tab strips may appear on the way) and checks the page after each. */
async function eachTab(page: Page, path: string): Promise<void> {
  const tabs = page.getByRole('tab').filter({ visible: true });
  for (let i = 0; i < Math.min(await tabs.count(), 12); i++) {
    const tab = tabs.nth(i);
    const name = (await tab.innerText()).trim();
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expectNoHorizontalOverflow(page, `${path}, tab ${name}`);
  }
}

test.describe('no sideways scrolling on a phone', () => {
  test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });

  test('landing page, with the header menu open', async ({ page }) => {
    await visit(page, './');
    const menu = page.locator('.ps-header details.ps-menu');
    await menu.locator('summary').click();
    const links = menu.getByRole('link');
    await expect(links.filter({ hasText: 'Practice' })).toBeVisible();
    await expect(links.filter({ hasText: 'Blog' })).toBeVisible();
    // Tap targets in the menu are at least 44px tall.
    for (const box of await links.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) expect(box).toBeGreaterThanOrEqual(44);
    await expectNoHorizontalOverflow(page, './ with the menu open');
  });

  test('editor, every tab', async ({ page }) => {
    await visit(page, 'app/');
    await eachTab(page, 'app/');
  });

  test('editor with an example loaded, every tab', async ({ page }) => {
    await page.goto('./');
    const href = await page.locator('a[data-example]').first().getAttribute('href');
    await visit(page, href!);
    await eachTab(page, 'app/ (example)');
  });

  test('practice list and roadmap', async ({ page }) => {
    await visit(page, 'practice/');
    await visit(page, 'practice/#/roadmap');
  });

  test('daily review: the home, a topic and every card type, answered', async ({ page }) => {
    await visit(page, 'practice/#/review/caching');
    await visit(page, 'practice/#/review');
    await page.getByRole('button', { name: /^Start review/ }).click();
    const seen = new Set<string>();
    for (let n = 1; seen.size < 4 && n <= 10; n++) {
      const card = page.getByRole('article', { name: new RegExp(`^Card ${n} of`) });
      const type = (await card.getAttribute('data-card-type'))!;
      await expectNoHorizontalOverflow(page, `review, ${type} card`);
      if (type === 'estimate') {
        await card.getByLabel('Your estimate').fill('1k');
        await card.getByRole('button', { name: 'Check' }).click();
      } else if (type === 'choice') await card.getByRole('listitem').first().getByRole('button').click();
      else await card.getByRole('button', { name: 'Show answer' }).click();
      await expectNoHorizontalOverflow(page, `review, ${type} card answered`);
      // Tap targets for rating and going on are at least 44px tall.
      const next = type === 'flip' ? card.getByRole('button', { name: /^Good/ }) : card.getByRole('button', { name: 'Next' });
      expect((await next.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await next.click();
      seen.add(type);
    }
    expect(seen).toEqual(new Set(['flip', 'choice', 'estimate', 'cloze']));
  });

  test('daily streak: the review home with the recap, a session summary and a solve celebration', async ({ page }) => {
    // Two weeks of reviews, so the streak holds freezes and last week has a recap.
    await page.addInitScript(() => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      const reviews = Array.from({ length: 14 }, (_, i) => {
        const at = Date.now() - (i + 1) * 86_400_000;
        return Array.from({ length: 10 }, (_, j) => ({
          id: `seed-${i}-${j}`,
          cardId: `seed-card-${j}`,
          version: 1,
          rating: 3,
          reviewedAt: Math.floor(at / 1000) + j,
          durationMs: 1000,
          day: new Date(at).toISOString().slice(0, 10),
        }));
      }).flat();
      localStorage.setItem('proschi.cards', JSON.stringify(reviews));
    });
    await visit(page, 'practice/#/roadmap');
    await expect(page.getByRole('group', { name: 'Daily streak' })).toContainText('14-day streak');
    await visit(page, 'practice/#/review');
    await expect(page.getByRole('region', { name: 'Your week in review' })).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Daily goal' })).toBeVisible();
    await expectNoHorizontalOverflow(page, 'review home with the streak and the recap');

    await page.getByRole('button', { name: /^Start review/ }).click();
    // The first new card is an estimate (e2e/review.e2e.ts).
    const card = page.getByRole('article', { name: /^Card 1 of/ });
    await card.getByLabel('Your estimate').fill('2.3k');
    await card.getByRole('button', { name: 'Check' }).click();
    await card.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'End session' }).click();
    await expect(page.getByRole('region', { name: 'Session summary' })).toBeVisible();
    await expectNoHorizontalOverflow(page, 'session summary');

    await visit(page, 'practice/#/url-shortener');
    page.on('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Show reference solution' }).click();
    await page.getByRole('button', { name: 'Load into the editor' }).click();
    await page.getByRole('tab', { name: 'Tests' }).click();
    await page.getByRole('button', { name: 'Run tests' }).click();
    await expect(page.getByRole('region', { name: 'First solve' })).toBeVisible();
    await expectNoHorizontalOverflow(page, 'solve celebration');
  });

  test('progress page: skill map, badges and the new-badge toast', async ({ page }) => {
    await visit(page, 'practice/#/progress');
    // Earn a badge: one card reviewed, then the session ended.
    await visit(page, 'practice/#/review');
    await page.getByRole('button', { name: /^Start review/ }).click();
    const card = page.getByRole('article', { name: /^Card 1 of/ });
    await card.getByLabel('Your estimate').fill('2.3k');
    await card.getByRole('button', { name: 'Check' }).click();
    await card.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'End session' }).click();
    await expect(page.getByRole('status', { name: 'New badge' })).toBeVisible();
    await expectNoHorizontalOverflow(page, 'review with the new-badge toast');
    await visit(page, 'practice/#/progress');
    await expect(page.locator('[data-achievement="first-card"]')).toHaveAttribute('data-earned', 'true');
    await expectNoHorizontalOverflow(page, 'progress with a badge earned');
  });

  test('practice hub: every tab, the Today panel or the streak on top', async ({ page }) => {
    for (const path of ['practice/', 'practice/#/roadmap', 'practice/#/review', 'practice/#/challenge', 'practice/#/arcade', 'practice/#/progress', 'practice/#/roadmap/approach']) {
      await visit(page, path);
      await expect(page.getByRole('navigation', { name: 'Practice sections' })).toBeVisible();
    }
  });

  test('practice hub on the narrowest phone: every section shows at once, the page does not scroll sideways', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    for (const path of ['practice/', 'practice/#/progress']) {
      await visit(page, path);
      const bar = page.getByRole('navigation', { name: 'Practice sections' });
      await expect(bar).toBeVisible();
      // A grid of three by two, all in view without scrolling.
      for (const name of ['Problems', 'Roadmap', 'Review', 'Challenge', 'Arcade', 'Progress']) {
        await expect(bar.getByRole('link', { name, exact: true })).toBeInViewport({ ratio: 1 });
      }
      await expectNoHorizontalOverflow(page, `${path} at 320px`);
    }
  });

  test('settings, progress and a public profile, with a badge open', async ({ page }) => {
    await visit(page, 'practice/#/me');
    await visit(page, 'practice/#/progress');
    await page.getByText(/^All \d+ badges$/).click();
    await page.locator('[data-achievement="reviews-100"]').getByRole('button').click();
    await expectNoHorizontalOverflow(page, '#/progress with a badge open');
    await mockProfile(page);
    await visit(page, `practice/#/u/${PROFILE.id}`);
    await expect(page.getByRole('note')).toContainText('This is a public profile');
    await page.locator('[data-achievement="first-solve"]').getByRole('button').click();
    await expectNoHorizontalOverflow(page, '#/u/<id> with a badge open');
  });

  test('a problem, every tab', async ({ page }) => {
    await visit(page, 'practice/#/url-shortener');
    await eachTab(page, 'practice/#/url-shortener');
  });

  test('a static problem page', async ({ page }) => {
    await visit(page, 'practice/url-shortener/');
  });

  for (const path of DOCS_PAGES) {
    test(`docs page ${path}`, async ({ page }) => {
      await visit(page, path);
    });
  }

  test('404 page', async ({ page, baseURL }) => {
    // The server answers any missing path with 404.html, whose <base href="/"> points at the site root;
    // under the preview's sub-path, root requests are sent to the build.
    // Served with 200 here: the 404 status would only log a console error; the layout is what is checked.
    const basePath = new URL(baseURL!).pathname;
    await page.route(
      (url) => url.pathname === `${basePath}no-such-page/`,
      (route) => route.fulfill({ contentType: 'text/html', body: readFileSync(new URL('404.html', DIST), 'utf8') }),
    );
    await page.route(
      (url) => !url.pathname.startsWith(basePath),
      async (route) => {
        const url = new URL(route.request().url());
        url.pathname = basePath + url.pathname.slice(1);
        await route.fulfill({ response: await route.fetch({ url: url.href }) });
      },
    );
    await visit(page, 'no-such-page/');
    await expect(page.getByRole('heading', { level: 1, name: 'This page does not exist.' })).toBeVisible();
  });
});

test.describe('on the narrowest phone (320px)', () => {
  test.use({ viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true });

  test('practice hub, the account page and a public profile', async ({ page }) => {
    for (const path of ['practice/', 'practice/#/roadmap', 'practice/#/review', 'practice/#/challenge', 'practice/#/progress', 'practice/#/me']) await visit(page, path);
    await mockProfile(page);
    await visit(page, `practice/#/u/${PROFILE.id}`);
  });
});

// The narrowest phones, and widths around the header's breakpoints (the
// editor button shows from 480px): the header row never gets wider than the
// screen. With the account menu as well: header.accounts.e2e.ts.
for (const width of [320, 400, 470]) {
  test.describe(`the header at ${width}px`, () => {
    test.use({ viewport: { width, height: 740 }, isMobile: true, hasTouch: true });

    test('fits on every kind of page', async ({ page }) => {
      for (const path of ['./', 'practice/', 'practice/#/review', 'practice/#/url-shortener', 'app/', 'docs/']) {
        await visit(page, path);
        // The editor has no site links, so no menu button: its last control is the theme toggle.
        const last = page.locator(path === 'app/' ? '.ps-header .ps-header__end > :last-child' : '.ps-header .ps-menu__button');
        const box = (await last.boundingBox())!;
        expect(box.x + box.width, `${path}: the header's last control is off screen`).toBeLessThanOrEqual(width);
      }
    });
  });
}

test.describe('a problem header at 500px', () => {
  test.use({ viewport: { width: 500, height: 800 }, isMobile: true, hasTouch: true });

  test('keeps its controls on one row, with Reset and Help under More', async ({ page }) => {
    await page.goto('practice/#/url-shortener');
    const header = page.locator('.ps-header');
    const title = (await header.getByRole('heading', { level: 1 }).boundingBox())!;
    const more = header.getByRole('button', { name: 'More' });
    const box = (await more.boundingBox())!;
    expect(Math.abs(box.y + box.height / 2 - (title.y + title.height / 2)), 'More sits on the title’s row').toBeLessThan(12);
    await expect(header.getByRole('button', { name: 'Help' })).toBeHidden();
    await more.click();
    await expect(page.getByRole('menuitem', { name: 'Reset to the starter code' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Take the practice tour' })).toBeVisible();
  });
});

test.describe('editor diagram on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  /** Opens the URL shortener example on the Diagram pane and selects its first component. */
  async function selectNode(page: Page): Promise<void> {
    await page.goto('./');
    await page.goto((await page.locator('a[data-example="url-shortener"]').getAttribute('href'))!);
    await page.getByRole('tab', { name: 'Diagram' }).first().click();
    await page.locator('.react-flow__node').first().click();
    await expect(page.getByRole('region', { name: /settings$/ })).toBeVisible();
  }

  /** True when two boxes share any area. */
  const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  test('delete sits in the settings card, and in a bar of its own once the card is closed', async ({ page }) => {
    await selectNode(page);
    const settings = page.getByRole('region', { name: /settings$/ });
    await expect(settings.getByRole('button', { name: /^Delete / })).toBeVisible();
    await expect(page.getByRole('toolbar', { name: 'Selection' })).toHaveCount(0);

    await settings.getByRole('button', { name: 'Close settings' }).click();
    const bar = page.getByRole('toolbar', { name: 'Selection' });
    await expect(bar.getByRole('button', { name: 'Rename' })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Delete' })).toBeVisible();
    const box = (await bar.boundingBox())!;
    for (const other of [page.getByRole('button', { name: 'Add component' }), page.locator('.react-flow__controls')]) {
      expect(overlap(box, (await other.boundingBox())!), `the selection bar overlaps ${await other.getAttribute('class')}`).toBe(false);
    }
  });

  test('a settings field stays above the on-screen keyboard', async ({ page }) => {
    // Chromium has no keyboard here; stand in for iOS Safari, whose visual viewport shrinks while the layout one does not.
    await page.addInitScript(() => {
      const fake = Object.assign(new EventTarget(), { height: 844, width: 390, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 });
      Object.defineProperty(window, 'visualViewport', { value: fake });
      (window as unknown as { showKeyboard: (px: number) => void }).showKeyboard = (px) => {
        fake.height = document.documentElement.clientHeight - px;
        fake.dispatchEvent(new Event('resize'));
      };
    });
    await selectNode(page);
    const settings = page.getByRole('region', { name: /settings$/ });
    const field = settings.locator('input, textarea').last();
    await field.focus();
    await page.evaluate(() => (window as unknown as { showKeyboard: (px: number) => void }).showKeyboard(400));
    const visible = 844 - 400;
    await expect.poll(async () => (await field.boundingBox())!.y + (await field.boundingBox())!.height).toBeLessThanOrEqual(visible);
    expect((await field.boundingBox())!.y).toBeGreaterThanOrEqual(0);
    await expect(page.locator('[data-keyboard]')).toHaveCount(1);
  });
});
