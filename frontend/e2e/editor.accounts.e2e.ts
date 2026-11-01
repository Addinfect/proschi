import type { Page } from '@playwright/test';
import { mockSignedIn } from './accounts';
import { appendCode, codeEditor, expect, test } from './fixtures';

/**
 * Cloud sync of the editor's diagrams, signed in (the build with accounts):
 * the account's documents (GET/PUT/DELETE /api/me/documents) are kept in
 * memory here with the server's rules, so the test sees what the page sends.
 */

interface Doc {
  id: string;
  name: string;
  source: string;
  imports: Record<string, string> | null;
  version: number;
  updatedAt: number;
  deletedAt: number | null;
}

class Account {
  docs = new Map<string, Doc>();
  puts: string[] = [];
  /** documentLimit in backend/src/documents.ts; none unless a test sets it. */
  limit?: number;

  live(): number {
    return [...this.docs.values()].filter((d) => d.deletedAt === null).length;
  }
  private clock = Date.now();

  write(doc: Omit<Doc, 'updatedAt'>): Doc {
    const saved = { ...doc, updatedAt: ++this.clock };
    this.docs.set(doc.id, saved);
    return saved;
  }

  async mock(page: Page): Promise<void> {
    await page.route(
      (url) => url.pathname.startsWith('/api/me/documents'),
      async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const id = decodeURIComponent(url.pathname.split('/')[4] ?? '');
        const method = request.method();
        if (method === 'GET') {
          const since = Number(url.searchParams.get('since') ?? 0);
          const documents = [...this.docs.values()].filter((d) => d.updatedAt >= since);
          return route.fulfill({ json: { documents, cursor: this.clock, ...(this.limit !== undefined ? { limit: this.limit, used: this.live() } : {}) } });
        }
        if (method === 'DELETE' && !id) {
          const deleted = this.docs.size;
          this.docs.clear();
          return route.fulfill({ json: { deleted } });
        }
        const existing = this.docs.get(id);
        if (method === 'PUT') {
          const body = request.postDataJSON() as { name: string; source: string; imports: Record<string, string> | null; baseVersion: number };
          this.puts.push(id);
          if (existing && existing.version !== body.baseVersion) return route.fulfill({ status: 409, json: { error: 'changed', document: existing } });
          if (this.limit !== undefined && (!existing || existing.deletedAt !== null) && this.live() >= this.limit) {
            return route.fulfill({ status: 409, json: { error: 'document_limit', message: 'Your account is full', limit: this.limit, used: this.live() } });
          }
          const doc = this.write({ id, name: body.name, source: body.source, imports: body.imports, version: (existing?.version ?? 0) + 1, deletedAt: null });
          return route.fulfill({ json: { document: doc } });
        }
        if (!existing) return route.fulfill({ status: 204 });
        const doc = this.write({ ...existing, name: '', source: '', imports: null, version: existing.version + 1, deletedAt: Date.now() });
        return route.fulfill({ json: { document: doc } });
      },
    );
  }
}

/** The browser logs the 409 and 401 answers the page expects as console errors; only those are dropped. */
function allowStatus(errors: string[], status: number) {
  const re = new RegExp(`Failed to load resource: the server responded with a status of ${status}`);
  for (let i = errors.length - 1; i >= 0; i--) if (re.test(errors[i])) errors.splice(i, 1);
}

async function openMenu(page: Page) {
  await page.getByRole('button', { name: 'File' }).click();
  return page.getByRole('menu');
}

/** The diagrams sidebar. */
const files = (page: Page) => page.getByRole('complementary', { name: 'Diagrams' });

