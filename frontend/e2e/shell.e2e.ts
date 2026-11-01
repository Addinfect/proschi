import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/** The site's own pages; the header is the same on each, the footer on those that have one. */
const PAGES = ['./', 'docs/', 'blog/', 'app/', 'practice/'];

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);
const toggle = (page: Page) => page.locator('.ps-header').getByRole('button', { name: /^Theme:/ });

test.describe('shared header and footer', () => {
  test('every page has the same header links, and the static pages and practice the same footer', async ({ page }) => {
    const footers: string[][] = [];
    for (const path of PAGES) {
      await page.goto(path);
      const nav = page.getByRole('navigation', { name: 'Main' });
      await expect(nav.getByRole('link')).toHaveText([/Docs/, 'Practice', 'Blog', /GitHub/]);
      await expect(page.getByRole('link', { name: 'Proschi home' }).first()).toBeVisible();
      await expect(toggle(page)).toBeVisible();
      const footer = page.getByRole('contentinfo');
      if (path !== 'app/') footers.push(await footer.getByRole('link').allTextContents());
      else await expect(footer).toHaveCount(0);
    }
    expect(footers).toHaveLength(4);
    expect(new Set(footers.map((f) => f.join('|'))).size).toBe(1);
    await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Contribute' })).toHaveAttribute(
      'href',
      'https://github.com/gvart/proschi/blob/main/CONTRIBUTING.md',
    );
  });

  test('the theme toggle persists across pages and reloads, and "system" follows the system', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('./');
    expect(await theme(page)).toBe('light');

    // First press: the opposite of the system theme.
    await toggle(page).click();
    expect(await theme(page)).toBe('dark');
    await expect(toggle(page)).toHaveAttribute('data-pref', 'dark');

    // Applied before any module script runs on the next page (no flash of the wrong theme).
    await page.goto('docs/', { waitUntil: 'commit' });
    await page.waitForFunction(() => document.documentElement.dataset.theme !== undefined);
    expect(await theme(page)).toBe('dark');
    await page.goto('app/');
    await expect(toggle(page)).toHaveAttribute('data-pref', 'dark');

    // Second press: light, then back to following the system.
    await toggle(page).click();
    expect(await theme(page)).toBe('light');
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute('data-pref', 'system');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => theme(page)).toBe('dark');
    await page.reload();
    expect(await theme(page)).toBe('dark');
  });
});

test.describe('shared header on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the links fold into a menu that closes on Escape', async ({ page }) => {
    await page.goto('./');
    const menu = page.locator('.ps-header details.ps-menu');
    await expect(page.locator('.ps-header .ps-nav')).toBeHidden();
    await menu.locator('summary').click();
    const links = menu.getByRole('navigation', { name: 'Main' }).getByRole('link');
    await expect(links).toHaveText([/Docs/, 'Practice', 'Blog', /GitHub/, 'Editor']);
    await page.keyboard.press('Escape');
    await expect(links.first()).toBeHidden();
    await expect(menu.locator('summary')).toBeFocused();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
