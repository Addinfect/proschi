import type { Page } from '@playwright/test';
import lz from 'lz-string';
import { mockSignedIn } from './accounts';
import { appendCode, codeEditor, editorText, expect, mockClipboard, copiedText, test } from './fixtures';
import { Account, ORDERS, seed } from './versions';

/**
 * Saved versions and `cloud:` sources in the editor, signed in (the build
 * with accounts), against the in-memory account of e2e/versions.ts.
 */

/** The browser logs the 4xx answers the page expects as console errors; only those are dropped. */
function allowStatus(errors: string[], status: number) {
  const re = new RegExp(`Failed to load resource: the server responded with a status of ${status}`);
  for (let i = errors.length - 1; i >= 0; i--) if (re.test(errors[i])) errors.splice(i, 1);
}

async function openVersions(page: Page) {
  await page.getByRole('button', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: 'Versions…' }).click();
  return page.getByRole('dialog', { name: 'Versions' });
}

test('save a version, list it, view it read-only, compare it with the draft and delete it', async ({ page, errors }) => {
  const account = new Account();
  await mockSignedIn(page);
  await account.mock(page);
  await mockClipboard(page);
  await seed(page, [{ id: 'orders', fileName: 'orders.proschi', source: ORDERS }]);
  await page.goto('app/');
  await expect(codeEditor(page)).toBeVisible();
  await expect.poll(() => account.docs.get('orders')?.source).toBe(ORDERS);

  // Save: the tag is today's date; the note is optional.
  const today = new Date().toISOString().slice(0, 10);
  let dialog = await openVersions(page);
  await expect(dialog.getByLabel('Tag')).toHaveValue(today);
  await dialog.getByLabel('Tag').fill('Latest');
  await expect(dialog.getByText('“latest” is reserved')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save version' })).toBeDisabled();
  await dialog.getByLabel('Tag').fill(today);
  await dialog.getByLabel('Note (optional)').fill('First cut');
  await dialog.getByRole('button', { name: 'Save version' }).click();
  await expect(dialog.getByRole('status')).toHaveText(`Saved version ${today}.`);
  const list = dialog.getByRole('list', { name: 'Saved versions' });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list).toContainText('latest');
  await expect(list).toContainText('First cut');
  await expect(dialog.getByText('1 of 20 versions used.')).toBeVisible();
  // The next suggestion is free.
  await expect(dialog.getByLabel('Tag')).toHaveValue(`${today}.2`);
  expect(account.versions.get('orders')?.[0]).toMatchObject({ tag: today, note: 'First cut', source: ORDERS });

  // Copy reference, and the system block snippet.
  await dialog.getByRole('button', { name: `Copy a reference to ${today}` }).click();
  await dialog.getByRole('button', { name: 'Copy reference' }).click();
  expect(await copiedText(page)).toBe(`cloud:orders:${today}`);
  await dialog.getByRole('button', { name: `Copy a reference to ${today}` }).click();
  await dialog.getByRole('button', { name: 'Copy as system block' }).click();
  expect(await copiedText(page)).toBe(`system orders {\n  from "cloud:orders:${today}"\n}\n`);
  await page.keyboard.press('Escape');

  // The draft moves on: a cache is added.
  await appendCode(page, '\ncache "Orders Cache" [Redis]\napi -> cache\n');

  // View: read-only, then back to the draft.
  dialog = await openVersions(page);
  await dialog.getByRole('button', { name: `View ${today}` }).click();
  const viewer = page.getByRole('dialog', { name: `Version ${today}` });
  await expect(viewer.getByRole('status')).toHaveText(`Version ${today} · read-only`);
  await expect(viewer.locator('.cm-content')).toHaveAttribute('contenteditable', 'false');
  await expect(viewer.locator('.react-flow__node')).toHaveCount(2);
  await viewer.getByRole('button', { name: 'Back to draft' }).click();
  await expect(viewer).toBeHidden();
  expect(await editorText(page)).toContain('Orders Cache');

  // Compare with the draft: the cache is new on the canvas and in the list.
  dialog = await openVersions(page);
  await dialog.getByRole('button', { name: `Compare ${today}` }).click();
  const compare = page.getByRole('dialog', { name: 'Compare versions' });
  await expect(compare.getByLabel('Base')).toHaveValue(today);
  await expect(compare.getByLabel('Target')).toHaveValue('');
  await expect(compare.locator('.react-flow__node.pc-diff-added')).toHaveText(/Orders Cache/);
  await expect(compare.getByTestId('diff-counts')).toContainText('2 added');
  const changes = compare.getByRole('complementary', { name: 'Changes' });
  await expect(changes).toContainText('Orders Cache (cache)');
  await expect(changes).toContainText('api → cache');
  await expect(changes.getByRole('rowheader', { name: 'Cost' })).toBeVisible();
  await compare.getByRole('button', { name: 'Back to draft' }).click();

  // Restore into the draft, and undo it.
  dialog = await openVersions(page);
  await dialog.getByRole('button', { name: `View ${today}` }).click();
  await page.getByRole('button', { name: 'Restore into draft' }).click();
  await expect.poll(() => editorText(page)).toBe(ORDERS);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => editorText(page)).toContain('Orders Cache');

  // Delete, with an inline confirmation; the tag stays taken.
  dialog = await openVersions(page);
  await dialog.getByRole('button', { name: `Delete ${today}` }).click();
  await expect(dialog.getByRole('group', { name: `Delete ${today}?` })).toContainText("can't be reused");
  await dialog.getByRole('group', { name: `Delete ${today}?` }).getByRole('button', { name: 'Delete' }).click();
  await expect(dialog.getByText('No versions yet.')).toBeVisible();
  await dialog.getByLabel('Tag').fill(today);
  await dialog.getByRole('button', { name: 'Save version' }).click();
  await expect(dialog.getByRole('alert')).toContainText(`The tag “${today}” is taken`);
  allowStatus(errors, 409);
});

