import { canvasNodes, codeEditor, expect, test, waitForCanvas } from './fixtures';
import { droneLink } from './drone';

/**
 * The read-only embed page (/embed/, src/embed/main.tsx) and the editor's
 * Share → Embed, signed out (this build has no accounts): the snippet
 * carries the diagram in its #code= address, and the page draws it, plays
 * its use cases and links back to the editor, with no code editor of its own.
 */

/** Share → Embed in the editor; answers the iframe's src. */
async function copyEmbedSrc(page: import('@playwright/test').Page): Promise<string> {
  await page.goto('app/?example=ecommerce');
  await expect(codeEditor(page)).toBeVisible();
  await waitForCanvas(page, 6);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Embed' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Embed code copied' })).toBeVisible();
  const snippet = await page.evaluate(() => navigator.clipboard.readText());
  expect(snippet).toMatch(/^<iframe src="[^"]+" title="E-Commerce Platform · Proschi" width="100%" height="480" style="border:0" loading="lazy" allowfullscreen><\/iframe>$/);
  return snippet.match(/src="([^"]+)"/)![1].replace(/&amp;/g, '&');
}

test.describe('embed', () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test('Share → Embed copies an iframe whose page draws and plays the diagram', async ({ page, context }) => {
    const src = await copyEmbedSrc(page);
    expect(src).toMatch(/\/proschi\/embed\/#code=/);

    const embed = await context.newPage();
    await embed.goto(src);
    await expect(embed).toHaveTitle('E-Commerce Platform · Proschi');
    await expect(embed.getByRole('heading', { name: 'E-Commerce Platform' })).toBeVisible();
    await waitForCanvas(embed, 6);
    await expect(canvasNodes(embed).filter({ hasText: 'Order Service' })).toBeVisible();
    // Read-only: no code editor on the page.
    await expect(embed.locator('.cm-editor')).toHaveCount(0);

    const open = embed.getByRole('link', { name: 'Open in Proschi' });
    await expect(open).toHaveAttribute('href', /^\.\.\/app\/#code=/);
    await expect(open).toHaveAttribute('target', '_blank');

    await embed.getByRole('button', { name: 'Play' }).click();
    await expect(embed.getByRole('region', { name: /playing/ })).toBeVisible();
    await expect(open).toHaveAttribute('href', /&uc=/);
  });

  test('renders inside an iframe on another page, in the theme asked for', async ({ page, context }) => {
    const src = await copyEmbedSrc(page);
    const themed = src.replace('/embed/#', '/embed/?theme=dark#');
    const host = await context.newPage();
    await host.setContent(`<!doctype html><title>Blog post</title><iframe src="${themed}" width="900" height="480" style="border:0"></iframe>`);
    const frame = host.frameLocator('iframe');
    await expect(frame.locator('.react-flow__node').filter({ hasText: 'Order Service' })).toBeVisible();
    await expect(frame.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('system boxes show their status, as in the editor', async ({ page }) => {
    // The live examples of the docs pages draw with the same component.
    await page.goto(droneLink(2000).replace(/^app\//, 'embed/'));
    const orders = page.locator('.react-flow__node-systemNode', { hasText: 'Order Processing' });
    await expect(orders.locator('.pc-system__pill')).toHaveText('Saturated');
    await expect(orders).toContainText(/2k \/ 1\.2k rps/);
    await expect(page.locator('.react-flow__node-systemNode', { hasText: 'Frontend' }).locator('.pc-system__pill')).toHaveText('OK');
  });

  test('says what is missing without a diagram', async ({ page }) => {
    await page.goto('embed/');
    await expect(page.getByRole('alert')).toContainText('No diagram here');
  });
});