test('signed in, the diagrams sync with the account, and a conflict keeps both', async ({ page, errors }) => {
  const account = new Account();
  account.write({ id: 'cloud-1', name: 'cloud.proschi', source: 'title "Cloud Diagram"\n\nweb "Web" [Service]\n', imports: null, version: 1, deletedAt: null });
  await mockSignedIn(page);
  await account.mock(page);
  await page.goto('app/?example=ecommerce');
  await expect(codeEditor(page)).toBeVisible();

  // The account's diagram arrives, and the one in this browser (the example) is uploaded.
  await expect.poll(() => account.docs.size).toBe(2);
  const localId = [...account.docs.keys()].find((id) => id !== 'cloud-1')!;
  expect(account.docs.get(localId)?.source).toContain('title "E-Commerce Platform"');
  await expect(files(page)).toContainText('Cloud Diagram');
  let menu = await openMenu(page);
  await expect(menu.getByTestId('cloud-status')).toHaveText('Saved to your account');
  await page.keyboard.press('Escape');

  // An edit is pushed shortly after typing stops.
  await appendCode(page, '\nzeta "Zeta Cache" [Redis]\n');
  await expect.poll(() => account.docs.get(localId)?.source).toContain('zeta "Zeta Cache" [Redis]');
  expect(account.docs.get(localId)?.version).toBe(2);

  // Another device saves the same diagram meanwhile: both versions are kept.
  const current = account.docs.get(localId)!;
  account.write({ ...current, source: current.source.replace('E-Commerce Platform', 'Their Shop'), version: current.version + 1 });
  await appendCode(page, '\nmine "Mine" [Service]\n');
  await expect(page.getByRole('status').filter({ hasText: 'both versions are kept' })).toBeVisible();
  await expect.poll(() => [...account.docs.values()].filter((d) => d.source.includes('mine "Mine"')).length).toBe(1);
  const copy = [...account.docs.values()].find((d) => d.source.includes('mine "Mine"'))!;
  expect(copy.id).not.toBe(localId);
  expect(copy.source).toMatch(/title "E-Commerce Platform \(conflict .+\)"/);
  expect(account.docs.get(localId)?.source).toContain('Their Shop');
  await expect(page.getByRole('button', { name: 'Diagrams' })).toContainText('(conflict');

  // Turned off, nothing more is sent; deleting the cloud copies keeps the diagrams here.
  menu = await openMenu(page);
  await menu.getByRole('menuitem', { name: 'Turn off cloud sync' }).click();
  const puts = account.puts.length;
  await appendCode(page, '\nlocal "Local" [Service]\n');
  menu = await openMenu(page);
  await expect(menu.getByTestId('cloud-status')).toHaveText('Cloud sync is off — saved in this browser only');
  page.once('dialog', (dialog) => void dialog.accept());
  await menu.getByRole('menuitem', { name: 'Delete my cloud copies' }).click();
  await expect.poll(() => account.docs.size).toBe(0);
  expect(account.puts.length).toBe(puts);
  await expect(files(page)).toContainText('Cloud Diagram');
  await expect(files(page)).toContainText('Their Shop');
  allowStatus(errors, 409);
});

