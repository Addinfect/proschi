import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readSite } from './docsSite'
import { sitemapUrls, sitemapXml } from './sitemap'

const site = readSite(fileURLToPath(new URL('../../docs', import.meta.url)))

describe('sitemap', () => {
  it('lists the landing page, the editor, practice, every problem and every docs page, once each', () => {
    const urls = sitemapUrls(site, ['url-shortener', 'pastebin'])
    expect(urls.slice(0, 5)).toEqual([
      'https://proschi.app/',
      'https://proschi.app/app/',
      'https://proschi.app/practice/',
      'https://proschi.app/practice/url-shortener/',
      'https://proschi.app/practice/pastebin/',
    ])
    expect(urls).toContain('https://proschi.app/docs/')
    expect(urls).toContain('https://proschi.app/docs/quickstart/')
    expect(urls).toHaveLength(5 + site.pages.length)
    expect(new Set(urls).size).toBe(urls.length)
  })

  it('lists every docs page in the sidebar', () => {
    const urls = sitemapUrls(site, [])
    for (const slug of new Set(site.nav.flatMap((g) => g.items.flatMap((i) => (i.page !== undefined ? [i.page] : []))))) {
      expect(urls, slug).toContain(`https://proschi.app/docs/${slug ? `${slug}/` : ''}`)
    }
  })

  it('lists the roadmap guides after the problems', () => {
    const urls = sitemapUrls(site, ['url-shortener'], ['approach'])
    expect(urls.slice(3, 5)).toEqual(['https://proschi.app/practice/url-shortener/', 'https://proschi.app/practice/approach/'])
    expect(urls).toHaveLength(5 + site.pages.length)
  })

  it('lists the review cards\' pages after the guides', () => {
    const cards = ['https://proschi.app/practice/cards/', 'https://proschi.app/practice/cards/caching/']
    const urls = sitemapUrls(site, ['url-shortener'], ['approach'], cards)
    expect(urls.slice(5, 7)).toEqual(cards)
    expect(urls).toHaveLength(7 + site.pages.length)
  })

  it('is a valid urlset', () => {
    const xml = sitemapXml(['https://proschi.app/'])
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/)
    expect(xml).toContain('<url><loc>https://proschi.app/</loc></url>')
  })
})
