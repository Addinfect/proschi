---
name: blog-post
description: Write the release post for proschi.app/blog from the release-please release PR, CHANGELOG.md and the PRs merged since the last post, build and test the blog, show the user a preview, then commit it. Use when the user types /blog-post, or before merging release-please's release PR.
---

# /blog-post: write a release post

The blog lives at <https://proschi.app/blog/>. Posts are Markdown files in
`blog/` at the repository root, built by `frontend/plugins/blogSite.ts` into
`/blog/<slug>/`, the index `/blog/` and the feed `/blog/rss.xml`. Run this
before merging release-please's release PR, and commit the post into that PR.

You never push, never merge and never publish. You draft, check, preview,
and commit locally once the user says the post is good.

## 1. Find what shipped

1. The release: `gh pr list --label "autorelease: pending" --json number,title,body`
   (release-please's open release PR). Its body is the new `CHANGELOG.md`
   section. If there is no open release PR, use the newest section of
   `CHANGELOG.md` and ask the user which release to write about.
2. The last post: the newest `blog/*.md` by date. Its `version` is where
   this post starts.
3. The merged PRs since then: every `#123` in the release notes, or
   `git log --oneline <last tag>..HEAD` (tags are `tooling-v<version>`).
   Read each one: `gh pr view <n> --json title,body,files`.
4. The docs the PRs changed (`docs/*.md`): they are the most accurate
   description of how to use the feature. Link to them.

Only claim what the changelog, the PRs and the docs show. If you are not
sure a detail is true (a flag name, a version, a limit), check the code or
leave it out. Never invent numbers, quotes, users or benchmarks.

## 2. Write the post

Create `blog/<yyyy-mm-dd>-<slug>.md`, where the date is today and the slug
says what shipped in two to five words (`terminal-diagrams`). Frontmatter:

```yaml
---
title: Proschi diagrams in the Claude Code terminal   # what shipped, in plain words, no colon puns
date: 2026-10-31                                      # the file name's date
description: One or two sentences for the index, the feed and search results.
version: 0.12.0                                       # the release; leave out for a post that is not a release
audience: Who should read it, in one sentence.
tags: [claude-code, terminal]                         # a few lower-case words
---
```

Then the body, with exactly these four `##` sections, in this order. The
first paragraph before them is the lede: two or three sentences that say
what shipped and why it matters to the reader.

1. `## What shipped`: the changes, concretely. Name the command, the
   keyword, the file. A short list is fine.
2. `## What problem it solves`: the situation the reader was in before, and
   what is different now. One concrete example beats a paragraph.
3. `## How to use it`: numbered, runnable steps (commands in ```sh or
   ```text fences), then a live example in a ```proschi fence: a complete
   Proschi document that parses with no diagnostics. The site draws it as a
   diagram the reader can play. Keep it small (three to six nodes).
4. `## Who it is for`: who benefits and who can skip it. Name limits
   honestly (what it does not do yet).

End after "Who it is for". No closing summary, no "Conclusion".

### Visualizations (at least one per post)

- A ```proschi fence is a live diagram. Use ```proschi fragment for a
  partial document that is only highlighted.
- Images sit next to the post in `blog/`, named after it
  (`blog/2026-10-31-terminal-diagrams.svg`), and are linked by file name:
  `![What the reader sees](2026-10-31-terminal-diagrams.svg)`. SVG, PNG,
  JPG or WebP. They are published next to the post's page. Write real alt
  text: what the picture shows.
- An SVG must be static: no `<script>`, no external fonts, images or links
  (the page's CSP and the `<img>` tag block them anyway). Draw from real
  output (a real render, a real screenshot), not from imagination.
- Raw HTML in the Markdown is off. Do not try inline `<svg>`.

### Links

Link to the docs by their Markdown files (`../docs/AGENT-SKILLS.md#diagrams-in-the-terminal`)
or by `https://proschi.app/...`: both become links within the site. Link
PRs as `https://github.com/gvart/proschi/pull/<n>`.

## 3. Style and anti-slop check

Write to the shared style guide, [STYLE.md](../docs-writer/STYLE.md): voice,
structure, SEO and the anti-slop checklist all live there. On top of it, a
post:

- Keeps to 400 to 800 words.
- Has only the four `##` headings above (`###` inside them are fine).
- Claims nothing the changelog, the PRs or the docs don't show.

Before the preview, read the post once against STYLE.md's anti-slop
checklist and fix every hit. Also check: every command runs as written,
every link resolves, the ```proschi example parses, at least one
visualization is there.

## 4. Build, test, preview

From `frontend/` (on this Mac, prefix the test runners with
`NODE_OPTIONS=--no-experimental-webstorage` if they fail with webstorage errors):

```sh
npx vitest run plugins/blogSite.test.ts   # frontmatter, links, examples parse, RSS is valid XML
npm run build
npx playwright test e2e/blog.e2e.ts       # needs `npm run build:accounts` once, too
npx vite preview --port 4180 --base /     # then open http://localhost:4180/blog/<slug>/
```

Take screenshots of the post and of `/blog/` (desktop and a 390px phone,
light and dark), look at them, and fix what looks wrong. Show the user the
screenshots and the post's text, and ask for changes.

## 5. Commit

When the user approves: `git add blog/` and commit on the release PR's
branch (`git switch <release-please branch>` first, if you are not on it)
with a semantic message, `docs(blog): <what shipped>`. Do not touch
`CHANGELOG.md` or any version: release-please owns them. Do not push or
merge; tell the user the post is committed and ready for them to push.