test('signed out, the menu offers to sign in to keep diagrams on every device', async ({ page, errors }) => {
  await mockSignedIn(page);
  await page.route('**/api/me', (route) => route.fulfill({ status: 401, json: { error: 'Sign in first' } }));
  await page.goto('app/');
  await expect(codeEditor(page)).toBeVisible();
  const menu = await openMenu(page);
  await expect(menu.getByTestId('cloud-status')).toHaveText('Sign in to keep your diagrams on every device');
  await expect(menu.getByRole('menuitem', { name: 'Sign in with GitHub' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Sign in with Google' })).toBeVisible();
  allowStatus(errors, 401);
});

test('another account signing in: diagrams already in the browser are only added after asking', async ({ page }) => {
  const account = new Account();
  await mockSignedIn(page);
  await account.mock(page);
  await page.addInitScript(() => {
    const doc = (id: string, title: string) => ({ id, source: `title "${title}"\n\nweb "Web" [Service]\n`, fileName: `${id}.proschi`, updatedAt: '2026-10-01T00:00:00.000Z' });
    localStorage.setItem('proschi.docs', JSON.stringify({ docs: [doc('theirs', 'Someone Else'), doc('here', 'Made Here')], currentId: 'theirs' }));
    // "theirs" is synced with another account; its fingerprint is not known here, so it counts as edited: held back too.
    localStorage.setItem('proschi.docs.sync', JSON.stringify({ meta: { userId: 'someone-else', cursor: 1, docs: { theirs: { version: 1, fp: 'not-this-content' } }, refused: {} } }));
  });
  await page.goto('app/');
  await expect(codeEditor(page)).toBeVisible();
  const prompt = page.getByRole('status').filter({ hasText: 'Add 2 diagrams from this browser to your account?' });
  await expect(prompt).toBeVisible();
  await page.waitForTimeout(2500);
  expect(account.puts).toEqual([]);
  await prompt.getByRole('button', { name: 'Keep in this browser only' }).click();
  await expect(prompt).toBeHidden();
  await page.waitForTimeout(2500);
  expect(account.puts).toEqual([]);
  await expect(files(page)).toContainText('Made Here');
  const menu = await openMenu(page);
  await menu.getByRole('menuitem', { name: 'Add 2 diagrams from this browser to your account' }).click();
  await expect.poll(() => account.docs.size).toBe(2);
});

test('the account keeps a limited number of diagrams: the rest stay in this browser, marked, and can swap places', async ({ page, errors }) => {
  const account = new Account();
  account.limit = 2;
  account.write({ id: 'cloud-1', name: 'cloud.proschi', source: 'title "Cloud Diagram"\n\nweb "Web" [Service]\n', imports: null, version: 1, deletedAt: null });
  await mockSignedIn(page);
  await account.mock(page);
  await page.addInitScript(() => {
    if (localStorage.getItem('proschi.docs')) return;
    const doc = (id: string, title: string, day: number) => ({ id, source: `title "${title}"\n\nweb "Web" [Service]\n`, fileName: `${id}.proschi`, updatedAt: `2026-10-0${day}T00:00:00.000Z` });
    localStorage.setItem('proschi.docs', JSON.stringify({ docs: [doc('d1', 'Oldest', 1), doc('d2', 'Middle', 2), doc('d3', 'Newest', 3)], currentId: 'd3' }));
  });
  await page.goto('app/');
  await expect(codeEditor(page)).toBeVisible();

  // One slot was free: the most recently edited diagram takes it.
  await expect.poll(() => [...account.docs.keys()].sort()).toEqual(['cloud-1', 'd3']);
  let menu = await openMenu(page);
  await expect(menu.getByTestId('cloud-status')).toHaveText('Cloud full: 2 of 2 — new diagrams stay in this browser');
  await page.keyboard.press('Escape');
  const row = (title: string) => files(page).getByRole('listitem').filter({ hasText: title });
  await expect(row('Oldest').getByTestId('browser-only')).toBeVisible();
  await expect(row('Middle').getByTestId('browser-only')).toBeVisible();
  await expect(row('Newest').getByTestId('browser-only')).toHaveCount(0);
  await files(page).getByRole('button', { name: 'Actions for Oldest' }).click();
  await expect(page.getByRole('menuitem', { name: 'Account full: keep in your account' })).toBeDisabled();
  await page.keyboard.press('Escape');

  // Moving one to this browser only frees its slot, which the next most recent takes.
  page.once('dialog', (dialog) => void dialog.accept());
  await files(page).getByRole('button', { name: 'Actions for Cloud Diagram' }).click();
  await page.getByRole('menuitem', { name: 'Move to this browser only' }).click();
  await expect.poll(() => account.docs.get('cloud-1')?.deletedAt).not.toBeNull();
  await expect.poll(() => account.docs.get('d2')?.deletedAt).toBeNull();
  menu = await openMenu(page);
  await expect(row('Cloud Diagram').getByTestId('browser-only')).toBeVisible();
  await expect(row('Middle').getByTestId('browser-only')).toHaveCount(0);
  await expect(menu.getByTestId('cloud-status')).toHaveText('Cloud full: 2 of 2 — new diagrams stay in this browser');
  allowStatus(errors, 409);
});
