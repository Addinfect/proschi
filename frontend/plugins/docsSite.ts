import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, posix, relative, sep } from 'node:path'
import markdownIt, { type MarkdownIt, type Token } from 'markdown-it'
import type { Plugin, ResolvedConfig } from 'vite'
import { highlightLines } from '../src/landing/highlight'

/**
 * The docs section (/docs/): Markdown from the repository's docs/ folder,
 * rendered at build time into static pages with a sidebar, an "On this page"
 * list and live examples. docs/site.json lists the pages and the sidebar;
 * each page has a stub, frontend/docs/<slug>/index.html, whose
 * <!--docs:page--> and <!--docs:head--> this fills in.
 *
 * - Markdown is rendered with markdown-it with raw HTML off: the sources are
 *   ours, but the pages' CSP and the docs' GitHub rendering both prefer plain
 *   Markdown. A source ending in .html is a trusted fragment, kept as is.
 * - Headings get GitHub's anchors, so links written for GitHub keep working.
 * - Links between the Markdown files (GRAMMAR.md#productions), to
 *   https://proschi.app/… and to the GitHub copies of the docs become links
 *   within the site; links to other repository files go to GitHub.
 * - ```proschi fences become <figure data-live> with the code highlighted
 *   and its source in base64; src/docs/main.ts turns them into live
 *   diagrams. ```proschi fragment is highlighted only (a partial document).
 * - ```proschi annotated is a live example whose `# @note …` lines become
 *   notes on the line after them (splitAnnotations); the notes also render
 *   as a list under the code, for readers without JavaScript.
 * - A `> **Try it:**` blockquote right after a live example gets the class
 *   try-it, so it reads as a prompt attached to that example.
 * - `anchorRedirects` in site.json maps a page's old anchors to their new
 *   home; the page carries its map in data-anchor-redirects (main.ts follows it).
 * - An image alone in a paragraph, `![alt](images/x.svg "Caption")`, becomes
 *   a figure with its size, lazily loaded, and the title as its caption. It
 *   must be an .svg or .png under docs/images/, published at /docs/images/.
 */

export const REPO = 'gvart/proschi'
export const SITE_ORIGIN = 'https://proschi.app/'
const BLOB = `https://github.com/${REPO}/blob/main/`
const TREE = `https://github.com/${REPO}/tree/main/`

export interface DocPage {
  /** '' for the docs home. */
  slug: string
  title: string
  /** Relative to docs/. */
  source: string
  description: string
}

export interface NavItem {
  page?: string
  anchor?: string
  label?: string
  /** A path from the site root, or an absolute URL. */
  href?: string
}

export interface SiteConfig {
  pages: DocPage[]
  nav: { title: string; items: NavItem[] }[]
  /** Per page slug: an old anchor → where it lives now, relative to /docs/ (`hld/#traffic`, `scenarios/`). */
  anchorRedirects?: Record<string, Record<string, string>>
}

export interface TocEntry {
  level: 2 | 3
  id: string
  text: string
}

export interface RenderedPage {
  page: DocPage
  /** The article: hero and body. */
  article: string
  toc: TocEntry[]
  /** The source of every live example. */
  examples: string[]
  /** Every heading anchor. */
  anchors: Set<string>
  /** The images it shows, relative to docs/ (images/org.svg). */
  images: string[]
}

/** A docs image's size in CSS pixels: an SVG's width and height, a PNG's pixels (halved for name@2x.png). */
export function imageSize(file: string): { width: number; height: number } {
  if (file.endsWith('.svg')) {
    const root = /<svg\b[^>]*>/.exec(readFileSync(file, 'utf8'))?.[0] ?? ''
    const attr = (name: string) => Number(new RegExp(`\\s${name}="([\\d.]+)"`).exec(root)?.[1])
    const [, , w, h] = (/\sviewBox="([^"]+)"/.exec(root)?.[1] ?? '').trim().split(/[\s,]+/).map(Number)
    const width = attr('width') || w
    const height = attr('height') || h
    if (!width || !height) throw new Error(`${file}: the SVG needs a width and height or a viewBox`)
    return { width, height }
  }
  const png = readFileSync(file)
  const scale = file.endsWith('@2x.png') ? 2 : 1
  return { width: Math.round(png.readUInt32BE(16) / scale), height: Math.round(png.readUInt32BE(20) / scale) }
}

