import type { Page } from '@playwright/test';
import { ONBOARDING_KEY, canvasNodes, codeEditor, expect, expectDiagramFitted, test, waitForCanvas } from './fixtures';

/** The first visit's document (the hello example) has three components. */
const FIRST_RUN_NODES = 3;

/** The tour popover (non-modal dialog), named after its tour and current step. */
const editorTour = (page: Page) => page.getByRole('dialog', { name: /^Quick tour:/ });
const practiceTour = (page: Page) => page.getByRole('dialog', { name: /^Practice tour:/ });

/** Clicks Next (or Finish) where it is right after each step shows: the popover must not move under the cursor. */
async function clickThrough(page: Page, tour: ReturnType<typeof editorTour>, titles: string[], label: string) {
  for (const [i, title] of titles.entries()) {
    await expect(tour).toHaveAccessibleName(`${label}: ${title}`);
    const box = (await tour.getByRole('button', { name: i === titles.length - 1 ? 'Finish' : 'Next', exact: true }).boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
  await expect(tour).toHaveCount(0);
}

async function seenFlags(page: Page): Promise<unknown> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), ONBOARDING_KEY);
}

test.describe('editor tour', () => {
  test.use({ onboarding: 'fresh' });

  test('shows on a first visit, and not again once seen', async ({ page }) => {
    await page.goto('app/');
    const tour = editorTour(page);
    await expect(tour).toBeVisible();
    await expect(tour).toHaveAccessibleName('Quick tour: Text in, diagram out');
    await expect(tour).toHaveAttribute('aria-modal', 'false');
    // Keyboard users land in it.
    await expect(tour).toBeFocused();
    // Nothing is blocked: the page underneath still works.
    await waitForCanvas(page, FIRST_RUN_NODES);
    await page.getByRole('tablist', { name: 'Diagram view' }).getByRole('tab', { name: 'HLD' }).click();
    await expect(page.getByRole('navigation', { name: 'HLD sections' })).toBeVisible();

    expect(await seenFlags(page)).toEqual({ editor: true });
    await page.reload();
    await waitForCanvas(page, 1);
    await expect(editorTour(page)).toHaveCount(0);
  });

  test('Next stays where it first shows on every step', async ({ page }) => {
    await page.goto('app/');
    await waitForCanvas(page, FIRST_RUN_NODES);
    const steps = ['Text in, diagram out', 'Change a line, watch the diagram', 'Play a use case', 'Will it scale?', 'Share and keep your work'];
    await clickThrough(page, editorTour(page), steps, 'Quick tour');
  });

  test('a done step stays done while the user is on it', async ({ page }) => {
    await page.goto('app/');
    await waitForCanvas(page, FIRST_RUN_NODES);
    const tour = editorTour(page);
    await tour.getByRole('button', { name: 'Next' }).click();
    await expect(tour).toHaveAccessibleName('Quick tour: Change a line, watch the diagram');
    const top = (await tour.boundingBox())!.y;
    await page.keyboard.type('Orders API');
    await expect(tour.getByText('The diagram followed your text.')).toBeVisible();
    expect((await tour.boundingBox())!.y).toBe(top);
    // It moves on by itself, never back to the task.
    await expect(tour).toHaveAccessibleName('Quick tour: Play a use case');
  });

  test('Escape and the X skip it; focus goes back', async ({ page }) => {
    await page.goto('app/');
    await expect(editorTour(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(editorTour(page)).toHaveCount(0);

    // Replaying from Help and closing with the X.
    await page.getByRole('button', { name: 'Help' }).click();
    await page.getByRole('menuitem', { name: 'Take the tour' }).click();
    await expect(editorTour(page)).toBeVisible();
    await editorTour(page).getByRole('button', { name: 'Close tour' }).click();
    await expect(editorTour(page)).toHaveCount(0);
  });

  test('interactive steps advance when the user does the thing', async ({ page }) => {
    await page.goto('app/');
    await waitForCanvas(page, FIRST_RUN_NODES);
    const tour = editorTour(page);
    await tour.getByRole('button', { name: 'Next' }).click();

    // Step 2 selects a node name in the editor; typing replaces it and the tour moves on by itself.
    await expect(tour).toHaveAccessibleName('Quick tour: Change a line, watch the diagram');
    await expect(codeEditor(page)).toBeFocused();
    await page.keyboard.type('Checkout API');
    await expect(canvasNodes(page).filter({ hasText: 'Checkout API' })).toBeVisible();
    await expect(tour.getByText('The diagram followed your text.')).toBeVisible();
    await expect(tour).toHaveAccessibleName('Quick tour: Play a use case');

    // Step 3 waits for Play, then for the way back.
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(tour).toHaveAccessibleName('Quick tour: Step through the flow');
    await page.getByRole('button', { name: 'Next step' }).click();
    await expect(page.getByText(/^Step 2 of \d+$/)).toBeVisible();
    await page.getByRole('button', { name: 'Back to diagram' }).click();
    await expect(tour).toHaveAccessibleName('Quick tour: Will it scale?');

    // Step 4 reacts to the Results tab, on the same document: the first-run design has traffic and requirements.
    await expect(tour.getByRole('button', { name: 'Open an example' })).toHaveCount(0);
    await page.getByRole('tablist', { name: 'Diagram view' }).getByRole('tab', { name: /Results/ }).click();
    await expect(tour.getByText('Every requirement becomes a check like these.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Diagrams' })).toContainText('Hello Proschi');
    await tour.getByRole('button', { name: 'Next' }).click();

    await expect(tour).toHaveAccessibleName('Quick tour: Share and keep your work');
    await expect(tour.getByRole('button', { name: 'Finish' })).toBeFocused();
    await tour.getByRole('button', { name: 'Finish' }).click();
    await expect(tour).toHaveCount(0);
  });

  test('"Show me" does the edit step', async ({ page }) => {
    await page.goto('app/');
    await waitForCanvas(page, FIRST_RUN_NODES);
    await editorTour(page).getByRole('button', { name: 'Next' }).click();
    await editorTour(page).getByRole('button', { name: 'Show me' }).click();
    await expect(canvasNodes(page).filter({ hasText: 'My Notes API' })).toBeVisible();
    await expect(editorTour(page)).toHaveAccessibleName('Quick tour: Play a use case');
  });

  test('a share link opens without the tour, with a small hint', async ({ page, context }) => {
    await page.goto('app/?tour=0');
    await waitForCanvas(page, FIRST_RUN_NODES);
    await expect(editorTour(page)).toHaveCount(0);
    await expect(page).toHaveURL(/#code=/);
    const link = page.url().replace('?tour=0', '');
    // Someone else's browser: no saved diagrams (those would mark a returning user).
    await expect.poll(() => page.evaluate(() => localStorage.getItem('proschi.docs'))).not.toBeNull();
    await page.evaluate(() => localStorage.clear());

    const other = await context.newPage();
    await other.goto(link);
    await waitForCanvas(other, FIRST_RUN_NODES);
    const hint = other.getByRole('complementary', { name: 'Tour' });
    await expect(hint).toBeVisible();
    await expect(editorTour(other)).toHaveCount(0);
    // The shared diagram stays in charge of the page: no focus stolen.
    await expect(hint.getByRole('button', { name: 'Take the 1-minute tour' })).not.toBeFocused();

    await hint.getByRole('button', { name: 'Dismiss tour hint' }).click();
    await expect(hint).toHaveCount(0);
    expect(await seenFlags(other)).toEqual({ editor: true });
  });

  test('the hint over a share link can start the tour', async ({ page, context }) => {
    await page.goto('app/?tour=0');
    await expect(page).toHaveURL(/#code=/);
    const link = page.url().replace('?tour=0', '');
    // Someone else's browser: no saved diagrams (those would mark a returning user).
    await expect.poll(() => page.evaluate(() => localStorage.getItem('proschi.docs'))).not.toBeNull();
    await page.evaluate(() => localStorage.clear());
    const other = await context.newPage();
    await other.goto(link);
    await other.getByRole('button', { name: 'Take the 1-minute tour' }).click();
    await expect(editorTour(other)).toBeVisible();
  });

  test('?tour=1 forces the tour, ?tour=0 suppresses it', async ({ page }) => {
    await page.goto('app/?tour=0');
    await waitForCanvas(page, FIRST_RUN_NODES);
    await expect(editorTour(page)).toHaveCount(0);
    await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({ editor: true })), ONBOARDING_KEY);
    await page.goto('app/?tour=1');
    await expect(editorTour(page)).toBeVisible();
  });

  test('works with storage blocked: shows once, nothing throws', async ({ page, context }) => {
    await context.addInitScript(() => {
      const deny = () => {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      };
      Object.defineProperty(window, 'localStorage', { get: deny, configurable: true });
      Object.defineProperty(window, 'sessionStorage', { get: deny, configurable: true });
    });
    await page.goto('app/');
    await expect(editorTour(page)).toBeVisible();
    await waitForCanvas(page, FIRST_RUN_NODES);
    await page.keyboard.press('Escape');
    await expect(editorTour(page)).toHaveCount(0);
    // A reload keeps the diagram in the address bar, which counts as a link: at most the hint.
    await page.reload();
    await waitForCanvas(page, FIRST_RUN_NODES);
    await expect(editorTour(page)).toHaveCount(0);
  });
});

test.describe('editor tour on a phone', () => {
  test.use({ onboarding: 'fresh', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('docks to the screen edge and switches panes', async ({ page }) => {
    await page.goto('app/');
    const tour = editorTour(page);
    await expect(tour).toBeVisible();
    const box = (await tour.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.y + box.height).toBeLessThanOrEqual(844);

    const panes = page.getByRole('tablist', { name: 'View', exact: true });
    await tour.getByRole('button', { name: 'Next' }).click();
    await expect(panes.getByRole('tab', { name: /Code/ })).toHaveAttribute('aria-selected', 'true');
    await expect(codeEditor(page)).toBeVisible();

    await tour.getByRole('button', { name: 'Show me' }).click();
    // The next step brings the diagram back, with the edit drawn.
    await expect(tour).toHaveAccessibleName('Quick tour: Play a use case');
    await expect(panes.getByRole('tab', { name: /Diagram/ })).toHaveAttribute('aria-selected', 'true');
    await expect(canvasNodes(page).filter({ hasText: 'My Notes API' })).toBeVisible();
    // The diagram is fitted into the part of the canvas the docked card leaves free.
    const card = (await tour.boundingBox())!;
    await expectDiagramFitted(page, card.y);
  });
});

test.describe('help menu', () => {
  test('the cheat-sheet opens next to the page and closes with Escape', async ({ page }) => {
    await page.goto('app/');
    await waitForCanvas(page, FIRST_RUN_NODES);
    await expect(editorTour(page)).toHaveCount(0); // the fixture marks tours as seen
    const help = page.getByRole('button', { name: 'Help' });
    await help.click();
    await expect(page.getByRole('menuitem', { name: 'How the simulation works' })).toHaveAttribute('href', '../docs/model/');
    await page.getByRole('menuitem', { name: 'Syntax cheat-sheet' }).click();
    const sheet = page.getByRole('dialog', { name: 'Syntax cheat-sheet' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Close cheat-sheet' })).toBeFocused();
    await expect(sheet.getByText('fire and forget')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(help).toBeFocused();
  });
});

test.describe('starter for a new diagram', () => {
  test('offers a template, examples and practice', async ({ page }) => {
    await page.goto('app/');
    await waitForCanvas(page, FIRST_RUN_NODES);
    await page.getByRole('button', { name: 'File' }).click();
    await page.getByRole('menuitem', { name: 'New diagram' }).click();
    const starter = page.getByRole('region', { name: 'Start a diagram' });
    await expect(starter).toBeVisible();
    await expect(starter.getByRole('link', { name: /Practice system design/ })).toHaveAttribute('href', '../practice/');

    await starter.getByRole('button', { name: /Template with a cheat-sheet/ }).click();
    await expect(page.getByRole('button', { name: 'Diagrams' })).toContainText('My system');
    await waitForCanvas(page, 3);
    await expect(page.getByText('No problems')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
  });

  test('an example picked from an empty diagram replaces it', async ({ page }) => {
    await page.goto('app/');
    await waitForCanvas(page, FIRST_RUN_NODES);
    await page.getByRole('button', { name: 'File' }).click();
    await page.getByRole('menuitem', { name: 'New diagram' }).click();
    await page.getByRole('region', { name: 'Start a diagram' }).getByRole('button', { name: /Start from an example/ }).click();
    await page.getByRole('dialog', { name: 'Examples' }).getByRole('button', { name: /Serverless/ }).click();
    const files = page.getByRole('complementary', { name: 'Diagrams' });
    await expect(files.getByText('Untitled')).toHaveCount(0);
    await expect(files.getByText('Hello Proschi')).toBeVisible();
  });
});

test.describe('practice tour', () => {
  test.use({ onboarding: 'fresh' });

  test('three steps on the first problem; Run tests advances it', async ({ page }) => {
    await page.goto('practice/#/url-shortener');
    const tour = practiceTour(page);
    await expect(tour).toHaveAccessibleName('Practice tour: Read the problem');
    await tour.getByRole('button', { name: 'Next' }).click();
    await expect(tour).toHaveAccessibleName('Practice tour: Edit the starter, run the tests');
    await page.getByRole('button', { name: 'Run tests' }).click();
    await expect(tour).toHaveAccessibleName('Practice tour: Budgets make brute force fail');
    await expect(tour.getByRole('link', { name: 'How the simulation works' })).toHaveAttribute('href', '../docs/model/');
    await tour.getByRole('button', { name: 'Finish' }).click();
    await expect(tour).toHaveCount(0);

    // Seen: another problem opens without it.
    await page.goto('practice/#/pastebin');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(practiceTour(page)).toHaveCount(0);
  });

  test('Next stays where it first shows on every step', async ({ page }) => {
    await page.goto('practice/#/url-shortener');
    const steps = ['Read the problem', 'Edit the starter, run the tests', 'Budgets make brute force fail'];
    await clickThrough(page, practiceTour(page), steps, 'Practice tour');
  });

  test.describe('on a problem whose lesson is unread', () => {
    test.use({ lessons: 'fresh' });

    test('waits for the lesson, then starts with the challenge', async ({ page }) => {
      await page.goto('practice/#/url-shortener');
      await expect(page.getByRole('article', { name: 'Lesson' })).toBeVisible();
      await expect(practiceTour(page)).toHaveCount(0);
      await page.getByRole('button', { name: 'Start the challenge' }).first().click();
      await expect(practiceTour(page)).toHaveAccessibleName('Practice tour: Read the problem');
    });
  });

  test('Help on the problem list replays it on the first problem', async ({ page }) => {
    await page.goto('practice/?tour=0');
    await page.getByRole('button', { name: 'Help' }).click();
    await page.getByRole('menuitem', { name: 'Take the practice tour' }).click();
    await expect(page).toHaveURL(/#\/[a-z0-9-]+$/);
    await expect(practiceTour(page)).toBeVisible();
  });
});

test.describe('practice tour on a phone', () => {
  test.use({ onboarding: 'fresh', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('walks the Problem, Code and Tests tabs', async ({ page }) => {
    await page.goto('practice/#/url-shortener');
    const tabs = page.getByRole('tablist', { name: 'View', exact: true });
    const tour = practiceTour(page);
    await expect(tour).toBeVisible();
    await expect(tabs.getByRole('tab', { name: 'Problem' })).toHaveAttribute('aria-selected', 'true');
    await tour.getByRole('button', { name: 'Next' }).click();
    await expect(tabs.getByRole('tab', { name: 'Code' })).toHaveAttribute('aria-selected', 'true');
    await tour.getByRole('button', { name: 'Run now' }).click();
    await expect(tabs.getByRole('tab', { name: 'Tests' })).toHaveAttribute('aria-selected', 'true');
    await expect(tour).toHaveAccessibleName('Practice tour: Budgets make brute force fail');
    const box = (await tour.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(390);
  });
});
