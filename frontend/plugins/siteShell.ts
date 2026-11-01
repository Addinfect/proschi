import { dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerImport, type Plugin, type ResolvedConfig, type ViteDevServer } from 'vite';

// Not imported for its types: the node config's tsconfig has no JSX.
interface ShellModule {
  renderShell(slot: string, options: { base: string; current?: string }): string;
}

const SHELL = fileURLToPath(new URL('../src/design/shell.tsx', import.meta.url));
const PLACEHOLDER = /<!--shell:([a-z]+)-->/g;
const SLOTS = new Set(['header', 'footer']);
/** The page each top-level folder is, for the header's "you are here". */
const PAGES: Record<string, string> = { '': 'home', app: 'editor', practice: 'practice', docs: 'docs', blog: 'blog' };

/**
 * Static pages (the landing page, model/) carry <!--shell:header--> and
 * <!--shell:footer--> placeholders; this renders the same Header and Footer
 * React components the app and practice pages mount, into plain HTML at build
 * time (and on every request under `npm run dev`). Links are relative to the
 * page, so the build still works under any sub-path.
 */
export function siteShell(): Plugin {
  let config: ResolvedConfig;
  let server: ViteDevServer | undefined;
  let built: Promise<ShellModule> | undefined;

  const load = async (): Promise<ShellModule> => {
    // The dev server reloads the module when the components change; a build loads it once.
    if (server) return (await server.ssrLoadModule(SHELL)) as unknown as ShellModule;
    built ??= runnerImport<ShellModule>(SHELL, {
      configFile: false,
      root: config.root,
      logLevel: 'error',
      oxc: { jsx: { runtime: 'automatic' } },
    }).then((result) => result.module);
    return built;
  };

  return {
    name: 'proschi-site-shell',
    configResolved(resolved) {
      config = resolved;
    },
    configureServer(devServer) {
      server = devServer;
    },
    transformIndexHtml: {
      order: 'pre',
      async handler(html, ctx) {
        if (!html.includes('<!--shell:')) return html;
        const folder = relative(config.root, dirname(ctx.filename));
        const depth = folder ? folder.split(sep).length : 0;
        const base = depth ? '../'.repeat(depth) : './';
        // 404.html sits at the root but is no page of the header's.
        const current = /(^|[\\/])404\.html$/.test(ctx.filename) ? undefined : PAGES[folder.split(sep)[0]];
        const shell = await load();
        return html.replace(PLACEHOLDER, (_, slot: string) => {
          if (!SLOTS.has(slot)) throw new Error(`${ctx.filename}: unknown placeholder <!--shell:${slot}-->`);
          return shell.renderShell(slot, { base, current });
        });
      },
    },
  };
}