/** The way from a docs page to the site root, and to the docs root. */
export const toSiteRoot = (slug: string): string => (slug ? '../../' : '../')
const toDocsRoot = (slug: string): string => (slug ? '../' : './')

/** A link from one docs page to another (and an anchor on it). */
export function pageHref(from: string, to: string, anchor?: string): string {
  const path = from === to ? '' : toDocsRoot(from) + (to ? `${to}/` : '')
  return `${path}${anchor ? `#${anchor}` : ''}` || './'
}

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to dashes; repeats get -1, -2, … */
export function slugger(): (text: string) => string {
  const seen = new Map<string, number>()
  return (text) => {
    const base = text
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
      .replace(/\s/g, '-')
    const n = seen.get(base)
    seen.set(base, (n ?? -1) + 1)
    return n === undefined ? base : `${base}-${n + 1}`
  }
}

/** Highlighted HTML of a Proschi snippet, one span.line per line, like src/landing/highlight.ts does in the browser. `attrs` adds attributes to a line (0-based). */
export function highlightProschi(source: string, attrs?: (line: number) => string): string {
  return highlightLines(source.split('\n'))
    .map((segments, i) => {
      const html = segments.map((s) => (s.cls ? `<span class="tok-${s.cls}">${escapeHtml(s.text)}</span>` : escapeHtml(s.text))).join('')
      return `<span class="line"${attrs?.(i) ?? ''}>${html}</span>`
    })
    .join('\n')
}

export interface Annotation {
  /** 1-based line of the annotated code (after the note lines are removed). */
  line: number
  text: string
}

const NOTE_PREFIX = '# @note '

/**
 * The code and notes of a ```proschi annotated fence: a `# @note …` line
 * annotates the next line that is neither blank nor a note, consecutive notes
 * join with spaces, and every note line is removed from the code.
 */
export function splitAnnotations(source: string, where = 'annotated example'): { code: string; notes: Annotation[] } {
  const code: string[] = []
  const notes: Annotation[] = []
  let pending: string[] = []
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith(NOTE_PREFIX)) pending.push(trimmed.slice(NOTE_PREFIX.length).trim())
    else {
      if (trimmed && pending.length > 0) {
        notes.push({ line: code.length + 1, text: pending.join(' ') })
        pending = []
      }
      code.push(line)
    }
  }
  if (pending.length > 0) throw new Error(`${where}: the note "${pending.join(' ')}" annotates nothing (no line follows it)`)
  if (notes.length === 0) throw new Error(`${where}: an annotated example needs at least one # @note line`)
  return { code: code.join('\n'), notes }
}

/** A note's text: plain, with `backticks` as code. */
const noteHtml = (text: string): string =>
  text
    .split(/(`[^`]+`)/)
    .map((part) => (/^`[^`]+`$/.test(part) ? `<code>${escapeHtml(part.slice(1, -1))}</code>` : escapeHtml(part)))
    .join('')

function annotatedFigure(source: string, where: string): { html: string; code: string } {
  const { code, notes } = splitAnnotations(source, where)
  const lines = code.split('\n')
  const index = new Map(notes.map((n, i) => [n.line - 1, i]))
  const pre = `<pre class="code code--proschi" data-lang="proschi" tabindex="0"><code>${highlightProschi(code, (i) => (index.has(i) ? ` data-note="${index.get(i)}"` : ''))}</code></pre>`
  const items = notes
    .map((n, i) => `<li data-note="${i}"><code class="annotated__src">${escapeHtml(lines[n.line - 1].trim())}</code> <span class="annotated__text">${noteHtml(n.text)}</span></li>`)
    .join('\n')
  const html = `<figure class="live live--annotated" data-live data-annotated data-source="${base64(code)}">
<div class="annotated__code">
${pre}
<ol class="annotated__notes" aria-label="Notes on the example">
${items}
</ol>
</div>
</figure>
`
  return { html, code }
}

const base64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

