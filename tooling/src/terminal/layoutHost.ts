/**
 * The Claude Code plugin's layout helper (plugin/hooks/layout.cjs): reads a
 * document as JSON (`{ source, path?, imports?, view? }`) on stdin and writes the
 * browser's ELK layout of it as JSON on stdout. ELK is too large for a hooks
 * module (1 MiB per file), so the hooks run it in Node through this.
 */
import { layoutGraph } from '../../../frontend/src/dsl/autoLayout';
import { viewSource, type Source } from './document';

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Source;
  const { diagram } = viewSource(input);
  process.stdout.write(JSON.stringify(await layoutGraph(diagram)));
}

main().catch((error: unknown) => {
  process.stderr.write(String(error instanceof Error ? error.message : error));
  process.exitCode = 1;
});
