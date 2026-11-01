import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import base from '../playwright.config';

/**
 * `npm run docs:screenshots`: retakes the editor screenshots in
 * docs/images/screens (docs-screenshots*.screens.ts) against the production
 * builds, at a fixed size in the light theme. Run by hand after a UI change,
 * never in CI; `npm run build` and `npm run build:accounts` first.
 * *.accounts.screens.ts run against the build with accounts, its API mocked
 * with page.route, like *.accounts.e2e.ts.
 */
const ACCOUNTS = /\.accounts\.screens\.ts$/;
const screen = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 860 }, deviceScaleFactor: 1, colorScheme: 'light' as const };
const accountsUrl = base.projects?.find((p) => p.name === 'accounts')?.use?.baseURL;

export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: '**/*.screens.ts',
  retries: 0,
  reporter: 'list',
  projects: [
    { name: 'screens', testIgnore: ACCOUNTS, use: screen },
    { name: 'screens-accounts', testMatch: ACCOUNTS, use: { ...screen, baseURL: accountsUrl } },
  ],
  // Both builds, served from frontend/ (a web server otherwise starts in this config's folder).
  webServer: (Array.isArray(base.webServer) ? base.webServer : base.webServer ? [base.webServer] : []).map((s) => ({ ...s, cwd: fileURLToPath(new URL('..', import.meta.url)) })),
});
