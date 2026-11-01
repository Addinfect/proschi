import type { Page } from '@playwright/test';
import { codeEditor, expect, test, waitForCanvas } from './fixtures';

/** Clicks a link that opens in a new tab and returns that tab once it has loaded. */
async function openInNewTab(page: Page, click: () => Promise<void>): Promise<Page> {
  const [tab] = await Promise.all([page.context().waitForEvent('page'), click()]);
  await tab.waitForLoadState();
  return tab;
}

const modelHeading = (page: Page) => page.getByRole('heading', { level: 1, name: /How the simulation works/ });

test.describe('simulation page', () => {
  test('explains the model and is linked from the landing page', async ({ page }) => {
    await page.goto('./');
    await page.getByRole('contentinfo').getByRole('link', { name: 'How the simulation works' }).click();
    await expect(page).toHaveURL(/\/proschi\/docs\/model\/$/);
    await expect(page).toHaveTitle(/How the simulation works/);
    await expect(modelHeading(page)).toBeVisible();

    // Sections, the profile table and a worked example with its computed numbers.
    for (const name of ['What is modelled', 'Worked examples', 'What is not modelled', 'How to read the results', 'Practice verdicts']) {
      await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
    }
    await expect(page.getByRole('region', { name: 'Default profiles' }).getByRole('row')).toHaveCount(19);
    await expect(page.getByText('p99 of Read feed is 38.6 ms (limit 60 ms)')).toBeVisible();
    // Snippets are highlighted.
    await expect(page.locator('pre[data-example="feed"] code span').first()).toBeAttached();

    await page.getByRole('navigation', { name: 'On this page' }).getByRole('link', { name: 'Practice verdicts' }).click();
    await expect(page).toHaveURL(/#practice$/);
    await page.getByRole('link', { name: 'Start practising' }).click();
    await expect(page).toHaveURL(/\/proschi\/practice\/$/);
  });

  test('its old address forwards to the docs, keeping the section', async ({ page }) => {
    await page.goto('model/#practice');
    await expect(page).toHaveURL(/\/proschi\/docs\/model\/#practice$/);
    await expect(page.getByRole('heading', { level: 2, name: 'Practice verdicts' })).toBeInViewport();
  });

  test('fits a phone screen', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.goto('docs/model/');
    await expect(modelHeading(page)).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await context.close();
  });

  test('"How is this calculated?" links from the editor and practice', async ({ page }) => {
    await page.goto('app/');
    await expect(codeEditor(page)).toBeVisible();
    await page.getByRole('button', { name: 'File' }).click();
    await page.getByRole('menuitem', { name: 'Examples…' }).click();
    await page.getByRole('dialog', { name: 'Examples' }).getByRole('button', { name: /URL shortener HLD/ }).click();
    const views = page.getByRole('tablist', { name: 'Diagram view' });

    await views.getByRole('tab', { name: /Results/ }).click();
    await expect(page.getByText(/^(All \d+ passing|\d+ of \d+ failing)$/)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Nodes' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'How is this calculated?' })).toHaveAttribute('href', '../docs/model/');
    const fromResults = await openInNewTab(page, () => page.getByRole('link', { name: 'How is this calculated?' }).click());
    await expect(fromResults).toHaveURL(/\/proschi\/docs\/model\/$/);
    await expect(modelHeading(fromResults)).toBeVisible();
    await fromResults.close();

    await page.goto('practice/#/url-shortener');
    await expect(codeEditor(page)).toBeVisible();
    await waitForCanvas(page);
    await page.getByRole('button', { name: 'Run tests' }).click();
    const fromPractice = await openInNewTab(page, () => page.getByRole('link', { name: 'How is this calculated?' }).click());
    await expect(fromPractice).toHaveURL(/\/proschi\/docs\/model\/#practice$/);
    await expect(fromPractice.getByRole('heading', { level: 2, name: 'Practice verdicts' })).toBeInViewport();
  });
});
