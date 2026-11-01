import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join, posix } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { Plugin, Rollup, ViteDevServer } from 'vite'
import { REPO, SITE_ORIGIN, escapeHtml, readSite, renderMarkdown, type SiteConfig, type TocEntry } from './docsSite'

/**
 * The release blog (/blog/): Markdown posts in the repository's blog/ folder,
 * rendered at build time with the docs' Markdown (plugins/docsSite.ts), so
 * links to the docs and live ```proschi examples work the same, into pages in
 * the docs' layout:
 *
 * - blog/: every post, newest first (frontend/blog/index.html);
 * - blog/<slug>/: one post, from blog/<yyyy-mm-dd>-<slug>/index.md, copied from the
 *   template frontend/blog/_post/index.html, which is then dropped;
 * - blog/rss.xml: an RSS 2.0 feed of the posts.
 *
 * A post starts with YAML frontmatter: title, date (the folder name's),
 * description, version (the release, optional), audience and tags. Its
 * images (`![alt](<file>.svg)`, svg, png, jpg or webp) sit next to it in
 * its folder and are published next to its page. Posts are written with the
 * /blog-post skill (.claude/skills/blog-post/SKILL.md).
 */

export const POST_TEMPLATE = 'blog/_post/index.html'
const INDEX_PAGE = 'blog/index.html'
const PLACEHOLDER = /<!--blog:(head|page)-->/g
const FILE = /^(\d{4}-\d{2}-\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)\/index\.md$/
const IMAGE_TYPES = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp'])

export const BLOG_TITLE = 'Proschi blog'
export const BLOG_DESCRIPTION = 'What each Proschi release adds, the problem it solves, and how to try it.'
export const blogUrl = () => `${SITE_ORIGIN}blog/`
export const postUrl = (slug: string) => `${SITE_ORIGIN}blog/${slug}/`
export const feedUrl = () => `${SITE_ORIGIN}blog/rss.xml`

export interface Post {
  slug: string
  /** The file in blog/, e.g. 2026-10-31-terminal-diagrams/index.md. */
  file: string
  title: string
  /** yyyy-mm-dd. */
  date: string
  description: string
  version?: string
  audience: string
  tags: string[]
  body: string
}

export interface RenderedPost {
  post: Post
  /** The post's body. */
  html: string
  toc: TocEntry[]
  examples: string[]
  /** The images it shows: the file in the post's folder and the name it is published under, next to the page. */
  images: { from: string; name: string }[]
}