test('a cloud: reference draws the saved version in a system box, read-only, and the share link carries it', async ({ page }) => {
  const account = new Account();
  account.seed('orders', 'orders.proschi', 'v1', 'title "Orders"\nusecase "Place order" {\n  api -> db\n}\napi "Orders API" [REST API]\ndb [Postgres]\n');
  await mockSignedIn(page);
  await account.mock(page);
  const org = 'title "Org"\n\nshopper [Browser]\n\nsystem orders "Order Processing" {\n  from "cloud:orders:v1"\n  expose api -> "Place order"\n}\n\nshopper -> orders.api\n';
  await seed(page, [{ id: 'org', fileName: 'org.proschi', source: org }]);
  await page.goto('app/');
  const box = page.locator('.react-flow__node-systemNode', { hasText: 'Order Processing' });
  await expect(box).toBeVisible();
  expect(account.resolves).toEqual(['orders.proschi:v1']);
  await expect(page.getByTestId('diagnostics').filter({ hasText: 'cloud:' })).toHaveCount(0);

  // Opened, the version shows read-only.
  await box.dblclick();
  await expect(page.getByRole('group', { name: 'Team file' })).toContainText('saved version');

  // The address bar's share link bundles the version, for viewers without the account.
  await expect.poll(() => page.evaluate(() => location.hash)).toContain('&imports=');
  const hash = await page.evaluate(() => location.hash);
  const imports = JSON.parse(lz.decompressFromEncodedURIComponent(hash.split('&imports=')[1].split('&')[0]) ?? '{}') as Record<string, string>;
  expect(Object.keys(imports)).toContain('cloud:orders:v1');

  // Reloading that link never saves the version with the diagram: it is fetched again, not synced or frozen into a version.
  await expect.poll(() => account.docs.has('org')).toBe(true);
  const url = page.url();
  await page.close();
  const again = await page.context().newPage();
  await mockSignedIn(again);
  await account.mock(again);
  await again.goto(url);
  await expect(again.locator('.react-flow__node-systemNode', { hasText: 'Order Processing' })).toBeVisible();
  // Once the sync settles, anything it would have saved is saved.
  await again.getByRole('button', { name: 'File' }).click();
  await expect(again.getByTestId('cloud-status')).toContainText('Saved to your account');
  await again.keyboard.press('Escape');
  const stored = await again.evaluate(() => JSON.parse(localStorage.getItem('proschi.docs') ?? '{}') as { docs: { id: string; imports?: Record<string, string> }[] });
  expect(Object.keys(stored.docs.find((d) => d.id === 'org')?.imports ?? {})).toEqual([]);
  expect(Object.keys(account.docs.get('org')?.imports ?? {})).toEqual([]);
});

test('a diagram whose file name cannot be a cloud: name says to rename it instead of copying a reference', async ({ page }) => {
  const account = new Account();
  account.seed('mine', 'my orders.proschi', 'v1', ORDERS);
  await mockSignedIn(page);
  await account.mock(page);
  await seed(page, [{ id: 'mine', fileName: 'my orders.proschi', source: ORDERS }]);
  await page.goto('app/');
  await expect(codeEditor(page)).toBeVisible();
  const dialog = await openVersions(page);
  await dialog.getByRole('button', { name: 'Copy a reference to v1' }).click();
  await expect(dialog.getByText("This diagram's file name can't be used in a cloud: reference")).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Copy reference' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Copy as system block' })).toHaveCount(0);
});

test('a cloud: reference that is missing says so on its line', async ({ page, errors }) => {
  const account = new Account();
  await mockSignedIn(page);
  await account.mock(page);
  await seed(page, [{ id: 'org', fileName: 'org.proschi', source: 'title "Org"\nimport "cloud:payments:v9"\n' }]);
  await page.goto('app/');
  await expect(page.getByTestId('diagnostics')).toContainText("your account has no diagram named payments.proschi with a version 'v9'");
  allowStatus(errors, 404);
});

test('signed out, a cloud: reference asks to sign in', async ({ page }) => {
  await mockSignedIn(page);
  await page.route('**/api/me', (route) => route.fulfill({ status: 401, json: { error: 'Sign in first' } }));
  await seed(page, [{ id: 'org', fileName: 'org.proschi', source: 'title "Org"\nimport "cloud:orders"\n' }]);
  await page.goto('app/');
  await expect(page.getByTestId('diagnostics')).toContainText('Sign in to use cloud: sources');
  // And the Versions panel explains where versions live.
  const dialog = await openVersions(page);
  await expect(dialog.getByTestId('versions-hint')).toContainText('Versions live in your Proschi account');
  await expect(dialog.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
});
