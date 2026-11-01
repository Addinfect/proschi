import type { Page } from '@playwright/test';
import { mockSignedIn } from './accounts';
import { codeEditor, expect, test, waitForCanvas } from './fixtures';
import { Account, seed } from './versions';

/**
 * The screenshots of saved versions in docs/VERSIONS.md, signed in against
 * the in-memory account of e2e/versions.ts. Retaken with the others by
 * `npm run docs:screenshots` (screens.config.ts).
 */

const out = (name: string) => new URL(`../../docs/images/screens/${name}.png`, import.meta.url).pathname;

const FIRST = `title "Orders"

shopper "Shopper"    [Browser]
api     "Orders API" [REST API] x2
db      "Orders DB"  [PostgreSQL]

shopper -> api : HTTPS
api     -> db  : SQL

usecase "Order status" {
  shopper -> api     : GET /orders/42
  api     -> db      : SELECT order
  api    --> shopper : 200
}

traffic {
  "Order status" 2k rps
}
`;

const SECOND = FIRST.replace('x2', 'x3').replace('2k rps', '3k rps');

const LATEST = `title "Orders"

shopper "Shopper"     [Browser]
api     "Orders API"  [REST API] x3
cache   "Order cache" [Redis]
db      "Orders DB"   [PostgreSQL] x2

shopper -> api   : HTTPS
api     -> cache : RESP
api     -> db    : SQL

usecase "Order status" {
  shopper -> api     : GET /orders/42
  api     -> cache   : GET order:42
  api    --> shopper : 200
}

traffic {
  "Order status" 3k rps
}

requirements {
  p99 "Order status" < 50ms
}
`;

/** The orders diagram with three saved versions, the draft equal to the newest, and the Versions panel open. */
async function openVersions(page: Page) {
  await page.clock.setFixedTime(new Date('2026-11-01T10:00:00Z'));
  const account = new Account();
  const saved: [string, string, string, number][] = [
    ['2026-09-14', FIRST, 'First cut: one database', Date.UTC(2026, 8, 14)],
    ['2026-10-01', SECOND, 'A third API replica', Date.UTC(2026, 9, 1)],
    ['2026-11-01', LATEST, 'Redis cache for order status, a database replica', Date.UTC(2026, 10, 1)],
  ];
  for (const [tag, source] of saved) account.seed('orders', 'orders.proschi', tag, source);
  for (const v of account.versions.get('orders') ?? []) {
    const [, , note, at] = saved.find(([tag]) => tag === v.tag)!;
    v.note = note;
    v.createdAt = at;
  }
  account.docs.get('orders')!.source = LATEST;
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('proschi.theme', 'light');
    } catch {
      // Storage blocked: the system setting (light here) applies.
    }
  });
  await mockSignedIn(page);
  await account.mock(page);
  await seed(page, [{ id: 'orders', fileName: 'orders.proschi', source: LATEST }]);
  await page.goto('app/');
  await expect(codeEditor(page)).toBeVisible();
  await waitForCanvas(page);
  await page.getByRole('button', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: 'Versions…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Versions' });
  await expect(dialog.getByRole('list', { name: 'Saved versions' }).getByRole('listitem')).toHaveCount(3);
  return dialog;
}

test('The Versions panel (VERSIONS)', async ({ page }) => {
  await openVersions(page);
  await page.waitForTimeout(800);
  await page.screenshot({ path: out('versions-panel') });
});

test('Two versions compared (VERSIONS)', async ({ page }) => {
  const dialog = await openVersions(page);
  await dialog.getByRole('button', { name: 'Compare 2026-09-14' }).click();
  const compare = page.getByRole('dialog', { name: 'Compare versions' });
  await compare.getByLabel('Target').selectOption('2026-11-01');
  await expect(compare.locator('.react-flow__node.pc-diff-added')).toHaveText(/Order cache/);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: out('versions-compare') });
});