export interface LinkContext {
  config: SiteConfig
  /** The page being rendered. */
  from: string
  /** Its source, relative to the repository root, e.g. docs/LANGUAGE.md. */
  sourcePath: string
  /** For a page outside /docs/ (the blog): its way to the docs root, e.g. '../../docs/'. Links to docs pages then start there. */
  docsRoot?: string
  /** For a page that may show images (the blog): the src to publish an image at, given its src in the source. Without it, an image is an error. */
  image?: (src: string) => string
  /** For a docs page: docs/ on disk, where its images are read from (under images/). It collects them in `images`. */
  docsImages?: { docsDir: string; images: string[] }
}

/** A docs page's image: checked, sized and collected; its src on the page. */
function docsImage(src: string, ctx: LinkContext, docs: NonNullable<LinkContext['docsImages']>): { src: string; width: number; height: number } {
  const path = posix.normalize(src)
  const fail = (what: string) => new Error(`${ctx.sourcePath}: image ${src} ${what}`)
  if (/^[a-z]+:/i.test(src) || !path.startsWith('images/')) throw fail('must be a file under docs/images/')
  if (!/\.(svg|png)$/.test(path)) throw fail('must be an .svg or a .png')
  const file = join(docs.docsDir, path)
  if (!existsSync(file)) throw fail('does not exist')
  if (!docs.images.includes(path)) docs.images.push(path)
  return { src: toDocsRoot(ctx.from) + path, ...imageSize(file) }
}

/** Repository path (docs/LANGUAGE.md) → page slug. */
function sourceSlugs(config: SiteConfig): Map<string, string> {
  return new Map(config.pages.map((p) => [posix.normalize(posix.join('docs', p.source)), p.slug]))
}

/** Where a link in a page's source goes on the site. */
export function rewriteHref(href: string, ctx: LinkContext): string {
  if (!href || href.startsWith('#')) return href
  const slugs = sourceSlugs(ctx.config)
  const [path, anchor] = splitAnchor(href)
  const local = (repoPath: string): string | undefined => {
    const slug = slugs.get(posix.normalize(repoPath))
    return slug === undefined ? undefined : docsHref(slug)
  }
  const docsHref = (slug: string): string =>
    ctx.docsRoot === undefined ? pageHref(ctx.from, slug, anchor) : `${ctx.docsRoot}${slug ? `${slug}/` : ''}${anchor ? `#${anchor}` : ''}`

  if (path.startsWith(SITE_ORIGIN)) {
    const sitePath = path.slice(SITE_ORIGIN.length)
    // The model page moved into the docs; model/ only forwards there.
    const docsSlug = sitePath === 'model/' ? 'model' : /^docs\/(.*?)\/?$/.exec(sitePath)?.[1]
    if (docsSlug !== undefined && ctx.config.pages.some((p) => p.slug === docsSlug)) return docsHref(docsSlug)
    return toSiteRoot(ctx.from) + sitePath + (anchor ? `#${anchor}` : '')
  }
  if (path.startsWith(BLOB)) return local(path.slice(BLOB.length)) ?? href
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return href

  // Relative to the source file, within the repository.
  const repoPath = posix.normalize(posix.join(posix.dirname(ctx.sourcePath), path))
  if (repoPath.startsWith('..')) throw new Error(`${ctx.sourcePath}: link ${href} leaves the repository`)
  const github = path.endsWith('/') ? `${TREE}${repoPath.replace(/\/$/, '')}/` : `${BLOB}${repoPath}`
  return local(repoPath) ?? `${github}${anchor ? `#${anchor}` : ''}`
}

function splitAnchor(href: string): [string, string | undefined] {
  const i = href.indexOf('#')
  return i < 0 ? [href, undefined] : [href.slice(0, i), href.slice(i + 1)]
}

const textOf = (tokens: Token[] | null): string => (tokens ?? []).map((t) => (t.type === 'text' || t.type === 'code_inline' ? t.content : textOf(t.children))).join('')

