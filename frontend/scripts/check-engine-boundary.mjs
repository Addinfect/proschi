#!/usr/bin/env node
/**
 * Guards the engine boundary (see src/engine/README.md).
 *
 * The engine must serve any subject matter, so a file under src/engine may only
 * import from inside that directory, and may not use the vocabulary of the thing
 * being modelled. This script lists both kinds of slip and exits non-zero when it
 * finds one.
 *
 * Run with `npm run check:engine-boundary`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../src/engine/', import.meta.url));

/**
 * Words the subject matter owns. Whole-word stems, so plurals and compounds follow.
 * Data-structure words are left out on purpose: a graph walk needs its `queue`, and
 * the point of the list is what a model is about, not how it is walked.
 */
const banned = [
  'client',
  'cdn',
  'cloud',
  'database',
  'db',
  'broker',
  'gateway',
  'loadbalancer',
  'server',
  'service',
  'latency',
  'throughput',
  'replica',
  'techstack',
  'kubernetes',
  'docker',
  'aws',
  'azure',
  'gcp',
  'proschi',
];

const words = new RegExp(`\\b(${banned.join('|')})`, 'i');

/** Anything that is not a relative import: a package, a path out of the directory. */
const outside = /from\s+['"](?!\.\/)/;

const files = readdirSync(root, { recursive: true })
  .map((name) => String(name))
  .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'));

const problems = [];
for (const name of files) {
  const path = join(root, name);
  // A test may bring its own runner; the engine it exercises may not.
  const tested = name.endsWith('.test.ts') || name.endsWith('.test.tsx');
  const lines = readFileSync(path, 'utf8').split('\n');
  lines.forEach((line, at) => {
    const where = `${relative(process.cwd(), path)}:${at + 1}`;
    if (!tested && outside.test(line)) {
      problems.push(`${where}: imports from outside the engine: ${line.trim()}`);
    }
    const found = words.exec(line);
    if (found) {
      problems.push(`${where}: names the subject matter ("${found[1]}"): ${line.trim()}`);
    }
  });
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error(`\n${problems.length} problem(s) with the engine boundary.`);
  process.exit(1);
}

console.log(`engine boundary: ${files.length} file(s), no problems.`);
