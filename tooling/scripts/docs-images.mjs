// Renders the docs' diagram images: each docs/images/src/<name>.proschi
// becomes docs/images/diagrams/<name>.svg, its architecture as
// `proschi render` draws it. A first line `# render: <flags>` passes flags
// (--expand orders). Folders under src/ hold files those sources use
// (team files) and are not rendered themselves.
//
//   npm run docs:images                       builds the CLI, (re)writes the SVGs
//   node scripts/docs-images.mjs --check      exits 1 when a committed SVG is stale
//                                             (test/docs-images.test.ts runs it)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const SOURCES = join(root, 'docs/images/src');
const DIAGRAMS = join(root, 'docs/images/diagrams');
const CLI = join(root, 'tooling/dist/cli.cjs');
const MAX_BYTES = 100_000;

function render(file) {
  const path = join(SOURCES, file);
  const flags = /^# render:(.*)$/.exec(readFileSync(path, 'utf8').split('\n')[0])?.[1].trim().split(/\s+/) ?? [];
  const dir = mkdtempSync(join(tmpdir(), 'proschi-docs-'));
  try {
    execFileSync(process.execPath, [CLI, 'render', '--out', dir, ...flags, path], { stdio: ['ignore', 'ignore', 'inherit'] });
    return readFileSync(join(dir, 'architecture.svg'), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const check = process.argv.includes('--check');
const sources = readdirSync(SOURCES).filter((f) => f.endsWith('.proschi')).sort();
const problems = [];
for (const file of sources) {
  const name = `${basename(file, '.proschi')}.svg`;
  const out = join(DIAGRAMS, name);
  const svg = render(file);
  if (Buffer.byteLength(svg) > MAX_BYTES) problems.push(`${name} is ${Buffer.byteLength(svg)} bytes, over ${MAX_BYTES}`);
  if (check) {
    if (!existsSync(out) || readFileSync(out, 'utf8') !== svg) problems.push(`docs/images/diagrams/${name} is stale`);
  } else {
    writeFileSync(out, svg);
    console.log(`docs/images/diagrams/${name} (${Math.round(Buffer.byteLength(svg) / 1024)} KB)`);
  }
}
for (const name of readdirSync(DIAGRAMS)) {
  if (!sources.includes(name.replace(/\.svg$/, '.proschi'))) problems.push(`docs/images/diagrams/${name} has no source in docs/images/src/`);
}
if (problems.length > 0) {
  console.error(`${problems.join('\n')}\nRun \`npm run docs:images\` in tooling and commit the result.`);
  process.exit(1);
}