const isString = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/** Reads one post's frontmatter and body, checking every field. */
export function parsePost(file: string, text: string): Post {
  const name = FILE.exec(file)
  if (!name) throw new Error(`blog/${file}: put a post in blog/<yyyy-mm-dd>-<slug>/index.md, with a slug in lower case and dashes`)
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'))
  if (!m) throw new Error(`blog/${file}: starts with --- frontmatter ---`)
  const meta = (parseYaml(m[1]) ?? {}) as Record<string, unknown>
  const date = meta.date instanceof Date ? meta.date.toISOString().slice(0, 10) : meta.date
  const fail = (what: string) => new Error(`blog/${file}: ${what}`)
  for (const key of ['title', 'description', 'audience']) if (!isString(meta[key])) throw fail(`needs a ${key}`)
  if (date !== name[1]) throw fail(`the date (${String(date)}) is not the folder name's (${name[1]})`)
  if (meta.version !== undefined && !/^\d+\.\d+\.\d+$/.test(String(meta.version))) throw fail(`version ${String(meta.version)} is not x.y.z`)
  if (!Array.isArray(meta.tags) || meta.tags.length === 0 || !meta.tags.every(isString)) throw fail('needs tags, a list of words')
  const known = new Set(['title', 'date', 'description', 'version', 'audience', 'tags'])
  const unknown = Object.keys(meta).filter((k) => !known.has(k))
  if (unknown.length) throw fail(`unknown frontmatter ${unknown.join(', ')}`)
  if (/^# /m.test(m[2].replace(/```[\s\S]*?```/g, ''))) throw fail('the title is the frontmatter\'s; start the body at ##')
  return {
    slug: name[2],
    file,
    title: String(meta.title),
    date,
    description: String(meta.description),
    version: meta.version === undefined ? undefined : String(meta.version),
    audience: String(meta.audience),
    tags: (meta.tags as string[]).map(String),
    body: m[2],
  }
}

/** Every post in `blogDir`, newest first: one folder per post, with its index.md and its images. */
export function readPosts(blogDir: string): Post[] {
  if (!existsSync(blogDir)) return []
  const posts = readdirSync(blogDir)
    .filter((f) => f !== 'README.md' && !f.startsWith('.'))
    .map((f) => {
      if (!statSync(join(blogDir, f)).isDirectory()) throw new Error(`blog/${f}: a post and its images go in a folder, blog/<yyyy-mm-dd>-<slug>/`)
      const file = `${f}/index.md`
      if (!existsSync(join(blogDir, file))) throw new Error(`blog/${f}: has no index.md`)
      return parsePost(file, readFileSync(join(blogDir, file), 'utf8'))
    })
  const slugs = new Set<string>()
  for (const p of posts) {
    if (slugs.has(p.slug) || p.slug === 'rss') throw new Error(`blog/${p.file}: the slug "${p.slug}" is taken`)
    slugs.add(p.slug)
  }
  return posts.sort((a, b) => b.date.localeCompare(a.date) || (b.version ?? '').localeCompare(a.version ?? '', 'en', { numeric: true }) || a.slug.localeCompare(b.slug))
}

/** Renders a post's Markdown; its images must sit in the post's folder in `blogDir`. */
export function renderPost(site: SiteConfig, post: Post, blogDir?: string): RenderedPost {
  const images: RenderedPost['images'] = []
  const sourcePath = `blog/${post.file}`
  const image = (src: string): string => {
    const folder = posix.dirname(post.file)
    const repoPath = posix.normalize(posix.join('blog', folder, src))
    const name = basename(repoPath)
    const fail = (what: string) => new Error(`${sourcePath}: image ${src} ${what}`)
    if (/^[a-z]+:/i.test(src) || repoPath !== `blog/${folder}/${name}`) throw fail(`must be a file next to the post, in blog/${folder}/`)
    if (!IMAGE_TYPES.has(extname(name).toLowerCase())) throw fail(`is not one of ${[...IMAGE_TYPES].join(', ')}`)
    const from = blogDir ? join(blogDir, folder, name) : name
    if (blogDir && !existsSync(from)) throw fail('does not exist')
    if (!images.some((i) => i.name === name)) images.push({ from, name })
    return name
  }
  const { html, toc, examples } = renderMarkdown(post.body, { config: site, from: post.slug, sourcePath, docsRoot: '../../docs/', image })
  return { post, html, toc, examples, images }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** 2026-10-31 → 31 October 2026. */
export function longDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}

/** 2026-10-31 → Sat, 31 Oct 2026 00:00:00 GMT, RSS's date (RFC 822). */
export const rfc822 = (date: string): string => new Date(`${date}T00:00:00Z`).toUTCString()

const metaLine = (post: Post, version = true) =>
  `<p class="blog-meta"><time datetime="${post.date}">${longDate(post.date)}</time>${version && post.version ? ` · Release ${escapeHtml(post.version)}` : ''}</p>`

const tagList = (post: Post) => `<ul class="blog-tags" aria-label="Tags">${post.tags.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`

/** The sidebar: every post, and where to follow along. */
function navHtml(posts: Post[], current: string | undefined, toRoot: string): string {
  const toBlog = current === undefined ? './' : '../'
  const here = (slug: string | undefined) => (slug === current ? ' aria-current="page"' : '')
  const items = posts.map((p) => `<li><a class="docs-nav__link" href="${toBlog}${p.slug}/"${here(p.slug)}>${escapeHtml(p.title)}</a></li>`)
  return `<nav class="docs-nav" id="docs-nav" aria-label="Blog">
<div class="docs-nav__head"><span class="docs-nav__heading">Blog</span><a class="docs-drawer-close" href="#main" aria-label="Close the blog menu">×</a></div>
<div class="docs-nav__group">
<p class="docs-nav__title">Posts</p>
<ul>
<li><a class="docs-nav__link" href="${toBlog}"${here(undefined)}>All posts</a></li>
${items.join('\n')}
</ul>
</div>
<div class="docs-nav__group">
<p class="docs-nav__title">Follow</p>
<ul>
<li><a class="docs-nav__link" href="${toBlog}rss.xml">RSS feed</a></li>
<li><a class="docs-nav__link" href="https://github.com/${REPO}/blob/main/CHANGELOG.md">Changelog <span class="docs-nav__ext" aria-hidden="true">↗</span></a></li>
<li><a class="docs-nav__link" href="${toRoot}docs/">Docs</a></li>
</ul>
</div>
</nav>`
}

function tocHtml(toc: TocEntry[]): string {
  const items = toc.filter((e) => e.level === 2).map((e) => `<li><a href="#${e.id}" data-toc="${e.id}">${escapeHtml(e.text)}</a></li>`)
  return items.length ? `<ol class="toc__list">\n${items.join('\n')}\n</ol>` : ''
}

const drawerOpen = '<a class="docs-drawer-open" href="#docs-nav" aria-controls="docs-nav"><span class="docs-drawer-open__icon" aria-hidden="true"></span>Blog menu</a>'

/** One post's page content, around the shell placeholders. */
export function postPageHtml(rendered: RenderedPost, posts: Post[]): string {
  const { post } = rendered
  const i = posts.findIndex((p) => p.slug === post.slug)
  const toc = tocHtml(rendered.toc)
  const link = (p: Post | undefined, rel: 'prev' | 'next') =>
    p
      ? `<a class="pager__link pager__link--${rel}" href="../${p.slug}/" rel="${rel}"><span class="pager__dir">${rel === 'prev' ? 'Newer' : 'Older'}</span><span class="pager__title">${escapeHtml(p.title)}</span></a>`
      : '<span></span>'
  // The first paragraph is the lede, like the docs'.
  const body = rendered.html.replace(/^\s*<p>/, '<p class="lede">')
  return `<div class="docs blog" data-site-root="../../">
${drawerOpen}
${navHtml(posts, post.slug, '../../')}
<main id="main" class="docs-main" tabindex="-1">
<article class="doc blog-post">
${toc ? `<details class="toc-inline"><summary>On this page</summary>\n<nav aria-label="On this page">\n${toc}\n</nav>\n</details>\n` : ''}<header class="doc-hero">
<p class="kicker">${post.version ? `Release ${escapeHtml(post.version)}` : 'Blog'}</p>
<h1>${escapeHtml(post.title)}</h1>
${metaLine(post, false)}
<p class="blog-audience"><strong>For:</strong> ${escapeHtml(post.audience)}</p>
${tagList(post)}
</header>
<div class="doc-body">
${body}</div>
</article>
<p class="doc-edit"><a href="https://github.com/${REPO}/edit/main/blog/${post.file}" rel="noopener">Edit this post on GitHub</a> · <a href="../rss.xml">RSS feed</a></p>
<nav class="pager" aria-label="Newer and older posts">
${link(posts[i - 1], 'prev')}
${link(posts[i + 1], 'next')}
</nav>
</main>
${toc ? `<aside class="docs-toc">\n<nav class="toc" aria-label="On this page">\n<p class="toc__title">On this page</p>\n<div class="toc__progress" aria-hidden="true"><span></span></div>\n${toc}\n</nav>\n</aside>` : '<aside class="docs-toc"></aside>'}
</div>`
}

/** The index's page content: every post, newest first. */
export function indexPageHtml(posts: Post[]): string {
  const cards = posts.map(
    (p) => `<li class="blog-card">
${metaLine(p)}
<h2 class="blog-card__title"><a href="./${p.slug}/">${escapeHtml(p.title)}</a></h2>
<p class="blog-card__text">${escapeHtml(p.description)}</p>
${tagList(p)}
</li>`,
  )
  return `<div class="docs blog" data-site-root="../">
${drawerOpen}
${navHtml(posts, undefined, '../')}
<main id="main" class="docs-main" tabindex="-1">
<article class="doc">
<header class="doc-hero">
<p class="kicker">Blog</p>
<h1>What’s new in Proschi</h1>
<p class="lede">${escapeHtml(BLOG_DESCRIPTION)} Follow along with the <a href="./rss.xml">RSS feed</a>.</p>
</header>
${posts.length ? `<ol class="blog-list">\n${cards.join('\n')}\n</ol>` : '<p>No posts yet.</p>'}
</article>
</main>
<aside class="docs-toc"></aside>
</div>`
}

const feedLink = (href: string) => `<link rel="alternate" type="application/rss+xml" title="${BLOG_TITLE}" href="${href}" />`

function head(title: string, description: string, url: string, feed: string, extra: string[] = []): string {
  return [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}" />`,
    `<link rel="canonical" href="${url}" />`,
    feedLink(feed),
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="Proschi" />`,
    `<meta property="og:title" content="${escapeHtml(title.replace(/ · Proschi blog$/, ''))}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${SITE_ORIGIN}og.png" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    ...extra,
  ].join('\n    ')
}

