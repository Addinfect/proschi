import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import markdownIt from 'markdown-it'
import { describe, expect, it } from 'vitest'
import { parse } from '../src/dsl/parser'
import { runTests } from '../src/sim/tests'
import { headHtml, layoutHtml, pageHref, readingOrder, readSite, renderFromDisk, renderPage, rewriteHref, slugger, splitAnnotations, stubInputs, type RenderedPage, type SiteConfig } from './docsSite'

/**
 * The docs section: every page in docs/site.json has a stub and renders,
 * every link between pages and every anchor resolves, and every live example
 * is a complete document that parses without a single diagnostic.
 */

const docsDir = new URL('../../docs/', import.meta.url).pathname
const stubsDir = new URL('../docs/', import.meta.url).pathname
const site = readSite(docsDir)
const rendered = new Map<string, RenderedPage>(site.pages.map((p) => [p.slug, renderFromDisk(docsDir, site, p)]))
const stubPath = (slug: string) => `${stubsDir}${slug ? `${slug}/` : ''}index.html`

/** The docs page a relative href from page `from` lands on, and its anchor; undefined when it leaves /docs/. */
function target(from: string, href: string): { slug: string; anchor?: string } | undefined {
  const url = new URL(href, `https://x/docs/${from ? `${from}/` : ''}`)
  if (url.host !== 'x' || !url.pathname.startsWith('/docs/')) return undefined
  return { slug: url.pathname.slice('/docs/'.length).replace(/\/$/, ''), anchor: url.hash ? url.hash.slice(1) : undefined }
}

