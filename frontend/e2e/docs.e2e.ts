import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { canvasNodes, expect, test } from './fixtures';

/** The built docs pages, dist/docs/**\/index.html, as URLs. */
const DIST = new URL('../dist/', import.meta.url);
const builtDocs = (readdirSync(new URL('docs/', DIST), { recursive: true, encoding: 'utf8' }) as string[])
  .filter((f) => f === 'index.html' || f.endsWith('/index.html'))
  .map((f) => new URL(`docs/${f}`, DIST));

test('every internal link and #anchor in the built docs resolves', () => {
  const ids = new Map<string, Set<string>>();
  const idsOf = (file: URL): Set<string> => {
    if (!ids.has(file.href)) ids.set(file.href, new Set([...readFileSync(file, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
    return ids.get(file.href)!;
  };
  const broken: string[] = [];
  for (const page of builtDocs) {
    const html = readFileSync(page, 'utf8');
    for (const [, raw] of html.matchAll(/\shref="([^"]+)"/g)) {
      const href = raw.replace(/&amp;/g, '&');
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) continue;
      const url = new URL(href, page);
      if (!url.href.startsWith(DIST.href)) continue;
      let file = new URL(url.pathname, url);
      if (existsSync(file) && statSync(file).isDirectory()) file = new URL('index.html', file.href.endsWith('/') ? file : `${file.href}/`);
      const at = page.href.slice(DIST.href.length);
      if (!existsSync(file)) broken.push(`${at}: ${href}`);
      // #/review and the like are the practice app's routes, not anchors.
      else if (url.hash && !url.hash.startsWith('#/') && file.pathname.endsWith('.html') && !idsOf(file).has(decodeURIComponent(url.hash.slice(1)))) broken.push(`${at}: ${href}`);
    }
  }
  expect(builtDocs.length).toBeGreaterThan(20);
  expect(broken).toEqual([]);
});

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Docs' });

test.describe('docs', () => {
  test('the header leads to the docs, and the sidebar and pager move between pages', async ({ page }) => {
    await page.goto('./');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Docs' }).click();
    await expect(page).toHaveURL(/\/proschi\/docs\/$/);
    await expect(page).toHaveTitle('Proschi: architecture diagrams as code');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Docs' })).toHaveAttribute('aria-current', 'page');

    await sidebar(page).getByRole('link', { name: 'Quickstart' }).click();
    await expect(page).toHaveURL(/\/proschi\/docs\/quickstart\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/first diagram in 2 minutes/);
    await expect(sidebar(page).getByRole('link', { name: 'Quickstart' })).toHaveAttribute('aria-current', 'page');

    // "On this page" follows the headings.
    const toc = page.getByRole('navigation', { name: 'On this page' });
    await toc.getByRole('link', { name: 'Break it on purpose' }).click();
    await expect(page).toHaveURL(/#3-break-it-on-purpose$/);
    await expect(page.getByRole('heading', { level: 2, name: /Break it on purpose/ })).toBeInViewport();
    await expect(toc.getByRole('link', { name: 'Break it on purpose' })).toHaveAttribute('aria-current', 'location');

    // A link inside the Markdown (LANGUAGE.md) lands on the site's page, at its anchor.
    await page.getByRole('link', { name: 'language reference', exact: true }).click();
    await expect(page).toHaveURL(/\/proschi\/docs\/language\/$/);
    await sidebar(page).getByRole('link', { name: 'Scenarios' }).click();
    await expect(page).toHaveURL(/\/docs\/scenarios\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^Scenarios/);

    await page.getByRole('navigation', { name: 'Previous and next page' }).getByRole('link', { name: /Next/ }).click();
    await expect(page).toHaveURL(/\/proschi\/docs\/imports\/$/);
  });

  test('a live example draws its diagram and plays a scenario', async ({ page }) => {
    await page.goto('docs/quickstart/');
    const example = page.locator('figure[data-live]').nth(2);
    await example.scrollIntoViewIfNeeded();
    await expect.poll(() => example.locator('.react-flow__node').count()).toBe(3);

    // Pick the failure scenario and play it.
    await example.getByRole('combobox').selectOption({ label: 'Place order › DB down' });
    await example.getByRole('button', { name: 'Play' }).click();
    const stage = example.getByRole('region', { name: /playing Place order › DB down/ });
    await expect(stage).toBeVisible();
    await expect(stage.getByText(/Step 1 of \d+/)).toBeVisible();
    await expect(stage.locator('.react-flow__minimap')).toBeHidden();
    await expect(stage.getByText(/Step 2 of \d+/)).toBeVisible({ timeout: 5_000 });
    await expect(stage.getByText('Failed', { exact: true })).toBeVisible({ timeout: 8_000 });

    // The editor gets the code, and the scenario, in the link.
    const open = example.getByRole('link', { name: 'Open in editor' });
    await expect(open).toHaveAttribute('href', /^\.\.\/\.\.\/app\/#code=.+&uc=place-order&alt=db-down&step=1$/);
    await open.click();
    await expect(page).toHaveURL(/\/proschi\/app\/#code=/);
    await expect(canvasNodes(page).first()).toBeVisible();
  });

  test('reads without JavaScript: highlighted code and a sidebar drawer on phones', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, reducedMotion: 'reduce', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.goto('docs/quickstart/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('figure[data-live] .tok-tech').first()).toHaveText('[REST API]');
    await expect(page.locator('figure[data-live] .react-flow')).toHaveCount(0);

    await expect(sidebar(page)).toBeHidden();
    await page.getByRole('link', { name: 'Docs menu' }).click();
    await expect(sidebar(page)).toBeVisible();
    await sidebar(page).getByRole('link', { name: 'Privacy' }).click();
    await expect(page).toHaveURL(/\/docs\/privacy\/$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await context.close();
  });

  test('the drawer opens, closes on Escape and nothing overflows on a phone', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    for (const path of ['docs/', 'docs/language/', 'docs/model/']) {
      await page.goto(path);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
    const open = page.getByRole('button', { name: 'Docs menu', exact: true });
    await open.click();
    await expect(open).toHaveAttribute('aria-expanded', 'true');
    await expect(sidebar(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sidebar(page)).toBeHidden();
    await expect(open).toBeFocused();
    await context.close();
  });
});
