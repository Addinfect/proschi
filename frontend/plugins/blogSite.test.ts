import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error jsdom ships no types, and @types/jsdom is not worth a dependency for one parse.
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { parse } from '../src/dsl/parser'
import { readSite, renderFromDisk } from './docsSite'
import { indexHeadHtml, indexPageHtml, longDate, parsePost, postHeadHtml, postPageHtml, readPosts, renderPost, rfc822, rssXml } from './blogSite'

/**
 * The blog: every post in blog/ has valid frontmatter, the four sections the
 * /blog-post skill asks for, at least one picture or live example, live
 * examples that parse, links that resolve and images that exist; and the
 * feed is well-formed RSS with absolute links.
 */

const blogDir = new URL('../../blog/', import.meta.url).pathname
const docsDir = new URL('../../docs/', import.meta.url).pathname
const stubsDir = new URL('../blog/', import.meta.url).pathname
const site = readSite(docsDir)
const posts = readPosts(blogDir)
const rendered = posts.map((p) => renderPost(site, p, blogDir))
const docAnchors = new Map(site.pages.map((p) => [p.slug, renderFromDisk(docsDir, site, p).anchors]))

const SECTIONS = ['What shipped', 'What problem it solves', 'How to use it', 'Who it is for']
const BANNED = /\b(delve|seamless(ly)?|unlock|unleash|game[- ]changer|supercharge|revolutioni[sz]e|cutting-edge|effortless(ly)?|fast-paced|it's not just)\b|—/i

const post = (frontmatter: string, body = '## What shipped\n') => `---\n${frontmatter}\n---\n${body}`
const META = 'title: T\ndate: 2026-01-02\ndescription: D\naudience: A\ntags: [x]'

describe('posts', () => {
  it('has at least one post, newest first', () => {
    expect(posts.length).toBeGreaterThan(0)
    expect([...posts].sort((a, b) => b.date.localeCompare(a.date))).toEqual(posts)
  })

  it.each(rendered.map((r) => [r.post.slug, r]))('%s: has the four sections, a visualization, and no banned phrases', (_, r) => {
    expect(r.toc.filter((t) => t.level === 2).map((t) => t.text)).toEqual(SECTIONS)
    expect(r.examples.length + r.images.length).toBeGreaterThan(0)
    for (const img of r.images) expect(existsSync(img.from), img.from).toBe(true)
    expect(r.post.body.replace(/```[\s\S]*?```/g, '')).not.toMatch(BANNED)
  })

  it.each(rendered.flatMap((r) => r.examples.map((source, i) => [`${r.post.slug} #${i + 1}`, source])))('%s parses without diagnostics', (_, source) => {
    expect(parse(source).diagnostics).toEqual([])
  })

  it.each(rendered.map((r) => [r.post.slug, r]))('%s: links to the docs land on a page and an anchor that exist', (_, r) => {
    for (const [, href] of r.html.matchAll(/href="(\.\.\/\.\.\/docs\/[^"]*)"/g)) {
      const url = new URL(href, `https://x/blog/${r.post.slug}/`)
      const slug = url.pathname.slice('/docs/'.length).replace(/\/$/, '')
      expect(docAnchors.has(slug), href).toBe(true)
      if (url.hash) expect(docAnchors.get(slug)!.has(url.hash.slice(1)), href).toBe(true)
    }
    // Nothing points back into the repository by a relative path.
    expect(r.html).not.toMatch(/href="(?!https?:|#|\.\.\/\.\.\/)/)
  })

  it('puts the newer release first when two posts share a day', () => {
    for (let i = 1; i < posts.length; i++) {
      const [a, b] = [posts[i - 1], posts[i]]
      if (a.date === b.date && a.version && b.version) expect(a.version.localeCompare(b.version, 'en', { numeric: true })).toBeGreaterThan(0)
    }
  })

  it('publishes a post\'s images next to its page', () => {
    const r = rendered.find((x) => x.images.length > 0)!
    expect(r.html).toMatch(new RegExp(`<img src="${r.images[0].name}" alt="[^"]+" loading="lazy" />`))
    expect(() => renderPost(site, parsePost('2026-01-02-a/index.md', post(META, '![x](../docs/images/a.png)\n')), blogDir)).toThrow(/next to the post/)
    expect(() => renderPost(site, parsePost('2026-01-02-a/index.md', post(META, '![x](../2026-01-01-b/a.png)\n')), blogDir)).toThrow(/next to the post/)
    expect(() => renderPost(site, parsePost('2026-01-02-a/index.md', post(META, '![x](missing.svg)\n')), blogDir)).toThrow(/does not exist/)
    expect(() => renderPost(site, parsePost('2026-01-02-a/index.md', post(META, '![x](a.gif)\n')))).toThrow(/is not one of/)
  })
})

describe('the blog folder', () => {
  const blog = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'blog-'))
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true })
      writeFileSync(join(dir, path), text)
    }
    return dir
  }

  it('reads one folder per post, and skips the README', () => {
    const dir = blog({ 'README.md': '# Blog\n', '2026-01-02-a/index.md': post(META), '2026-01-02-a/pic.svg': '<svg/>' })
    expect(readPosts(dir).map((p) => [p.slug, p.file])).toEqual([['a', '2026-01-02-a/index.md']])
  })

  it('rejects a post or an image outside a folder, and a folder without index.md', () => {
    expect(() => readPosts(blog({ '2026-01-02-a.md': post(META) }))).toThrow(/go in a folder/)
    expect(() => readPosts(blog({ 'pic.svg': '<svg/>' }))).toThrow(/go in a folder/)
    expect(() => readPosts(blog({ '2026-01-02-a/notes.md': post(META) }))).toThrow(/has no index.md/)
  })
})

