import type { Page } from '@playwright/test';
import lz from 'lz-string';
import { droneLink } from './drone';
import { codeEditor, expect, test, waitForCanvas } from './fixtures';

/**
 * The editor screenshots in the docs (docs/images/screens), retaken by
 * `npm run docs:screenshots` (screens.config.ts). Each shot is the editor at
 * 1440×860 in the light theme, opened on the document the page shows.
 */

const out = (name: string) => new URL(`../../docs/images/screens/${name}.png`, import.meta.url).pathname;

/** The editor on a document, light theme, with its layout settled. */
async function openEditor(page: Page, url: string) {
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('proschi.theme', 'light');
    } catch {
      // Storage blocked: the system setting (light here) applies.
    }
  });
  await page.goto(url);
  await expect(codeEditor(page)).toBeVisible();
  await waitForCanvas(page);
  await page.waitForTimeout(1200);
}

const code = (source: string) => `app/#code=${lz.compressToEncodedURIComponent(source)}`;

// The last example on docs/QUICKSTART.md, "4. Ask whether it holds up".
const QUICKSTART = `user "Shopper"   [Browser]
api  "Shop API"  [REST API]   x2
db   "Orders DB" [PostgreSQL] x2

user -> api : HTTPS
api  -> db  : SQL

usecase "Place order" {
  user -> api  : POST /orders {"sku": "A1"}
  api  -> db   : INSERT order
  api --> user : 201 {"id": 42}
}

traffic {
  "Place order" 500 rps
}

requirements {
  p99 "Place order" < 100ms
  survive any node failure
}
`;

test('Results tab (QUICKSTART)', async ({ page }) => {
  await openEditor(page, code(QUICKSTART));
  await page.getByRole('tablist', { name: 'Diagram view' }).getByRole('tab', { name: /Results/ }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: out('results') });
});

test('Overlay: load (STYLING)', async ({ page }) => {
  await openEditor(page, 'app/?example=url-shortener');
  await page.getByRole('button', { name: 'Overlay: load' }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: out('overlay-load') });
});

test('A team opened, with its breadcrumb (SYSTEMS)', async ({ page }) => {
  await openEditor(page, droneLink(2000));
  await page.locator('.react-flow__node-systemNode', { hasText: 'Order Processing' }).getByRole('button', { name: 'Open Order Processing' }).click();
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toBeVisible();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Overlay: load' }).click();
  // A narrower code pane leaves the team's left-to-right design room to read.
  await page.getByRole('separator').first().focus();
  for (let i = 0; i < 2; i++) await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'fit view' }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: out('team-open') });
});
