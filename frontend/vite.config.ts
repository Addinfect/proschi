import { fileURLToPath } from 'node:url'
import { defineConfig, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import { practiceListings } from './plugins/practiceListings'
import { practiceCards } from './plugins/practiceCards'
import { practicePages } from './plugins/practicePages'
import { cardPages } from './plugins/cardPages'
import { siteShell } from './plugins/siteShell'
import { docsSite } from './plugins/docsSite'
import { blogSite } from './plugins/blogSite'
import { sitemap } from './plugins/sitemap'

// `ANALYZE=1 npx vite build` also writes dist/stats.html, a treemap of every chunk.
async function analyzer(): Promise<PluginOption> {
  if (!process.env.ANALYZE) return null
  const { visualizer } = await import('rollup-plugin-visualizer')
  return visualizer({ filename: 'dist/stats.html', gzipSize: true, template: 'treemap' }) as PluginOption
}

// Libraries in chunks of their own, named for what they are, so pages share
// them and an app update does not invalidate them.
const VENDOR_CHUNKS: [string, RegExp][] = [
  ['react', /\/node_modules\/(react|react-dom|scheduler)\//],
  ['codemirror', /\/node_modules\/(@codemirror|@lezer|codemirror|@marijn|crelt|style-mod|w3c-keyname)\//],
  ['html-to-image', /\/node_modules\/html-to-image\//],
  ['reactflow', /\/node_modules\/(reactflow|@reactflow|d3-[a-z]+|zustand|classcat|use-sync-external-store)\//],
]

function manualChunks(id: string): string | undefined {
  return VENDOR_CHUNKS.find(([, pattern]) => pattern.test(id))?.[0]
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    react(),
    practiceListings(fileURLToPath(new URL('./src/practice/problems', import.meta.url))),
    // ogImages: each problem's and card topic's Open Graph image, drawn at build time (plugins/ogImages.ts).
    practicePages(fileURLToPath(new URL('./src/practice/problems', import.meta.url)), { ogImages: true }),
    practiceCards(fileURLToPath(new URL('./src/practice/cards', import.meta.url))),
    cardPages(fileURLToPath(new URL('./src/practice/cards', import.meta.url)), fileURLToPath(new URL('./src/practice/problems', import.meta.url)), { ogImages: true }),
    // Before siteShell: the docs pages' layout goes in first, the header and footer around it.
    docsSite({
      docsDir: fileURLToPath(new URL('../docs', import.meta.url)),
      stubsDir: fileURLToPath(new URL('./docs', import.meta.url)),
    }),
    // The release blog (blog/ at the repository root), in the docs' layout; also before siteShell.
    blogSite({
      blogDir: fileURLToPath(new URL('../blog', import.meta.url)),
      docsDir: fileURLToPath(new URL('../docs', import.meta.url)),
      stubsDir: fileURLToPath(new URL('./blog', import.meta.url)),
    }),
    siteShell(),
    sitemap(fileURLToPath(new URL('../docs', import.meta.url)), fileURLToPath(new URL('./src/practice/problems', import.meta.url))),
    await analyzer(),
  ],
  // Relative asset paths so the build works under any sub-path,
  // e.g. https://<user>.github.io/proschi/ on GitHub Pages.
  base: './',
  build: {
    // Fonts stay files: the static pages' CSP allows fonts from 'self' only, not data: URLs.
    assetsInlineLimit: (file: string) => (/\.woff2?$/.test(file) ? false : undefined),
    rollupOptions: {
      // The landing page at the root, the editor under app/, system design
      // practice under practice/ (and a page per problem), model/, which forwards to the
      // docs, embed/ (a diagram for other sites' iframes), admin/ and 404.html.
      // docsSite adds the docs pages (docs/**/index.html), blogSite the blog's (blog/index.html and the post template).
      input: {
        landing: fileURLToPath(new URL('./index.html', import.meta.url)),
        app: fileURLToPath(new URL('./app/index.html', import.meta.url)),
        practice: fileURLToPath(new URL('./practice/index.html', import.meta.url)),
        model: fileURLToPath(new URL('./model/index.html', import.meta.url)),
        notFound: fileURLToPath(new URL('./404.html', import.meta.url)),
        // The template of each problem's page, practice/<id>/ (plugins/practicePages.ts).
        problemPage: fileURLToPath(new URL('./practice/problem/index.html', import.meta.url)),
        // The admin panel (src/admin/main.tsx; backend/README.md "Admin panel"), noindex.
        admin: fileURLToPath(new URL('./admin/index.html', import.meta.url)),
        // The read-only diagram other sites frame (src/embed/main.tsx).
        embed: fileURLToPath(new URL('./embed/index.html', import.meta.url)),
        // The review cards' index, and the templates of each topic's and card's page (plugins/cardPages.ts).
        cardsIndex: fileURLToPath(new URL('./practice/cards/index.html', import.meta.url)),
        cardTopicPage: fileURLToPath(new URL('./practice/cards/_topic/index.html', import.meta.url)),
        cardPage: fileURLToPath(new URL('./practice/cards/_topic/_card/index.html', import.meta.url)),
      },
      output: { manualChunks },
    },
  },
}))