describe('docs/site.json', () => {
  it('has a stub per page and a page per stub', () => {
    for (const page of site.pages) expect(existsSync(stubPath(page.slug)), stubPath(page.slug)).toBe(true)
    expect(Object.keys(stubInputs(stubsDir)).sort()).toEqual(site.pages.map((p) => (p.slug ? `docs/${p.slug}` : 'docs')).sort())
  })

  it.each(site.pages.map((p) => [p.slug || '(home)', p.slug]))('%s: the stub has the placeholders, the shell and a strict script policy', (_, slug) => {
    const html = readFileSync(stubPath(slug), 'utf8')
    for (const slot of ['<!--docs:head-->', '<!--docs:page-->', '<!--shell:header-->', '<!--shell:footer-->']) expect(html).toContain(slot)
    const csp = /http-equiv="%VITE_CSP_HTTP_EQUIV%"\s+content="([^"]+)"/.exec(html)?.[1] ?? ''
    expect(csp).toContain("script-src 'self';")
    // React Flow's inline styles in the live examples need it; nothing else does.
    expect(csp).toContain("style-src 'self' 'unsafe-inline';")
    expect(csp).toContain("font-src 'self';")
    const head = html.slice(0, html.indexOf('</head>'))
    expect(head.indexOf('%VITE_CSP_HTTP_EQUIV%')).toBeLessThan(head.indexOf('<script'))
    expect(html).not.toMatch(/<script>(?!<\/script>)/)
    expect(html).toContain(`src="${slug ? '../../' : '../'}src/docs/main.ts"`)
  })

  it('lists every page in the sidebar', () => {
    const inNav = new Set(site.nav.flatMap((g) => g.items.filter((i) => i.page !== undefined && !i.anchor).map((i) => i.page)))
    expect([...inNav].sort()).toEqual(site.pages.map((p) => p.slug).sort())
  })

  it('pages through the docs in the sidebar order, starting with the overview', () => {
    const sidebar = [...new Set(site.nav.flatMap((g) => g.items.flatMap((i) => (i.page !== undefined ? [i.page] : []))))]
    expect(readingOrder(site).map((p) => p.slug)).toEqual(sidebar)
    expect(sidebar.slice(0, 3)).toEqual(['', 'quickstart', 'why'])
    const title = (slug: string) => site.pages.find((p) => p.slug === slug)!.title.replace(/&/g, '&amp;')
    const pager = (slug: string) => layoutHtml(site, rendered.get(slug)!).match(/<nav class="pager"[\s\S]*?<\/nav>/)![0]
    expect(pager('')).toContain(`rel="next"><span class="pager__dir">Next</span><span class="pager__title">${title('quickstart')}</span>`)
    expect(pager('quickstart')).toContain(`rel="prev"><span class="pager__dir">Previous</span><span class="pager__title">${title('')}</span>`)
    expect(pager('quickstart')).toContain(`rel="next"><span class="pager__dir">Next</span><span class="pager__title">${title('why')}</span>`)
    expect(pager('why')).toContain(`rel="next"><span class="pager__dir">Next</span><span class="pager__title">${title(sidebar[3])}</span>`)
    expect(pager('systems')).toContain(`<span class="pager__title">${title('imports')}</span>`)
    expect(pager('systems')).toContain(`<span class="pager__title">${title('hld')}</span>`)
    expect(pager('grammar')).toContain(`<span class="pager__title">${title('model')}</span>`)
  })

  it('keeps the sidebar’s Start group short with labels', () => {
    const start = site.nav.find((g) => g.title === 'Start')!
    expect(start.items.map((i) => i.label)).toEqual(['Overview', 'Quickstart', 'Why Proschi'])
    expect(layoutHtml(site, rendered.get('')!)).toContain('aria-current="page">Overview</a>')
  })

  it('gives the home page its own title, without the docs suffix', () => {
    expect(headHtml(site.pages.find((p) => p.slug === '')!)).toContain('<title>Proschi: architecture diagrams as code</title>')
    expect(headHtml(site.pages.find((p) => p.slug === 'why')!)).toMatch(/<title>.+ · Proschi docs<\/title>/)
  })

  it('redirects old anchors only to pages and anchors that exist, never shadowing a live anchor', () => {
    for (const [slug, map] of Object.entries(site.anchorRedirects ?? {})) {
      const from = rendered.get(slug)
      expect(from, `anchorRedirects: no page "${slug}"`).toBeDefined()
      // Every heading LANGUAGE.md had before it was split, but the one it kept.
      if (slug === 'language') expect(Object.keys(map)).toHaveLength(29)
      for (const [old, to] of Object.entries(map)) {
        expect(from!.anchors.has(old), `${slug}#${old} still exists on the page`).toBe(false)
        const dest = target('', to)
        expect(dest && rendered.get(dest.slug) && (!dest.anchor || rendered.get(dest.slug)!.anchors.has(dest.anchor)), `${slug}#${old} → ${to}`).toBeTruthy()
      }
    }
  })

  it('points sidebar anchors at headings that exist', () => {
    for (const item of site.nav.flatMap((g) => g.items)) {
      if (item.anchor) expect(rendered.get(item.page!)!.anchors, `${item.page}#${item.anchor}`).toContain(item.anchor)
    }
  })
})