export const indexHeadHtml = () => head(BLOG_TITLE, BLOG_DESCRIPTION, blogUrl(), './rss.xml')

export const postHeadHtml = (post: Post) =>
  head(`${post.title} · Proschi blog`, post.description, postUrl(post.slug), '../rss.xml', [`<meta property="article:published_time" content="${post.date}" />`])

const xml = (s: string): string => escapeHtml(s).replace(/'/g, '&apos;')

/** blog/rss.xml: RSS 2.0, newest first, with absolute links. */
export function rssXml(posts: Post[]): string {
  const items = posts.map(
    (p) => `    <item>
      <title>${xml(p.title)}</title>
      <link>${postUrl(p.slug)}</link>
      <guid isPermaLink="true">${postUrl(p.slug)}</guid>
      <pubDate>${rfc822(p.date)}</pubDate>
      <description>${xml(p.description)}</description>
${p.tags.map((t) => `      <category>${xml(t)}</category>`).join('\n')}
    </item>`,
  )
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${BLOG_TITLE}</title>
    <link>${blogUrl()}</link>
    <description>${xml(BLOG_DESCRIPTION)}</description>
    <language>en</language>
    <atom:link href="${feedUrl()}" rel="self" type="application/rss+xml" />
${posts.length ? `    <lastBuildDate>${rfc822(posts[0].date)}</lastBuildDate>\n` : ''}${items.join('\n')}
  </channel>
</rss>
`
}

/** The blog's URLs, for the sitemap: the index, then every post. */
export const blogUrls = (posts: Post[]): string[] => [blogUrl(), ...posts.map((p) => postUrl(p.slug))]

export const fillPost = (html: string, rendered: RenderedPost, posts: Post[]): string =>
  html.replace(PLACEHOLDER, (_, slot: string) => (slot === 'head' ? postHeadHtml(rendered.post) : postPageHtml(rendered, posts)))

export function blogSite({ blogDir, docsDir, stubsDir }: { blogDir: string; docsDir: string; stubsDir: string }): Plugin {
  let root = ''
  const load = () => {
    const site = readSite(docsDir)
    const posts = readPosts(blogDir)
    return { posts, rendered: posts.map((p) => renderPost(site, p, blogDir)) }
  }
  return {
    name: 'proschi-blog-site',
    config: () => ({ build: { rollupOptions: { input: { blogIndex: join(stubsDir, 'index.html'), blogPost: join(stubsDir, '_post', 'index.html') } } } }),
    configResolved(resolved) {
      root = resolved.root
    },
    transformIndexHtml: {
      // Before the shell goes around it, like the docs pages.
      order: 'pre',
      handler(html, ctx) {
        if (!html.includes('<!--blog:') || ctx.filename !== join(root, INDEX_PAGE)) return html
        const { posts } = load()
        return html.replace(PLACEHOLDER, (_, slot: string) => (slot === 'head' ? indexHeadHtml() : indexPageHtml(posts)))
      },
    },
    configureServer(server: ViteDevServer) {
      server.watcher.add(blogDir)
      server.watcher.on('change', (file) => {
        if (file.startsWith(blogDir)) server.ws.send({ type: 'full-reload' })
      })
      // `npm run dev`: /blog/rss.xml, /blog/<slug>/ and its images, as the build writes them.
      server.middlewares.use(async (req, res, next) => {
        const url = req.url?.split('?')[0] ?? ''
        if (url === '/blog/rss.xml') {
          res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8')
          res.end(rssXml(readPosts(blogDir)))
          return
        }
        const m = /^\/blog\/([a-z0-9-]+)\/(?:(index\.html)|([^/]+\.[a-z]+))?$/.exec(url)
        if (!m || m[1] === '_post') return next()
        try {
          const { posts, rendered } = load()
          const post = rendered.find((r) => r.post.slug === m[1])
          if (!post) return next()
          if (m[3]) {
            const img = post.images.find((i) => i.name === m[3])
            if (!img) return next()
            res.setHeader('Content-Type', extname(img.name) === '.svg' ? 'image/svg+xml' : `image/${extname(img.name).slice(1).replace('jpg', 'jpeg')}`)
            res.end(readFileSync(img.from))
            return
          }
          const html = await server.transformIndexHtml(req.url!, readFileSync(join(server.config.root, POST_TEMPLATE), 'utf8'), `/${POST_TEMPLATE}`)
          res.setHeader('Content-Type', 'text/html')
          res.end(fillPost(html, post, posts))
        } catch (e) {
          next(e)
        }
      })
    },
    generateBundle: {
      // After Vite's HTML plugin has written the template, with its assets linked.
      order: 'post',
      handler(_, bundle) {
        const template = bundle[POST_TEMPLATE] as Rollup.OutputAsset | undefined
        if (!template) return
        delete bundle[POST_TEMPLATE]
        const { posts, rendered } = load()
        for (const r of rendered) {
          this.emitFile({ type: 'asset', fileName: `blog/${r.post.slug}/index.html`, source: fillPost(String(template.source), r, posts) })
          for (const img of r.images) this.emitFile({ type: 'asset', fileName: `blog/${r.post.slug}/${img.name}`, source: readFileSync(img.from) })
        }
        this.emitFile({ type: 'asset', fileName: 'blog/rss.xml', source: rssXml(posts) })
      },
    },
  }
}
