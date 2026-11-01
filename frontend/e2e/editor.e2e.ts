import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { appendCode, canvasNodes, codeEditor, editorText, expect, expectDiagramFitted, test, waitForCanvas } from './fixtures';

/** The e-commerce example has six components and a group. */
const DEFAULT_NODES = 6;

/** Opens the editor on the e-commerce example (an example link; a first visit opens the smaller hello example). */
async function openEditor(page: Page) {
  await page.goto('app/?example=ecommerce');
  await expect(codeEditor(page)).toBeVisible();
  await waitForCanvas(page, DEFAULT_NODES);
}

/** Opens a bundled example from the Examples gallery. */
async function openExample(page: Page, name: RegExp) {
  await page.getByRole('button', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: 'Examples…' }).click();
  const gallery = page.getByRole('dialog', { name: 'Examples' });
  await gallery.getByRole('button', { name }).click();
  await expect(gallery).toBeHidden();
}

const stepLabel = (page: Page) => page.getByText(/^Step \d+ of \d+$/);

test.describe('editor', () => {
  test.beforeEach(async ({ page }) => {
    await openEditor(page);
  });

  test('renders the example from the link on the canvas', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Diagrams' })).toContainText('E-Commerce Platform');
    for (const name of ['API Gateway', 'Order Service', 'Orders DB', 'OrderEvents']) {
      await expect(canvasNodes(page).filter({ hasText: name })).toBeVisible();
    }
    await expect(page.getByText('No problems')).toBeVisible();
  });

  test('typing in the code editor updates the diagram', async ({ page }) => {
    const before = await canvasNodes(page).count();
    await appendCode(page, '\nzeta "Zeta Cache" [Redis]\norders -> zeta : GET\n');
    await expect(canvasNodes(page).filter({ hasText: 'Zeta Cache' })).toBeVisible();
    await expect(canvasNodes(page)).toHaveCount(before + 1);
    await expect(page.getByText('No problems')).toBeVisible();
  });

  test('connections to and from a group are drawn, also while dragging', async ({ page }) => {
    const edges = page.locator('.react-flow__edge:visible');
    const before = await edges.count();
    await appendCode(page, '\nclient "Client" [Browser]\nclient -> vpc : HTTPS\nvpc -> events : Audit\n');
    await expect(canvasNodes(page).filter({ hasText: 'Client' })).toBeVisible();
    await expect(edges).toHaveCount(before + 2);
    for (const label of ['HTTPS', 'Audit']) {
      const edge = edges.filter({ hasText: label });
      await expect(edge.locator('path.react-flow__edge-path')).toHaveAttribute('d', /\S/);
      await expect(edge.locator('.pc-edge-head')).toBeAttached();
    }

    const path = edges.filter({ hasText: 'HTTPS' }).locator('path.react-flow__edge-path');
    const routed = await path.getAttribute('d');
    const box = (await canvasNodes(page).filter({ hasText: 'Client' }).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40, { steps: 5 });
    await expect(path).not.toHaveAttribute('d', routed!);
    await expect(edges).toHaveCount(before + 2);
    await page.mouse.up();
  });

  test('a component added from the palette is edited in its settings', async ({ page }) => {
    const before = await canvasNodes(page).count();
    await page.getByRole('button', { name: 'Add component' }).click();
    const palette = page.getByRole('dialog', { name: 'Add a component' });
    await palette.getByRole('searchbox', { name: 'Search components' }).fill('redis');
    await palette.getByRole('button', { name: 'Redis', exact: true }).click();
    await expect(palette).toBeHidden();
    await expect(canvasNodes(page)).toHaveCount(before + 1);
    expect(await editorText(page)).toContain('redis "Redis" [Redis]');

    await canvasNodes(page).filter({ hasText: 'Redis' }).click();
    const settings = page.getByRole('region', { name: 'Redis settings' });
    await settings.getByRole('button', { name: 'More replicas' }).click();
    await settings.getByRole('button', { name: 'More replicas' }).click();
    await expect.poll(() => editorText(page)).toContain('redis "Redis" [Redis] x3');
    await settings.getByLabel('Latency').fill('4');
    await settings.getByLabel('Latency').press('Enter');
    await expect.poll(() => editorText(page)).toMatch(/redis latency 4ms/);
    await expect(page.getByText('No problems')).toBeVisible();
  });

  test('a bad line shows a diagnostic', async ({ page }) => {
    await appendCode(page, '\nthis line is broken !!\n');
    const diagnostics = page.getByTestId('diagnostics');
    await expect(diagnostics).toBeVisible();
    await expect(diagnostics.getByRole('button').first()).toContainText("Unexpected character '!'");
    await expect(page.getByText('No problems')).toBeHidden();
    // The lint gutter marks the line too.
    await expect(page.locator('.cm-lint-marker-error').first()).toBeVisible();
  });

  test('Play runs a use case and steps through it', async ({ page }) => {
    await expect(page.getByRole('combobox', { name: 'Use case' })).toHaveValue('create-order');
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(stepLabel(page)).toHaveText(/^Step 1 of \d+$/);
    await expect(page.getByRole('button', { name: 'Back to diagram' })).toBeVisible();

    await page.getByRole('button', { name: 'Next step' }).click();
    await expect(stepLabel(page)).toHaveText(/^Step 2 of \d+$/);
    await page.getByRole('button', { name: 'Previous step' }).click();
    await expect(stepLabel(page)).toHaveText(/^Step 1 of \d+$/);
    await expect(page).toHaveURL(/[#&]uc=create-order/);

    await page.getByRole('button', { name: 'Back to diagram' }).click();
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await waitForCanvas(page, DEFAULT_NODES);
  });

  test('Escape and the Exit playback button leave playback', async ({ page }) => {
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(stepLabel(page)).toHaveText(/^Step 1 of \d+$/);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.getByRole('button', { name: 'Exit playback' }).click();
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  });

  test('scenario tabs switch the played scenario', async ({ page }) => {
    const tabs = page.getByRole('tablist', { name: 'Scenarios of Create order' });
    await expect(tabs.getByRole('tab')).toHaveCount(3);
    await tabs.getByRole('tab', { name: /Unknown user/ }).click();
    await expect(tabs.getByRole('tab', { name: /Unknown user/ })).toHaveAttribute('aria-selected', 'true');
    await expect(stepLabel(page)).toHaveText('Step 1 of 2') // responses (-->) are folded into the calls they answer;
    await expect(page).toHaveURL(/[#&]alt=unknown-user/);

    await tabs.getByRole('tab', { name: /Database down/ }).click();
    await expect(tabs.getByRole('tab', { name: /Database down/ })).toHaveAttribute('aria-selected', 'true');
    await expect(tabs.getByRole('tab', { name: /Unknown user/ })).toHaveAttribute('aria-selected', 'false');
    await expect(stepLabel(page)).toHaveText(/^Step 1 of \d+$/);
    await expect(page).toHaveURL(/[#&]alt=database-down/);
  });

  test('share link round trip keeps the diagram and the playback step', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await appendCode(page, '\nshared "Shared Node" [Redis]\n');
    await expect(canvasNodes(page).filter({ hasText: 'Shared Node' })).toBeVisible();

    const tabs = page.getByRole('tablist', { name: 'Scenarios of Create order' });
    await tabs.getByRole('tab', { name: /Database down/ }).click();
    await page.getByRole('button', { name: 'Next step' }).click();
    await page.getByRole('button', { name: 'Next step' }).click();
    await expect(stepLabel(page)).toHaveText(/^Step 3 of \d+$/);

    await page.getByRole('button', { name: 'Share', exact: true }).click();
    // No accounts in this build: no short links, and no sign-in hint either.
    await expect(page.getByRole('menuitem', { name: 'Short link with preview' })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Copy link to this step' }).click();
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
    const url = await page.evaluate(() => navigator.clipboard.readText());
    expect(url).toMatch(/\/proschi\/app\/#code=.*&uc=create-order&alt=database-down&step=3/);
    const source = await editorText(page);

    // A fresh page with no saved state must rebuild everything from the link.
    const other = await context.newPage();
    await other.goto(url);
    await expect(other.getByText(/^Step \d+ of \d+$/)).toHaveText(/^Step 3 of \d+$/);
    await expect(other.getByRole('tablist', { name: 'Scenarios of Create order' }).getByRole('tab', { name: /Database down/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await editorText(other)).toBe(source);
    await other.getByRole('button', { name: 'Back to diagram' }).click();
    await expect(canvasNodes(other).filter({ hasText: 'Shared Node' })).toBeVisible();
    await expect(canvasNodes(other)).toHaveCount(DEFAULT_NODES + 2); // + the group + the new node
  });

  test('Format code tidies the document', async ({ page }) => {
    await appendCode(page, '\nzeta    "Zeta Cache"     [Redis]\n   orders   ->   zeta\n');
    await expect.poll(() => editorText(page)).toContain('   orders   ->   zeta');
    await page.getByRole('button', { name: 'File' }).click();
    await page.getByRole('menuitem', { name: /Format code/ }).click();
    await expect.poll(() => editorText(page)).toContain('\norders -> zeta\n');
    const text = await editorText(page);
    expect(text).toContain('zeta "Zeta Cache" [Redis]');
    expect(text).not.toContain('   orders   ->');
  });

  test('HLD tab renders the design document', async ({ page }) => {
    await page.getByRole('tablist', { name: 'Diagram view' }).getByRole('tab', { name: 'HLD' }).click();
    const nav = page.getByRole('navigation', { name: 'HLD sections' });
    await expect(nav).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: 'E-Commerce Platform' })).toBeVisible();
    const sections = page.getByRole('heading', { level: 2 });
    await expect(sections.first()).toBeVisible();
    expect(await sections.count()).toBeGreaterThan(1);
    await expect(nav.getByRole('link')).toHaveCount(await sections.count());
  });

  test('Overlay: load shows how busy each node is at the traffic block\'s rates', async ({ page }) => {
    // The default example has no traffic block, so there is nothing to overlay.
    await expect(page.getByRole('button', { name: /load$/ })).toBeHidden();
    await openExample(page, /URL shortener HLD/);
    const toggle = page.getByRole('button', { name: 'Overlay: load' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.pc-node[data-load]').first()).toBeVisible();
    await expect(page.locator('.pc-node__stats').filter({ hasText: /\d+%/ }).first()).toBeVisible();
    await toggle.click();
    await expect(page.locator('.pc-node[data-load]')).toHaveCount(0);
  });

  test('three views: Diagram, Results and HLD', async ({ page }) => {
    const views = page.getByRole('tablist', { name: 'Diagram view' });
    await expect(views.getByRole('tab')).toHaveText(['Diagram', 'Results', 'HLD']);
  });

  test('Results lists the checks, then the analysis and the review, for the URL shortener', async ({ page }) => {
    await openExample(page, /URL shortener HLD/);
    await expect(page.getByRole('button', { name: 'Diagrams' })).toContainText('URL Shortener');
    const views = page.getByRole('tablist', { name: 'Diagram view' });

    const resultsTab = views.getByRole('tab', { name: /Results/ });
    await expect(resultsTab).toContainText(/\d+\/\d+/);
    await resultsTab.click();
    await expect(page.getByRole('heading', { name: 'Requirements and tests' })).toBeVisible();
    await expect(page.getByText(/^(All \d+ passing|\d+ of \d+ failing)$/)).toBeVisible();
    // Passing checks are folded away until asked for.
    await expect(page.getByRole('img', { name: 'passed' }).first()).toBeHidden();
    await page.getByText(/^\d+ passing$/).click();
    await expect(page.getByRole('img', { name: 'passed' }).first()).toBeVisible();

    await expect(page.getByRole('heading', { name: 'Nodes' })).toBeVisible();
    await expect(page.getByRole('meter').first()).toBeVisible();
    await page.getByRole('button', { name: 'Review my design' }).click();
    await expect(page.getByTestId('review-result').getByText(/tests pass/).first()).toBeVisible();
  });

  test('a failing requirement comes first, with its hint', async ({ page }) => {
    await page.goto('app/?example=url-shortener');
    await waitForCanvas(page);
    await appendCode(page, '\nrequirements {\n  p99 "Redirect" < 1ms\n}\n');
    const views = page.getByRole('tablist', { name: 'Diagram view' });
    await views.getByRole('tab', { name: /Results/ }).click();
    await expect(page.getByText(/^\d+ of \d+ failing$/)).toBeVisible();
    await expect(page.getByRole('img', { name: /^(passed|failed)$/ }).first()).toHaveAccessibleName('failed');
  });

  test('HLD sums the checks up and links to Results', async ({ page }) => {
    await openExample(page, /URL shortener HLD/);
    const views = page.getByRole('tablist', { name: 'Diagram view' });
    await views.getByRole('tab', { name: 'HLD' }).click();
    const summary = page.getByTestId('hld-checks');
    await expect(summary).toContainText(/checks (passing|failing)/);
    await summary.getByRole('button', { name: 'See Results' }).click();
    await expect(views.getByRole('tab', { name: /Results/ })).toHaveAttribute('aria-selected', 'true');
  });

  test('?view=tests and ?view=analysis open the Results tab', async ({ page }) => {
    for (const old of ['tests', 'analysis']) {
      await page.goto(`app/?example=url-shortener&view=${old}`);
      await expect(page.getByRole('tablist', { name: 'Diagram view' }).getByRole('tab', { name: /Results/ })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('heading', { name: 'Requirements and tests' })).toBeVisible();
    }
  });

  test('Export → PNG downloads an image', async ({ page }) => {
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'PNG image' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('e-commerce-platform.png');
    const bytes = await readFile(await download.path());
    // PNG signature, and more than an empty image.
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(bytes.length).toBeGreaterThan(10_000);
  });

  test('Export → SVG works from another tab, going back to the diagram', async ({ page }) => {
    const views = page.getByRole('tablist', { name: 'Diagram view' });
    await views.getByRole('tab', { name: /Results/ }).click();
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'SVG image' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('e-commerce-platform.svg');
    expect(download.url()).toMatch(/^data:image\/svg\+xml/);
    await expect(views.getByRole('tab', { name: 'Diagram' })).toHaveAttribute('aria-selected', 'true');
  });

  test('Export has the Mermaid and file downloads; the canvas has no menu of its own', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Export image' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Copy Mermaid: architecture' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Export all (.zip)' })).toBeVisible();

    let downloadPromise = page.waitForEvent('download');
    await menu.getByRole('menuitem', { name: 'Download Mermaid (.mmd)' }).click();
    let download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('e-commerce-platform.mmd');
    expect((await readFile(await download.path(), 'utf8')).length).toBeGreaterThan(50);

    await page.getByRole('button', { name: 'Export', exact: true }).click();
    downloadPromise = page.waitForEvent('download');
    await page.getByRole('menu').getByRole('menuitem', { name: 'Download .proschi file' }).click();
    download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.proschi$/);
    expect(await readFile(await download.path(), 'utf8')).toContain('title "E-Commerce Platform"');
  });
});

test.describe('first visit and example links', () => {
  test('a first visit opens a small design with traffic and requirements that pass', async ({ page }) => {
    await page.goto('app/');
    await expect(page.getByRole('button', { name: 'Diagrams' })).toContainText('Hello Proschi');
    await waitForCanvas(page, 3);
    await expect(page.getByText('No problems')).toBeVisible();
    const views = page.getByRole('tablist', { name: 'Diagram view' });
    await views.getByRole('tab', { name: /Results/ }).click();
    await expect(page.getByText(/^All \d+ passing$/)).toBeVisible();
    await page.getByText(/^\d+ passing$/).click();
    await expect(page.getByText('p99 of Create a note < 200 ms')).toBeVisible();
  });

  test('?example=<id> opens that example, once however often it is opened', async ({ page }) => {
    await page.goto('app/?example=login');
    await expect(page.getByRole('button', { name: 'Diagrams' })).toContainText('Login with Sessions');
    await waitForCanvas(page);
    // The address bar turns into a share link.
    await expect(page).toHaveURL(/\/proschi\/app\/#code=/);
    await page.goto('app/?example=url-shortener');
    await expect(page.getByRole('button', { name: 'Diagrams' })).toContainText('URL Shortener');
    await page.goto('app/?example=login');
    await expect(page.getByRole('button', { name: 'Diagrams' })).toContainText('Login with Sessions');
    await expect(page.getByRole('complementary', { name: 'Diagrams' }).getByText('Login with Sessions')).toHaveCount(1);
  });

  test('an unknown example says so and opens the editor as usual', async ({ page }) => {
    await page.goto('app/?example=nope');
    await expect(page.getByText('There is no example called “nope”')).toBeVisible();
    await waitForCanvas(page);
  });
});

test.describe('editor on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('a first visit opens on the Code pane', async ({ page }) => {
    await page.goto('app/');
    const panes = page.getByRole('tablist', { name: 'View', exact: true });
    await expect(panes.getByRole('tab', { name: /Code/ })).toHaveAttribute('aria-selected', 'true');
    await expect(codeEditor(page)).toBeVisible();
    await expect(codeEditor(page)).toContainText('title "Hello Proschi"');
  });

  test('Code and Diagram tabs switch panes; a link opens on the Diagram', async ({ page }) => {
    await page.goto('app/?example=ecommerce');
    const panes = page.getByRole('tablist', { name: 'View', exact: true });
    const codeTab = panes.getByRole('tab', { name: /Code/ });
    const diagramTab = panes.getByRole('tab', { name: /Diagram/ });
    await expect(diagramTab).toHaveAttribute('aria-selected', 'true');
    await waitForCanvas(page, DEFAULT_NODES);
    await expect(codeEditor(page)).toHaveCount(0);

    await codeTab.click();
    await expect(codeTab).toHaveAttribute('aria-selected', 'true');
    await expect(codeEditor(page)).toBeVisible();
    await expect(canvasNodes(page)).toHaveCount(0);
    await appendCode(page, '\nphone "Phone Node" [Redis]\n');

    await diagramTab.click();
    await expect(diagramTab).toHaveAttribute('aria-selected', 'true');
    await expect(canvasNodes(page).filter({ hasText: 'Phone Node' })).toBeVisible();
    await expect(codeEditor(page)).toHaveCount(0);
  });

  test('the diagram is fitted again after switching back from Code', async ({ page }) => {
    await page.goto('app/?example=ecommerce');
    const panes = page.getByRole('tablist', { name: 'View', exact: true });
    await waitForCanvas(page, DEFAULT_NODES);
    await expectDiagramFitted(page);
    // Edit while the canvas is hidden, then come back: the pane only gets its size again after it is shown.
    await panes.getByRole('tab', { name: /Code/ }).click();
    await appendCode(page, '\nwide "A Node With A Rather Long Name" [Redis]\norders -> wide\n');
    await panes.getByRole('tab', { name: /Diagram/ }).click();
    await expect(canvasNodes(page).filter({ hasText: 'A Node With A Rather Long Name' })).toBeVisible();
    await expectDiagramFitted(page);
    // Just switching tabs keeps it fitted too.
    await panes.getByRole('tab', { name: /Code/ }).click();
    await panes.getByRole('tab', { name: /Diagram/ }).click();
    await waitForCanvas(page, DEFAULT_NODES);
    await expectDiagramFitted(page);
  });
});

// The compact header carries the diagrams menu, the use case picker, Play, Zen, Export and Share.
for (const width of [375, 320]) {
  test.describe(`editor header at ${width}px`, () => {
    test.use({ viewport: { width, height: 700 }, hasTouch: true, isMobile: true });

    test('every control is on screen, and Export and Examples still work', async ({ page }) => {
      await page.goto('app/?example=ecommerce');
      await waitForCanvas(page, DEFAULT_NODES);
      const controls = [
        page.getByRole('button', { name: 'Diagrams' }),
        page.getByRole('combobox', { name: 'Use case' }),
        page.getByRole('button', { name: 'Play', exact: true }),
        page.getByRole('button', { name: 'Export', exact: true }),
        page.getByRole('button', { name: 'Share', exact: true }),
      ];
      for (const control of controls) {
        const box = (await control.boundingBox())!;
        const name = await control.getAttribute('aria-label');
        expect(box.x, `${name} starts off screen`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${name} ends off screen`).toBeLessThanOrEqual(width);
      }
      expect((await controls[1].boundingBox())!.width, 'the use case picker is squeezed out').toBeGreaterThanOrEqual(60);

      await page.getByRole('button', { name: 'Export', exact: true }).click();
      await expect(page.getByRole('menuitem', { name: 'PNG image' })).toBeInViewport();
      await page.keyboard.press('Escape');

      // Examples is in the File menu.
      await page.getByRole('button', { name: 'File' }).click();
      await page.getByRole('menuitem', { name: 'Examples…' }).click();
      await expect(page.getByRole('dialog', { name: 'Examples' })).toBeVisible();
    });
  });
}