function markdown(ctx: LinkContext, toc: TocEntry[], examples: string[]): MarkdownIt {
  const md = markdownIt({ html: false, linkify: false, typographer: false })
  const slug = slugger()

  // Anchors on every heading; h2 and h3 go into "On this page".
  md.core.ruler.push('proschi_headings', (state) => {
    const tokens = state.tokens
    for (let i = 0; i < tokens.length; i++) {
      const open = tokens[i]
      if (open.type !== 'heading_open') continue
      const text = textOf(tokens[i + 1].children)
      const id = slug(text)
      open.attrSet('id', id)
      const level = Number(open.tag.slice(1))
      if (level === 2 || level === 3) toc.push({ level, id, text })
    }
  })

  md.renderer.rules.heading_close = (tokens, idx) => {
    const tag = tokens[idx].tag
    if (tag === 'h1') return '</h1>\n'
    const id = tokens[idx - 2].attrGet('id')
    return ` <a class="doc-anchor" href="#${id}" aria-label="Link to this section">#</a></${tag}>\n`
  }

  const defaultLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const href = rewriteHref(String(token.attrGet('href') ?? ''), ctx)
    token.attrSet('href', href)
    if (/^https?:/.test(href)) token.attrSet('rel', 'noopener')
    return defaultLink(tokens, idx, options, env, self)
  }

  // A docs image alone in its paragraph is a figure, its title the caption.
  const figure = (inline: Token | undefined) => {
    const kids = (inline?.children ?? []).filter((t) => !(t.type === 'text' && t.content.trim() === '') && t.type !== 'softbreak')
    return kids.length === 1 && kids[0].type === 'image' ? kids[0] : undefined
  }
  const defaultParagraphOpen = md.renderer.rules.paragraph_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
  const defaultParagraphClose = md.renderer.rules.paragraph_close ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.paragraph_open = (tokens, idx, options, env, self) =>
    ctx.docsImages && figure(tokens[idx + 1]) ? '<figure class="doc-figure">' : defaultParagraphOpen(tokens, idx, options, env, self)
  md.renderer.rules.paragraph_close = (tokens, idx, options, env, self) => {
    const img = ctx.docsImages ? figure(tokens[idx - 1]) : undefined
    if (!img) return defaultParagraphClose(tokens, idx, options, env, self)
    const caption = String(img.attrGet('title') ?? '')
    return `${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ''}</figure>\n`
  }

  md.renderer.rules.image = (tokens, idx) => {
    const token = tokens[idx]
    if (ctx.docsImages) {
      const alt = textOf(token.children)
      if (!alt) throw new Error(`${ctx.sourcePath}: image ${token.attrGet('src')} needs alt text`)
      const img = docsImage(String(token.attrGet('src') ?? ''), ctx, ctx.docsImages)
      return `<img src="${escapeHtml(img.src)}" alt="${escapeHtml(alt)}" width="${img.width}" height="${img.height}" loading="lazy" decoding="async" />`
    }
    if (ctx.image) return `<img src="${escapeHtml(ctx.image(String(token.attrGet('src') ?? '')))}" alt="${escapeHtml(textOf(token.children))}" loading="lazy" />`
    throw new Error(`${ctx.sourcePath}: images are not supported on the site (${tokens[idx].attrGet('src')})`)
  }

  // A "> **Try it:** …" right after a live example is that example's prompt.
  md.core.ruler.push('proschi_try_it', (state) => {
    const tokens = state.tokens
    for (let i = 1; i < tokens.length; i++) {
      const prev = tokens[i - 1]
      if (tokens[i].type !== 'blockquote_open' || prev.type !== 'fence') continue
      const [lang, ...flags] = prev.info.trim().split(/\s+/)
      if (lang !== 'proschi' || flags.includes('fragment')) continue
      const first = (tokens[i + 2]?.children ?? []).filter((t) => t.type !== 'text' || t.content !== '')
      if (first[0]?.type === 'strong_open' && first[1]?.content === 'Try it:') tokens[i].attrSet('class', 'try-it')
    }
  })

  md.renderer.rules.table_open = () => '<div class="table-wrap" tabindex="0">\n<table>\n'
  md.renderer.rules.table_close = () => '</table>\n</div>\n'

  md.renderer.rules.fence = (tokens, idx) => {
    const [lang = '', ...flags] = tokens[idx].info.trim().split(/\s+/)
    const source = tokens[idx].content.replace(/\n$/, '')
    if (lang !== 'proschi') {
      const label = lang ? ` data-lang="${escapeHtml(lang)}"` : ''
      return `<pre class="code"${label} tabindex="0"><code>${escapeHtml(source)}</code></pre>\n`
    }
    const pre = `<pre class="code code--proschi" data-lang="proschi" tabindex="0"><code>${highlightProschi(source)}</code></pre>`
    if (flags.includes('annotated')) {
      if (flags.includes('fragment')) throw new Error(`${ctx.sourcePath}: a proschi fence cannot be both annotated and a fragment`)
      const { html, code } = annotatedFigure(source, `${ctx.sourcePath}, line ${(tokens[idx].map?.[0] ?? 0) + 1}`)
      examples.push(code)
      return html
    }
    if (flags.includes('fragment')) return `${pre}\n`
    examples.push(source)
    return `<figure class="live" data-live data-source="${base64(source)}">\n${pre}\n</figure>\n`
  }
  return md
}

