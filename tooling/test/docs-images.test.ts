import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

// The docs' diagram images (docs/images/diagrams) are rendered from
// docs/images/src by `npm run docs:images` and committed. This re-renders them
// with the CLI that pretest just built and fails when one is stale.
it('the committed docs diagram images match their sources', () => {
  const script = fileURLToPath(new URL('../scripts/docs-images.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);
}, 60_000);
