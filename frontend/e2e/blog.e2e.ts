import { expect, test } from './fixtures';

test.describe('blog', () => {
  test('the footer leads to the blog, and a post has its picture, a live example and the feed', async ({ page }) => {
    await page.goto('./');
    await page.getByRole('contentinfo').getByRole('link', { name: 'Blog' }).click();
    await expect(page).toHaveURL(/\/proschi\/blog\/$/);
    await expect(page).toHaveTitle('Proschi blog');
    await expect(page.locator('link[rel="alternate"][type="application/rss+xml"]')).toHaveAttribute('href', './rss.xml');

    await page.getByRole('link', { name: 'Proschi diagrams in the Claude Code terminal' }).first().click();
    await expect(page).toHaveURL(/\/proschi\/blog\/terminal-diagrams\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Proschi diagrams in the Claude Code terminal');
    await expect(page.getByRole('navigation', { name: 'Blog' }).getByRole('link', { name: /Claude Code terminal/ })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('link[rel="alternate"][type="application/rss+xml"]')).toHaveAttribute('href', '../rss.xml');

    // The picture next to the post loads.
    const img = page.locator('.doc-body img').first();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(0);

    // The live example draws its diagram.
    const example = page.locator('figure[data-live]').first();
    await example.scrollIntoViewIfNeeded();
    await expect.poll(() => example.locator('.react-flow__node').count()).toBe(4);

    // A link into the docs lands on the docs page and its section.
    await page.getByRole('link', { name: 'Diagrams in the terminal' }).click();
    await expect(page).toHaveURL(/\/proschi\/docs\/agents\/#diagrams-in-the-terminal$/);
  });

  test("the header's Blog link leads to the blog and is marked current on every blog page", async ({ page }) => {
    await page.goto('docs/');
    const main = page.getByRole('navigation', { name: 'Main' });
    await main.getByRole('link', { name: 'Blog' }).click();
    await expect(page).toHaveURL(/\/proschi\/blog\/$/);
    await expect(main.getByRole('link', { name: 'Blog' })).toHaveAttribute('aria-current', 'page');
    await expect(main.getByRole('link', { name: 'Docs' })).not.toHaveAttribute('aria-current', 'page');
    await page.goto('blog/terminal-diagrams/');
    await expect(main.getByRole('link', { name: 'Blog' })).toHaveAttribute('aria-current', 'page');
  });

  test('serves the RSS feed with absolute links', async ({ page, request }) => {
    const res = await request.get('blog/rss.xml');
    expect(res.ok()).toBe(true);
    const xml = await res.text();
    await page.goto('blog/');
    const items = await page.evaluate((text) => {
      const doc = new DOMParser().parseFromString(text, 'text/xml');
      if (doc.getElementsByTagName('parsererror').length) return null;
      return Array.from(doc.querySelectorAll('item')).map((i) => i.querySelector('link')?.textContent);
    }, xml);
    expect(items).toContain('https://proschi.app/blog/terminal-diagrams/');
  });

  test('reads without JavaScript on a phone, with a menu drawer and nothing overflowing', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, reducedMotion: 'reduce', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.goto('blog/terminal-diagrams/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Blog' });
    await expect(nav).toBeHidden();
    await page.getByRole('link', { name: 'Blog menu' }).click();
    await expect(nav).toBeVisible();
    await nav.getByRole('link', { name: 'All posts' }).click();
    await expect(page).toHaveURL(/\/blog\/$/);
    for (const path of ['blog/', 'blog/terminal-diagrams/']) {
      await page.goto(path);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    }
    await context.close();
  });
});