describe('rendered pages', () => {
  it.each([...rendered.keys()].map((slug) => [slug || '(home)', slug]))('%s: links and anchors resolve', (_, slug) => {
    const page = rendered.get(slug)!
    const html = layoutHtml(site, page)
    const broken: string[] = []
    for (const [, href] of html.matchAll(/\shref="([^"]*)"/g)) {
      if (/^(https?|mailto):/.test(href)) {
        // Docs that are on the site are linked there, not on GitHub.
        if (/github\.com\/gvart\/proschi\/blob\/main\/docs\/[A-Z]+\.md/.test(href) && site.pages.some((p) => href.includes(`docs/${p.source}`))) broken.push(href)
        continue
      }
      const to = target(slug, href)
      if (!to) continue // app/, practice/: the site's other pages.
      const dest = rendered.get(to.slug)
      // Anchors of the layout itself: the drawer and the skip target.
      const layoutIds = new Set(['docs-nav', 'main'])
      if (!dest || (to.anchor && !dest.anchors.has(to.anchor) && !layoutIds.has(to.anchor))) broken.push(href)
    }
    expect(broken).toEqual([])
  })

  it('renders headings with GitHub’s anchors and builds "On this page"', () => {
    const useCases = rendered.get('use-cases')!
    expect(useCases.toc.find((t) => t.text === 'Reads and writes')).toEqual({ level: 2, id: 'reads-and-writes', text: 'Reads and writes' })
    expect(rendered.get('tests')!.article).toContain('<h2 id="selectors-and-kinds">')
    const model = rendered.get('model')!
    expect(layoutHtml(site, rendered.get('quickstart')!)).toContain('data-toc="3-break-it-on-purpose">Break it on purpose</a>')
    expect(model.toc.filter((t) => t.level === 2).map((t) => t.id)).toEqual(['modelled', 'examples', 'quirks', 'not-modelled', 'reading', 'practice'])
  })

  it('leaves "On this page" out, inline and beside the article, when a page has fewer than two entries', () => {
    const home = rendered.get('')!
    expect(home.toc).toHaveLength(1)
    for (const toc of [[], home.toc]) {
      const html = layoutHtml(site, { ...home, toc })
      expect(html).not.toContain('toc-inline')
      expect(html).not.toContain('aria-label="On this page"')
      expect(html).toContain('<aside class="docs-toc"></aside>')
    }
    const two = layoutHtml(site, { ...home, toc: [...home.toc, { level: 2, id: 'more', text: 'More' }] })
    expect(two.match(/aria-label="On this page"/g)).toHaveLength(2)
  })

  it('numbers: has the cheat sheet’s sections, and every estimate card links to one that exists', () => {
    const numbers = rendered.get('numbers')!
    expect(numbers.toc.filter((t) => t.level === 2).map((t) => t.id)).toEqual(['latency', 'throughput-and-capacity', 'time-and-conversions', 'sizes', 'cloud-costs', 'how-to-estimate'])
    const cardsDir = new URL('../src/practice/cards/', import.meta.url)
    const cards = readdirSync(cardsDir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.md'))
    let estimates = 0
    for (const file of cards) {
      const text = readFileSync(new URL(file, cardsDir), 'utf8')
      if (/^type: estimate$/m.test(text)) {
        estimates++
        expect(text, file).toMatch(/\]\(\.\.\/docs\/numbers\/#[a-z0-9-]+\)/)
      }
      // Cards are shown on the practice page, so their docs links are relative to practice/.
      for (const [, href] of text.matchAll(/\]\((\.\.\/docs\/[^)\s]*)\)/g)) {
        const url = new URL(href, 'https://x/practice/')
        const dest = rendered.get(url.pathname.replace(/^\/docs\//, '').replace(/\/$/, ''))
        expect(url.pathname.startsWith('/docs/') && dest !== undefined && (!url.hash || dest.anchors.has(url.hash.slice(1))), `${file}: ${href}`).toBe(true)
      }
    }
    expect(estimates).toBeGreaterThan(0)
  })

  it('escapes raw HTML in Markdown instead of rendering it', () => {
    for (const page of rendered.values()) {
      if (page.page.source.endsWith('.md')) expect(page.article).not.toMatch(/<(script|iframe|style)\b|<img\b(?! src="(\.\.\/|\.\/)?images\/)/)
    }
  })

  it('shows images from docs/images as sized, lazy figures with alt text and a caption', () => {
    const systems = rendered.get('systems')!
    expect(systems.images).toContain('images/diagrams/org.svg')
    expect(systems.article).toMatch(/<figure class="doc-figure"><img src="\.\.\/images\/diagrams\/org\.svg" alt="[^"]{20,}" width="\d+" height="\d+" loading="lazy" decoding="async" \/><figcaption>[^<]+<\/figcaption><\/figure>/)
    for (const page of rendered.values()) {
      for (const path of page.images) {
        expect(existsSync(`${docsDir}${path}`), path).toBe(true)
        expect(statSync(`${docsDir}${path}`).size, path).toBeLessThan(path.endsWith('.png') ? 250_000 : 100_000)
      }
    }
    const page = site.pages.find((p) => p.slug === 'quickstart')!
    const render = (md: string) => renderPage(site, page, `# T\n\n${md}\n`, docsDir)
    expect(() => render('![A diagram](../README.md)')).toThrow(/under docs\/images/)
    expect(() => render('![A diagram](images/nope.svg)')).toThrow(/does not exist/)
    expect(() => render('![](images/diagrams/org.svg)')).toThrow(/alt text/)
    expect(() => renderPage(site, page, '# T\n\n![A diagram](images/diagrams/org.svg)\n')).toThrow(/not supported/)
  })

  it('highlights Proschi code at build time and keeps the source for the live example', () => {
    const quickstart = rendered.get('quickstart')!
    expect(quickstart.article).toMatch(/<figure class="live" data-live data-source="[A-Za-z0-9+/=]+">/)
    expect(quickstart.article).toContain('<span class="tok-tech">[PostgreSQL]</span>')
    const [, b64] = /data-source="([^"]+)"/.exec(quickstart.article)!
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(quickstart.examples[0])
  })
})

describe('live examples', () => {
  const examples = [...rendered.values()].flatMap((p) => p.examples.map((source, i) => [`${p.page.slug || '(home)'} #${i + 1}`, source]))

  it('exist on the pages that teach the language', () => {
    expect(rendered.get('quickstart')!.examples.length).toBeGreaterThanOrEqual(4)
    for (const slug of ['language', 'nodes', 'styling', 'use-cases', 'scenarios', 'imports', 'hld', 'tests']) expect(rendered.get(slug)!.examples.length, slug).toBeGreaterThanOrEqual(1)
    expect(rendered.get('')!.examples.length).toBeGreaterThanOrEqual(1)
  })

  it.each(examples)('%s parses without diagnostics', (_, source) => {
    expect(parse(source).diagnostics).toEqual([])
  })

  it('every Markdown fence of Proschi code is tagged', () => {
    for (const file of site.pages.map((p) => p.source).filter((f) => f.endsWith('.md'))) {
      const fences = markdownIt().parse(readFileSync(`${docsDir}${file}`, 'utf8'), {}).filter((t) => t.type === 'fence' && !t.info.trim())
      for (const { content } of fences) {
        expect(/^\s*(title|usecase|group)\b|\s-[->x]/m.test(content), `${file}: an untagged fence that looks like Proschi:\n${content}`).toBe(false)
      }
    }
  })

  it('the org guide flags Order Processing at 2k rps and nothing at 1k, as it says', () => {
    const [org] = rendered.get('systems')!.examples
    const failing = (source: string) => runTests(parse(source).diagram).filter((t) => !t.passed).map((t) => t.id)
    expect(failing(org)).toEqual(['system:orders'])
    expect(failing(org.replace('"Buy drone" 2k rps', '"Buy drone" 1k rps'))).toEqual([])
  })

  it('the tests page passes as written, and fails survival with one database, as its try-it says', () => {
    const [paste] = rendered.get('tests')!.examples
    const failing = (source: string) => runTests(parse(source).diagram).filter((t) => !t.passed).map((t) => t.name)
    expect(failing(paste)).toEqual([])
    expect(failing(paste.replace('[PostgreSQL] x2', '[PostgreSQL] x1'))).toEqual(['survive any node failure'])
  })

  it('the high-level design passes as written, and fails survival at a 50% hit rate, as its try-it says', () => {
    const [shortener] = rendered.get('hld')!.examples
    const failing = (source: string) => runTests(parse(source).diagram).filter((t) => !t.passed).map((t) => t.name)
    expect(failing(shortener)).toEqual([])
    expect(failing(shortener.replace('"Cache hit" 90%, "Cache miss" 10%', '"Cache hit" 50%, "Cache miss" 50%'))).toEqual(['survive any node failure'])
  })

  it('the quickstart’s last step passes, and fails survival with one database, as it says', () => {
    const quickstart = rendered.get('quickstart')!
    const last = quickstart.examples.at(-1)!
    expect(runTests(parse(last).diagram).filter((t) => !t.passed)).toEqual([])
    const single = runTests(parse(last.replace('[PostgreSQL] x2', '[PostgreSQL] x1')).diagram)
    expect(single.filter((t) => !t.passed).map((t) => t.name)).toEqual(['survive any node failure'])
  })
})

describe('links', () => {
  const ctx = { config: site, from: 'language', sourcePath: 'docs/LANGUAGE.md' }

  it('turns links between the docs into links on the site', () => {
    expect(rewriteHref('EDITORS.md#formatting', ctx)).toBe('../editors/#formatting')
    expect(rewriteHref('#grammar', ctx)).toBe('#grammar')
    expect(rewriteHref('https://proschi.app/docs/model/', ctx)).toBe('../model/')
    expect(rewriteHref('https://proschi.app/model/#practice', ctx)).toBe('../model/#practice')
    expect(rewriteHref('https://proschi.app/practice/', ctx)).toBe('../../practice/')
    expect(rewriteHref('https://github.com/gvart/proschi/blob/main/docs/PRACTICE.md#calibrating-a-problem', ctx)).toBe('../practice-authoring/#calibrating-a-problem')
    expect(rewriteHref('README.md', { ...ctx, from: 'quickstart' })).toBe('../')
    expect(rewriteHref('WHY.md', { ...ctx, from: 'quickstart' })).toBe('../why/')
    expect(rewriteHref('QUICKSTART.md', { ...ctx, from: '', sourcePath: 'docs/README.md' })).toBe('./quickstart/')
  })

  it('sends links to other repository files to GitHub', () => {
    expect(rewriteHref('design/hld-and-practice.md#2-simulation', ctx)).toBe('https://github.com/gvart/proschi/blob/main/docs/design/hld-and-practice.md#2-simulation')
    expect(rewriteHref('../backend/README.md', ctx)).toBe('https://github.com/gvart/proschi/blob/main/backend/README.md')
    expect(rewriteHref('https://example.com/x', ctx)).toBe('https://example.com/x')
    expect(() => rewriteHref('../../etc', ctx)).toThrow(/leaves the repository/)
  })

  it('builds relative page links', () => {
    expect(pageHref('', 'language')).toBe('./language/')
    expect(pageHref('language', '')).toBe('../')
    expect(pageHref('language', 'language', 'tests')).toBe('#tests')
    expect(pageHref('language', 'language')).toBe('./')
  })

  it('makes anchors like GitHub, numbering repeats', () => {
    const slug = slugger()
    expect(slug('Reads and writes')).toBe('reads-and-writes')
    expect(slug('`problem.md`')).toBe('problemmd')
    expect(slug('5.3 Practice platform (/practice/)')).toBe('53-practice-platform-practice')
    expect(slug('Tests')).toBe('tests')
    expect(slug('Tests')).toBe('tests-1')
  })
})

describe('annotated examples', () => {
  const fixture: SiteConfig = { pages: [{ slug: 'x', title: 'X', source: 'X.md', description: 'd' }], nav: [{ title: 'G', items: [{ page: 'x' }] }] }
  const render = (md: string) => renderPage(fixture, fixture.pages[0], md)
  const fence = (body: string, info = 'proschi annotated') => `# X\n\n\`\`\`${info}\n${body}\n\`\`\`\n`

  it('attaches a note to the next line that is neither blank nor a note, joining consecutive notes', () => {
    const { code, notes } = splitAnnotations(['title "T"', '', '  # @note The API,', '  # @note with `x2`.', '', 'api "API" [REST API] x2', '# @note Arrow.', 'api -> db : SQL'].join('\n'))
    expect(code).toBe(['title "T"', '', '', 'api "API" [REST API] x2', 'api -> db : SQL'].join('\n'))
    expect(notes).toEqual([
      { line: 4, text: 'The API, with `x2`.' },
      { line: 5, text: 'Arrow.' },
    ])
  })

  it('renders the code without the note lines, marks the annotated lines and lists the notes for readers without JavaScript', () => {
    const page = render(fence('title "T"\n# @note A node with `x2`.\napi "API" [REST API] x2\n# @note <b>An arrow.</b>\napi -> db : SQL'))
    expect(page.examples).toEqual(['title "T"\napi "API" [REST API] x2\napi -> db : SQL'])
    const figure = /<figure class="live live--annotated" data-live data-annotated data-source="([^"]+)">[\s\S]*?<\/figure>/.exec(page.article)!
    expect(Buffer.from(figure[1], 'base64').toString('utf8')).toBe(page.examples[0])
    expect(figure[0]).not.toContain('@note')
    expect(figure[0].match(/<span class="line" data-note="\d">/g)).toEqual(['<span class="line" data-note="0">', '<span class="line" data-note="1">'])
    expect(figure[0]).toContain('<li data-note="0"><code class="annotated__src">api &quot;API&quot; [REST API] x2</code> <span class="annotated__text">A node with <code>x2</code>.</span></li>')
    expect(figure[0]).toContain('&lt;b&gt;An arrow.&lt;/b&gt;')
  })

  it('fails the build on a note that annotates nothing, on no notes, and on annotated with fragment', () => {
    expect(() => render(fence('api "API" [REST API]\n# @note Dangling.'))).toThrow(/annotates nothing/)
    expect(() => render(fence('api "API" [REST API]'))).toThrow(/at least one # @note/)
    expect(() => render(fence('# @note N.\napi "API" [REST API]', 'proschi annotated fragment'))).toThrow(/both annotated and a fragment/)
  })

  it('attaches a try-it prompt to the live example right above it, and only there', () => {
    const live = render(`${fence('api "API" [REST API]', 'proschi')}\n> **Try it:** rename it.\n`)
    expect(live.article).toMatch(/<\/figure>\n<blockquote class="try-it">\n<p><strong>Try it:<\/strong> rename it.<\/p>/)
    expect(render(`${fence('api "API"', 'proschi fragment')}\n> **Try it:** no.\n`).article).not.toContain('try-it')
    expect(render('# X\n\n> **Try it:** no.\n').article).not.toContain('try-it')
    expect(render(`${fence('api "API" [REST API]', 'proschi')}\n> A quote.\n`).article).not.toContain('try-it')
  })

  it('puts a page’s anchor redirects on the page, and none on pages without any', () => {
    const page = render('# X\n')
    expect(layoutHtml(fixture, page)).not.toContain('data-anchor-redirects')
    const html = layoutHtml({ ...fixture, anchorRedirects: { x: { 'old-one': 'hld/#traffic', gone: 'scenarios/' } } }, page)
    const attr = /data-anchor-redirects="([^"]+)"/.exec(html)![1].replace(/&quot;/g, '"')
    expect(JSON.parse(attr)).toEqual({ 'old-one': 'hld/#traffic', gone: 'scenarios/' })
    expect(layoutHtml({ ...fixture, anchorRedirects: { x: {} } }, page)).not.toContain('data-anchor-redirects')
  })

  it('the start page has one annotated example, with a note on every line but a closing brace or a block’s body', () => {
    const home = rendered.get('')!
    expect(home.article.match(/data-annotated/g)).toHaveLength(1)
    const fence = /```proschi annotated\n([\s\S]*?)\n```/.exec(readFileSync(`${docsDir}README.md`, 'utf8'))![1]
    const { code, notes } = splitAnnotations(fence)
    const noted = new Set(notes.map((n) => n.line))
    // Lines inside traffic { … } and requirements { … } share the note on the block's first line.
    let inBlock = false
    const missing = code.split('\n').flatMap((text, i) => {
      const t = text.trim()
      if (/^(traffic|requirements) \{$/.test(t)) inBlock = true
      else if (t === '}') inBlock = false
      else if (t && !inBlock && !noted.has(i + 1)) return [t]
      return []
    })
    expect(missing).toEqual([])
    expect(new Set(notes.map((n) => n.text)).size).toBe(notes.length)
  })
})