/** Markdown rendered like a docs page's (anchors, links, live examples), for pages outside /docs/ (plugins/blogSite.ts). */
export function renderMarkdown(source: string, ctx: LinkContext): { html: string; toc: TocEntry[]; examples: string[] } {
  const toc: TocEntry[] = []
  const examples: string[] = []
  const html = markdown(ctx, toc, examples).render(source)
  return { html, toc, examples }
}

/** The first heading of a fragment or a Markdown file is the page's h1; this takes it out. */
function splitTitle(html: string): { h1: string; body: string } {
  const m = /<h1\b[^>]*>([\s\S]*?)<\/h1>\n?/.exec(html)
  if (!m) return { h1: '', body: html }
  return { h1: m[1], body: html.slice(0, m.index) + html.slice(m.index + m[0].length) }
}

const decodeEntities = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, '\u00a0').replace(/&amp;/g, '&')

const stripTags = (s: string): string =>
  decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()

/** Renders one page's article from its source text. */
export function renderPage(config: SiteConfig, page: DocPage, source: string, docsDir?: string): RenderedPage {
  const sourcePath = posix.normalize(posix.join('docs', page.source))
  const toc: TocEntry[] = []
  const examples: string[] = []
  const images: string[] = []
  const group = config.nav.find((g) => g.items.some((i) => i.page === page.slug && !i.anchor))?.title ?? 'Docs'
  let article: string

  if (page.source.endsWith('.html')) {
    // A trusted fragment with its own hero (model.html).
    // Its Proschi snippets are highlighted here, like the Markdown's.
    const body = source
      .replace(/<!--[\s\S]*?-->\n?/g, '')
      .replace(/(<pre\b[^>]*\bdata-proschi\b[^>]*><code>)([\s\S]*?)(<\/code><\/pre>)/g, (_, open: string, code: string, close: string) => open + highlightProschi(decodeEntities(code)) + close)
    article = `<div class="doc-html">\n${body}</div>\n`
    for (const m of article.matchAll(/<h([23])\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g)) {
      toc.push({ level: Number(m[1]) as 2 | 3, id: m[2], text: stripTags(m[3]) })
    }
  } else {
    const docsImages = docsDir === undefined ? undefined : { docsDir, images }
    const html = markdown({ config, from: page.slug, sourcePath, docsImages }, toc, examples).render(source)
    const { h1, body } = splitTitle(html)
    // The paragraph right after the title is the lede.
    const lede = body.replace(/^\s*<p>/, '<p class="lede">')
    article = `<header class="doc-hero">\n<p class="kicker">${escapeHtml(group)}</p>\n<h1>${h1 || escapeHtml(page.title)}</h1>\n</header>\n<div class="doc-body">\n${lede}</div>\n`
  }

  const anchors = new Set([...article.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))
  return { page, article, toc, examples, anchors, images }
}

function navHtml(config: SiteConfig, current: string): string {
  const groups = config.nav.map((group) => {
    const items = group.items.map((item) => {
      if (item.page !== undefined) {
        const page = config.pages.find((p) => p.slug === item.page)
        if (!page) throw new Error(`docs/site.json: the sidebar names an unknown page "${item.page}"`)
        const href = item.anchor ? pageHref(current, page.slug, item.anchor) : pageHref(current, page.slug)
        const here = !item.anchor && page.slug === current ? ' aria-current="page"' : ''
        const cls = item.anchor ? 'docs-nav__link docs-nav__link--sub' : 'docs-nav__link'
        return `<li><a class="${cls}" href="${escapeHtml(href)}"${here}>${escapeHtml(item.label ?? page.title)}</a></li>`
      }
      if (!item.href || !item.label) throw new Error('docs/site.json: a sidebar link needs an href and a label')
      const external = /^[a-z]+:/i.test(item.href)
      const href = external ? item.href : toSiteRoot(current) + item.href
      const mark = external ? ' <span class="docs-nav__ext" aria-hidden="true">↗</span>' : ''
      return `<li><a class="docs-nav__link" href="${escapeHtml(href)}">${escapeHtml(item.label)}${mark}</a></li>`
    })
    return `<div class="docs-nav__group">\n<p class="docs-nav__title">${escapeHtml(group.title)}</p>\n<ul>\n${items.join('\n')}\n</ul>\n</div>`
  })
  return groups.join('\n')
}

