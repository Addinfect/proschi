import type { Page } from '@playwright/test';
import { codeEditor, editorText, expect, test } from './fixtures';

const files = (page: Page) => page.getByRole('complementary', { name: 'Diagrams' });
const stored = (page: Page) =>
  page.evaluate(() => (JSON.parse(localStorage.getItem('proschi.docs') ?? '{}') as { docs: { id: string; fileName: string }[] }).docs.map((d) => [d.id, d.fileName]));

test.describe('diagrams sidebar', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (localStorage.getItem('proschi.docs')) return;
      const doc = (id: string, fileName: string, title: string, body = '') => ({ id, fileName, source: `title "${title}"\n${body}`, updatedAt: '2026-10-01T00:00:00.000Z' });
      localStorage.setItem(
        'proschi.docs',
        JSON.stringify({
          currentId: 'shop',
          docs: [doc('api', 'payments/api.proschi', 'Payments API', 'api [REST API]\n'), doc('db', 'payments/db.proschi', 'Payments DB'), doc('shop', 'shop.proschi', 'Shop', 'import "payments/api.proschi"\n')],
        }),
      );
    });
    await page.goto('app/');
    await expect(codeEditor(page)).toBeVisible();
  });

  test('shows the diagrams as a folder tree, opens one, and folds a folder', async ({ page }) => {
    const tree = files(page);
    await expect(tree.getByTestId('folder')).toHaveText(['payments']);
    await expect(tree.getByTestId('file')).toHaveText(['Payments API', 'Payments DB', 'Shop']);
    await tree.getByTestId('file').filter({ hasText: 'Payments DB' }).click();
    await expect(page.getByRole('button', { name: 'Diagrams' })).toContainText('Payments DB');
    await expect.poll(() => editorText(page)).toContain('title "Payments DB"');

    await tree.getByTestId('folder').click();
    await expect(tree.getByTestId('file')).toHaveText(['Shop']);
    // Signed out (a build without accounts): where the diagrams are kept.
    await expect(tree.getByTestId('files-storage')).toContainText('this browser');
  });

  test('a new folder holds a new diagram; files move by menu and by drag, with a warning for importers', async ({ page }) => {
    const tree = files(page);
    await tree.getByRole('button', { name: 'New folder' }).click();
    await tree.getByRole('textbox', { name: 'New folder name' }).fill('archive');
    await tree.getByRole('textbox', { name: 'New folder name' }).press('Enter');
    await expect(tree.getByTestId('folder')).toHaveText(['archive', 'payments']);
    await expect(page.getByRole('button', { name: 'Diagrams' })).toContainText('Untitled');

    await tree.getByRole('button', { name: 'Actions for Payments API' }).click();
    await page.getByRole('menuitem', { name: 'Move to…' }).click();
    await page.getByRole('menuitem', { name: 'Top level' }).click();
    await expect(page.getByRole('status').filter({ hasText: '"Shop" has an import that no longer finds its file' })).toBeVisible();
    await expect.poll(() => stored(page)).toContainEqual(['api', 'api.proschi']);

    await tree.getByTestId('file').filter({ hasText: 'Payments DB' }).dragTo(tree.getByTestId('folder').filter({ hasText: 'archive' }));
    await expect.poll(() => stored(page)).toContainEqual(['db', 'archive/db.proschi']);
    // payments is empty now, so it is gone.
    await expect(tree.getByTestId('folder')).toHaveText(['archive']);

    // Dropped on a diagram in a folder, a file goes into that folder.
    await tree.getByTestId('file').filter({ hasText: 'Shop' }).dragTo(tree.getByTestId('file').filter({ hasText: 'Payments DB' }));
    await expect.poll(() => stored(page)).toContainEqual(['shop', 'archive/shop.proschi']);
  });

  test('rename, duplicate, search and Ctrl+P', async ({ page }) => {
    const tree = files(page);
    await tree.getByTestId('file').filter({ hasText: 'Shop' }).dblclick();
    await tree.getByRole('textbox', { name: 'New file name for Shop' }).fill('store');
    await tree.getByRole('textbox', { name: 'New file name for Shop' }).press('Enter');
    await expect.poll(() => stored(page)).toContainEqual(['shop', 'store.proschi']);

    await tree.getByRole('button', { name: 'Actions for Payments DB' }).click();
    await page.getByRole('menuitem', { name: 'Duplicate' }).click();
    await expect(page.getByRole('button', { name: 'Diagrams' })).toContainText('Payments DB copy');
    await expect(tree.getByTestId('file').filter({ hasText: 'Payments DB copy' })).toHaveAttribute('aria-current', 'true');

    await tree.getByRole('searchbox', { name: 'Search diagrams' }).fill('api');
    await expect(tree.getByTestId('file')).toHaveCount(1);
    await tree.getByRole('searchbox', { name: 'Search diagrams' }).fill('');

    await page.keyboard.press('ControlOrMeta+p');
    const dialog = page.getByRole('dialog', { name: 'Open a diagram' });
    await dialog.getByRole('combobox').fill('store');
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Diagrams' })).toContainText('Shop');
  });

  test('the toggle hides the sidebar, and it stays hidden after a reload', async ({ page }) => {
    await page.getByRole('button', { name: 'Diagrams' }).click();
    await expect(files(page)).toBeHidden();
    await page.reload();
    await expect(codeEditor(page)).toBeVisible();
    await expect(files(page)).toBeHidden();
  });

  test('the sidebar folds into a rail and opens from it', async ({ page }) => {
    await files(page).getByRole('button', { name: 'Hide sidebar' }).click();
    await expect(files(page)).toBeHidden();
    await page.getByRole('button', { name: 'Show sidebar' }).click();
    await expect(files(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeHidden();
  });
});

test.describe('diagrams drawer on a phone', () => {
  test.use({ viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true });

  test('opens from the title, and closes once a diagram is picked', async ({ page }) => {
    await page.goto('app/');
    await expect(codeEditor(page)).toBeVisible();
    await expect(files(page)).toBeHidden();
    await page.getByRole('button', { name: 'Diagrams' }).click();
    await expect(files(page)).toBeVisible();
    await files(page).getByRole('button', { name: 'New diagram' }).click();
    await expect(files(page)).toBeHidden();
    await expect(page.getByRole('button', { name: 'Diagrams' })).toContainText('Untitled');
  });
});
