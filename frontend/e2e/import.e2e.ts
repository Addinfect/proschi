import type { Page } from '@playwright/test';
import { canvasNodes, codeEditor, editorText, expect, test, waitForCanvas } from './fixtures';

async function openEditor(page: Page) {
  await page.goto('app/');
  await expect(codeEditor(page)).toBeVisible();
  await waitForCanvas(page);
}

test.describe('import and the start gallery', () => {
  test('a Mermaid flowchart pasted in the Import dialog opens as a new diagram', async ({ page }) => {
    await openEditor(page);
    await page.getByRole('button', { name: 'File' }).click();
    await page.getByRole('menuitem', { name: 'Import Mermaid or OpenAPI…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import' });
    await expect(dialog).toBeVisible();

    await dialog.getByRole('textbox').fill(
      ['---', 'title: Photo app', '---', 'flowchart LR', '  user((User)) --> api[Photo API]', '  api -->|SQL| db[(Photos DB)]', '  api --> cache[(Redis)]', '  style api fill:#f9f'].join('\n'),
    );
    const preview = dialog.getByLabel('Proschi preview');
    await expect(preview).toContainText('db    "Photos DB" [Database]');
    await expect(dialog.getByRole('list', { name: 'Import warnings' })).toContainText('Ignored 1 styling line');

    await dialog.getByRole('button', { name: 'Open as new diagram' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Diagrams' })).toContainText('Photo app');
    await expect(canvasNodes(page).filter({ hasText: 'Photo API' })).toBeVisible();
    await expect(canvasNodes(page)).toHaveCount(4);
    for (const name of ['User', 'Photos DB', 'Redis']) {
      await expect(canvasNodes(page).filter({ hasText: name })).toBeVisible();
    }
    expect(await editorText(page)).toContain('api  -> db : SQL');
    await expect(page.getByText('No problems')).toBeVisible();
  });

  test('an OpenAPI spec becomes a client, the API and a use case per operation', async ({ page }) => {
    await openEditor(page);
    await page.getByRole('button', { name: 'File' }).click();
    await page.getByRole('menuitem', { name: 'Import Mermaid or OpenAPI…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Import' });
    await dialog.getByRole('tab', { name: 'OpenAPI' }).click();
    await dialog.getByRole('textbox').fill('openapi: 3.0.3\ninfo:\n  title: Pets API\npaths:\n  /pets:\n    get:\n      summary: List pets\n      responses:\n        "200": { description: OK }\n');
    await expect(dialog.getByLabel('Proschi preview')).toContainText('client -> api    : GET /pets');
    await dialog.getByRole('button', { name: 'Open as new diagram' }).click();
    await expect(page.getByRole('combobox', { name: 'Use case' })).toHaveValue('list-pets');
    await expect(canvasNodes(page)).toHaveCount(2);
  });

  test('the gallery shows reference solutions of solved problems only, and filters by pattern', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('proschi.practice', JSON.stringify({ 'url-shortener': { status: 'solved' } })));
    await openEditor(page);
    await page.getByRole('button', { name: 'File' }).click();
    await page.getByRole('menuitem', { name: 'Examples…' }).click();
    const gallery = page.getByRole('dialog', { name: 'Examples' });
    await expect(gallery.getByRole('button', { name: 'Reference solution: URL Shortener' })).toBeVisible();
    // Unsolved problems are listed without their designs.
    await expect(gallery.getByRole('link', { name: /Solve Pastebin to unlock/ })).toHaveAttribute('href', '../practice/pastebin/');
    await expect(gallery.getByRole('button', { name: /Reference solution: Pastebin/ })).toHaveCount(0);

    await gallery.getByRole('searchbox').fill('kafka');
    await expect(gallery.getByRole('button', { name: 'Event-driven checkout' })).toBeVisible();
    await expect(gallery.getByRole('button', { name: 'Hello Proschi' })).toBeHidden();
    await gallery.getByRole('searchbox').fill('');
    await gallery.getByRole('group', { name: 'Filter by pattern' }).getByRole('button', { name: 'cache', exact: true }).click();
    await expect(gallery.getByRole('button', { name: 'Hello Proschi' })).toBeHidden();
    await expect(gallery.getByRole('link', { name: /to unlock/ })).toHaveCount(0);

    await gallery.getByRole('button', { name: 'Reference solution: URL Shortener' }).click();
    await expect(gallery).toBeHidden();
    await expect(page.getByRole('button', { name: 'Diagrams' })).toContainText('URL Shortener: reference solution');
    await expect(page.getByText('No problems')).toBeVisible();
  });
});