function tocHtml(toc: TocEntry[]): string {
  // A single entry is no table of contents: the page goes without one.
  if (toc.length < 2) return ''
  const items: string[] = []
  let open = false
  for (const entry of toc) {
    // The list numbers its entries, so a heading's own "1. " is left out here.
    const link = `<a href="#${entry.id}" data-toc="${entry.id}">${escapeHtml(entry.text.replace(/^\d+\.\s+/, ''))}</a>`
    if (entry.level === 2) {
      if (open) items.push('</ol></li>')
      open = false
      items.push(`<li>${link}`)
      const next = toc[toc.indexOf(entry) + 1]
      if (next?.level === 3) {
        items.push('<ol>')
        open = true
      } else items.push('</li>')
    } else if (open) items.push(`<li>${link}</li>`)
    else items.push(`<li class="toc__sub">${link}</li>`)
  }
  if (open) items.push('</ol></li>')
  return `<ol class="toc__list">\n${items.join('\n')}\n</ol>`
}

/** The reading order: the sidebar's pages from top to bottom, then any page it leaves out. Previous / next follow it. */
export function readingOrder(config: SiteConfig): DocPage[] {
  const slugs = new Set(config.nav.flatMap((g) => g.items.flatMap((i) => (i.page !== undefined ? [i.page] : []))))
  const bySlug = new Map(config.pages.map((p) => [p.slug, p]))
  const inNav = [...slugs].flatMap((s) => bySlug.get(s) ?? [])
  return [...inNav, ...config.pages.filter((p) => !slugs.has(p.slug))]
}

function pagerHtml(config: SiteConfig, page: DocPage): string {
  const order = readingOrder(config)
  const i = order.indexOf(page)
  const link = (p: DocPage | undefined, rel: 'prev' | 'next') =>
    p
      ? `<a class="pager__link pager__link--${rel}" href="${pageHref(page.slug, p.slug)}" rel="${rel}"><span class="pager__dir">${rel === 'prev' ? 'Previous' : 'Next'}</span><span class="pager__title">${escapeHtml(p.title)}</span></a>`
      : '<span></span>'
  return `<nav class="pager" aria-label="Previous and next page">\n${link(order[i - 1], 'prev')}\n${link(order[i + 1], 'next')}\n</nav>`
}

/** The page's body content: sidebar, article, "On this page" and pager, around the shell placeholders. */
export function layoutHtml(config: SiteConfig, rendered: RenderedPage): string {
  const { page } = rendered
  const toc = tocHtml(rendered.toc)
  const repoPath = posix.normalize(posix.join('docs', page.source))
  const edit = page.source.endsWith('.md') ? `https://github.com/${REPO}/edit/main/${repoPath}` : `${BLOB}${repoPath}`
  const redirects = config.anchorRedirects?.[page.slug]
  const redirectAttr = redirects && Object.keys(redirects).length > 0 ? ` data-anchor-redirects="${escapeHtml(JSON.stringify(redirects))}"` : ''
  return `<div class="docs" data-site-root="${toSiteRoot(page.slug)}"${redirectAttr}>
<a class="docs-drawer-open" href="#docs-nav" aria-controls="docs-nav"><span class="docs-drawer-open__icon" aria-hidden="true"></span>Docs menu</a>
<nav class="docs-nav" id="docs-nav" aria-label="Docs">
<div class="docs-nav__head"><span class="docs-nav__heading">Docs</span><a class="docs-drawer-close" href="#main" aria-label="Close the docs menu">×</a></div>
${navHtml(config, page.slug)}
</nav>
<main id="main" class="docs-main" tabindex="-1">
<article class="doc">
${toc ? `<details class="toc-inline"><summary>On this page</summary>\n<nav aria-label="On this page">\n${toc}\n</nav>\n</details>\n` : ''}${rendered.article}
</article>
<p class="doc-edit"><a href="${edit}" rel="noopener">${page.source.endsWith('.md') ? 'Edit this page on GitHub' : 'View the source on GitHub'}</a></p>
${pagerHtml(config, page)}
</main>
${toc ? `<aside class="docs-toc">\n<nav class="toc" aria-label="On this page">\n<p class="toc__title">On this page</p>\n<div class="toc__progress" aria-hidden="true"><span></span></div>\n${toc}\n</nav>\n</aside>` : '<aside class="docs-toc"></aside>'}
</div>`
}