describe('frontmatter', () => {
  it('reads the fields and the slug from the folder name', () => {
    const p = parsePost('2026-01-02-hello-world/index.md', post(`${META}\nversion: 1.2.3`))
    expect(p).toMatchObject({ slug: 'hello-world', title: 'T', date: '2026-01-02', version: '1.2.3', tags: ['x'] })
  })

  it.each([
    ['a bad folder name', 'hello/index.md', post(META)],
    ['a post outside a folder', '2026-01-02-a.md', post(META)],
    ['no frontmatter', '2026-01-02-a/index.md', '## What shipped\n'],
    ['a date that is not the folder name\'s', '2026-01-03-a/index.md', post(META)],
    ['no tags', '2026-01-02-a/index.md', post(META.replace('tags: [x]', ''))],
    ['a bad version', '2026-01-02-a/index.md', post(`${META}\nversion: next`)],
    ['an unknown field', '2026-01-02-a/index.md', post(`${META}\nauthor: me`)],
    ['an h1 in the body', '2026-01-02-a/index.md', post(META, '# Title\n')],
  ])('rejects %s', (_, file, text) => {
    expect(() => parsePost(file, text)).toThrow()
  })
})

describe('pages', () => {
  it('has the index and the post template, with the placeholders, the shell and the docs\' script policy', () => {
    for (const [file, script] of [['index.html', '../src/blog/main.ts'], ['_post/index.html', '../../src/blog/main.ts']]) {
      const html = readFileSync(`${stubsDir}${file}`, 'utf8')
      for (const slot of ['<!--blog:head-->', '<!--blog:page-->', '<!--shell:header-->', '<!--shell:footer-->']) expect(html).toContain(slot)
      expect(html).toContain("script-src 'self';")
      expect(html).toContain(`src="${script}"`)
    }
  })

  it('links the feed from every page and pages between posts', () => {
    expect(indexHeadHtml()).toContain('<link rel="alternate" type="application/rss+xml" title="Proschi blog" href="./rss.xml" />')
    expect(postHeadHtml(posts[0])).toContain('href="../rss.xml"')
    expect(postHeadHtml(posts[0])).toContain(`<link rel="canonical" href="https://proschi.app/blog/${posts[0].slug}/" />`)
    const index = indexPageHtml(posts)
    for (const p of posts) expect(index).toContain(`href="./${p.slug}/"`)
    const page = postPageHtml(rendered[0], posts)
    expect(page).toContain(`href="../${posts[0].slug}/" aria-current="page"`)
    expect(page).toContain('data-site-root="../../"')
  })

  it('writes dates out', () => {
    expect(longDate('2026-10-31')).toBe('31 October 2026')
    expect(rfc822('2026-10-31')).toBe('Sat, 31 Oct 2026 00:00:00 GMT')
  })
})

describe('rss.xml', () => {
  const extra = parsePost('2026-01-02-a-b/index.md', post(META.replace('title: T', 'title: "Fish & <chips>"')))
  const xml = rssXml([...posts, extra])
  const doc = (new JSDOM(xml, { contentType: 'text/xml' }) as { window: Window }).window.document

  it('is well-formed RSS 2.0', () => {
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0)
    expect(doc.documentElement.tagName).toBe('rss')
    expect(doc.documentElement.getAttribute('version')).toBe('2.0')
    expect(doc.querySelector('channel > link')?.textContent).toBe('https://proschi.app/blog/')
  })

  it('has an item per post, with absolute links, a guid and a date', () => {
    const items = Array.from(doc.querySelectorAll('item'))
    expect(items).toHaveLength(posts.length + 1)
    for (const item of items) {
      const link = item.querySelector('link')!.textContent!
      expect(link).toMatch(/^https:\/\/proschi\.app\/blog\/[a-z0-9-]+\/$/)
      expect(item.querySelector('guid')!.textContent).toBe(link)
      expect(Number.isNaN(Date.parse(item.querySelector('pubDate')!.textContent!))).toBe(false)
    }
    expect(items.at(-1)!.querySelector('title')!.textContent).toBe('Fish & <chips>')
  })
})
