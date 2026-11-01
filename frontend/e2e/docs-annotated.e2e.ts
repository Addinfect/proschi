import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

/** The start page's annotated example: hover, keyboard and touch light up what a line draws. */

const example = (page: Page) => page.locator('figure[data-annotated]');
const marked = (page: Page) => example(page).locator('.line.is-annotated');
const note = (page: Page) => example(page).locator('.annotated__note');
const lit = (figure: Locator) => figure.locator('.react-flow__node.doc-lit, .react-flow__edge.doc-lit');

async function open(page: Page) {
  await page.goto('docs/');
  await example(page).scrollIntoViewIfNeeded();
  await expect.poll(() => example(page).locator('.react-flow__node').count()).toBe(4);
}

test.describe('annotated examples', () => {
  test('hovering a marked line shows its note and lights its box or arrow', async ({ page }) => {
    await open(page);
    await expect(note(page)).toHaveAttribute('aria-live', 'polite');
    await expect(note(page)).toContainText('Hover, tap or tab');

    await marked(page).nth(2).hover(); // api "Links API" … x3
    await expect(note(page)).toContainText('runs three replicas');
    await expect(example(page).locator('.react-flow__node.doc-lit')).toHaveCount(1);
    await expect(example(page).locator('.react-flow__node.doc-lit')).toContainText('Links API');
    await expect(example(page).locator('.react-flow__node.doc-dim')).toHaveCount(3);

    await marked(page).nth(5).hover(); // user -> api : HTTPS
    await expect(note(page)).toContainText('A connection draws an arrow');
    await expect(example(page).locator('.react-flow__edge.doc-lit')).toHaveCount(1);
    await expect(example(page).locator('.react-flow__node.doc-lit')).toHaveCount(0);

    await marked(page).nth(13).hover(); // traffic: lights nothing
    await expect(note(page)).toContainText('requests per second');
    await expect(lit(example(page))).toHaveCount(0);
    await expect(example(page).locator('.doc-dim')).toHaveCount(0);
  });

  test('the keyboard moves between marked lines with the arrow keys', async ({ page }) => {
    await open(page);
    await expect(marked(page).first()).toHaveAttribute('tabindex', '0');
    await expect(marked(page).nth(1)).toHaveAttribute('tabindex', '-1');
    await marked(page).first().focus();
    await expect(note(page)).toContainText("The diagram's name");
    await expect(lit(example(page))).toHaveCount(0);

    await page.keyboard.press('ArrowDown');
    await expect(note(page)).toContainText('A node: an id');
    await expect(example(page).locator('.react-flow__node.doc-lit')).toContainText('Reader');

    await page.keyboard.press('ArrowDown');
    await expect(marked(page).nth(2)).toBeFocused();
    await expect(marked(page).nth(2)).toHaveClass(/is-active/);
    await expect(example(page).locator('.react-flow__node.doc-lit')).toContainText('Links API');

    await page.keyboard.press('End');
    await expect(marked(page).last()).toBeFocused();
    await expect(note(page)).toContainText('A requirement');
    await page.keyboard.press('Escape');
    await expect(note(page)).toContainText('Hover, tap or tab');
    await expect(lit(example(page))).toHaveCount(0);
  });

  test('a tap on a phone shows the note and lights the box, and a second tap hides it', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await open(page);
    await marked(page).nth(3).tap(); // cache
    await expect(note(page)).toContainText('makes this a cache');
    await expect(example(page).locator('.react-flow__node.doc-lit')).toContainText('Link cache');
    // The note and the diagram are docked on screen next to the tapped line.
    await expect(note(page)).toBeInViewport();
    await expect(example(page).locator('.react-flow__node.doc-lit')).toBeInViewport();

    await marked(page).nth(3).tap();
    await expect(note(page)).toContainText('Hover, tap or tab');
    await expect(lit(example(page))).toHaveCount(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await context.close();
  });

  test('on a short phone screen every tapped line keeps what it lights on screen', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 667 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await open(page);
    const count = await marked(page).count();
    for (let i = 0; i < count; i++) {
      const line = marked(page).nth(i);
      // Read like a reader: the line just under the sticky header, the docked diagram below it.
      await line.evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().top - 150));
      await line.tap(); // fails if the dock covers the line
      await expect(line).toHaveClass(/is-active/);
      await expect(note(page)).toBeInViewport();
      for (const shown of await lit(example(page)).all()) await expect(shown).toBeInViewport({ ratio: 0.99 });
      await line.tap();
      await expect(line).not.toHaveClass(/is-active/);
    }
    await context.close();
  });

  test('Play works as in other live examples', async ({ page }) => {
    await open(page);
    await example(page).getByRole('button', { name: 'Play' }).click();
    const stage = example(page).getByRole('region', { name: /playing Open a link/ });
    await expect(stage.getByText(/Step 1 of \d+/)).toBeVisible();
  });

  test('without JavaScript the notes are a list under the code', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto('docs/');
    const notes = page.getByRole('list', { name: 'Notes on the example' });
    await expect(notes).toBeVisible();
    await expect(notes.getByRole('listitem')).toHaveCount(15);
    await expect(notes.getByRole('listitem').nth(2)).toContainText('api "Links API" [REST API] x3');
    await expect(notes.getByRole('listitem').nth(2)).toContainText('runs three replicas of the API');
    await expect(example(page).locator('pre')).not.toContainText('@note');
    await context.close();
  });
});

test.describe('anchor redirects', () => {
  test('an old anchor of the start page goes to its new page', async ({ page }) => {
    await page.goto('docs/#why-text');
    await expect(page).toHaveURL(/\/proschi\/docs\/why\/#why-text$/);
  });

  test('a page follows the redirects it carries, and keeps anchors it still has', async ({ page }) => {
    // A fixture map, put on the quickstart page as the build would.
    await page.route('**/docs/quickstart/', async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace('<div class="docs" ', `<div class="docs" data-anchor-redirects="{&quot;old-anchor&quot;:&quot;model/#quirks&quot;}" `);
      await route.fulfill({ response, body });
    });
    await page.goto('docs/quickstart/#3-break-it-on-purpose');
    await expect(page).toHaveURL(/\/docs\/quickstart\/#3-break-it-on-purpose$/);
    await page.goto('docs/quickstart/#old-anchor');
    await expect(page).toHaveURL(/\/proschi\/docs\/model\/#quirks$/);
  });
});
