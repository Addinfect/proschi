import { defineConfig, devices } from '@playwright/test';
import base from '../playwright.config';

/**
 * `npm run docs:screenshots`: retakes the editor screenshots in
 * docs/images/screens (docs-screenshots.screens.ts) against the production
 * build, at a fixed size in the light theme. Run by hand after a UI change,
 * never in CI; `npm run build` first.
 */
export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: '**/*.screens.ts',
  retries: 0,
  reporter: 'list',
  projects: [
    {
      name: 'screens',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 860 }, deviceScaleFactor: 1, colorScheme: 'light' },
    },
  ],
  webServer: Array.isArray(base.webServer) ? base.webServer[0] : base.webServer,
});