export function headHtml(page: DocPage): string {
  const url = `${SITE_ORIGIN}docs/${page.slug ? `${page.slug}/` : ''}`
  // The home page's title names the product already.
  const title = page.slug ? `${page.title} · Proschi docs` : page.title
  return [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(page.description)}" />`,
    `<link rel="canonical" href="${url}" />`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="Proschi" />`,
    `<meta property="og:title" content="${escapeHtml(page.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(page.description)}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${SITE_ORIGIN}og.png" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
  ].join('\n    ')
}

export function readSite(docsDir: string): SiteConfig {
  return JSON.parse(readFileSync(join(docsDir, 'site.json'), 'utf8')) as SiteConfig
}

export function renderFromDisk(docsDir: string, config: SiteConfig, page: DocPage): RenderedPage {
  return renderPage(config, page, readFileSync(join(docsDir, page.source), 'utf8'), docsDir)
}

/** The stub pages under `stubsDir` (frontend/docs), as rollup inputs: docs, docs/quickstart, … */
export function stubInputs(stubsDir: string): Record<string, string> {
  const inputs: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (name === 'index.html') inputs[relative(dirname(stubsDir), dir).split(sep).join('/')] = path
    }
  }
  if (existsSync(stubsDir)) walk(stubsDir)
  return inputs
}

const PLACEHOLDER = /<!--docs:(page|head)-->/g

export function docsSite({ docsDir, stubsDir }: { docsDir: string; stubsDir: string }): Plugin {
  let config: ResolvedConfig
  return {
    name: 'proschi-docs-site',
    config: () => ({ build: { rollupOptions: { input: stubInputs(stubsDir) } } }),
    configResolved(resolved) {
      config = resolved
    },
    configureServer(server) {
      // Edits to the Markdown reload the open docs page.
      server.watcher.add(docsDir)
      server.watcher.on('change', (file) => {
        if (file.startsWith(docsDir) || file.endsWith('model.html')) server.ws.send({ type: 'full-reload' })
      })
      // `npm run dev`: the pages' images, as the build publishes them.
      server.middlewares.use((req, res, next) => {
        const m = /^\/docs\/(images\/[\w/.@-]+\.(svg|png))$/.exec(req.url?.split('?')[0] ?? '')
        const file = m && !m[1].includes('..') ? join(docsDir, m[1]) : undefined
        if (!file || !existsSync(file)) return next()
        res.setHeader('Content-Type', m![2] === 'svg' ? 'image/svg+xml' : 'image/png')
        res.end(readFileSync(file))
      })
    },
    generateBundle() {
      const site = readSite(docsDir)
      const images = new Set(site.pages.flatMap((p) => renderFromDisk(docsDir, site, p).images))
      for (const path of images) this.emitFile({ type: 'asset', fileName: `docs/${path}`, source: readFileSync(join(docsDir, path)) })
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (!html.includes('<!--docs:')) return html
        const folder = relative(stubsDir, dirname(ctx.filename)).split(sep).join('/')
        const site = readSite(docsDir)
        const page = site.pages.find((p) => p.slug === folder)
        if (!page) throw new Error(`${relative(config.root, ctx.filename)}: no page with slug "${folder}" in docs/site.json`)
        const rendered = renderFromDisk(docsDir, site, page)
        return html.replace(PLACEHOLDER, (_, slot: string) => (slot === 'head' ? headHtml(page) : layoutHtml(site, rendered)))
      },
    },
  }
}
