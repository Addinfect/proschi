---
name: docs-writer
description: Write or rewrite a user-facing Proschi docs page (docs/*.md, shown at proschi.app/docs/) to the shared style guide, with live and annotated examples, a search-friendly title and description, then check and test it. Use when the user types /docs-writer, or adds, splits or rewrites a docs page.
---

# /docs-writer: write a docs page

The docs are Markdown in `docs/`, listed in `docs/site.json` and built by
`frontend/plugins/docsSite.ts` into `/docs/<slug>/`. Every rule about
wording, structure, slop and SEO is in [STYLE.md](STYLE.md). Read it first.
This file covers what is specific to docs pages.

Contributor docs (`CARDS.md`, `GAME.md`, `PRACTICE.md`, `PRIVACY.md`) follow
STYLE.md too, but keep their own structure.

## 1. Pick the page type

| Type | Answers | Word budget | Required sections, in order |
|---|---|---|---|
| Concept | "What is X and how does it work?" | 600–1200 | H1; lede (two sentences: what it is, why you'd use it); a live example; `##` sections, one idea each; "Go further" links |
| Guide | "How do I do X?" | 400–900 | H1 as the outcome ("Your first diagram in 2 minutes"); lede (what you will have at the end); numbered `## 1. …` steps, each with an example or a command; "Go further" links |
| Reference | "What exactly does X accept?" | prose ≤ 300 between tables, no cap on tables | H1; one-sentence lede; a table or grammar; short notes per item; links to the concept page |

A page that answers two of these questions is two pages. A page past its
budget is split or cut, not squeezed.

## 2. Add a page

1. Write `docs/<NAME>.md`. Its first line is the only H1.
2. Add `{ slug, title, source, description }` to `pages` in
   `docs/site.json` (title ≤ 45 characters, description 120–155, see
   STYLE.md "SEO") and an item to `nav`.
3. Copy a stub to `frontend/docs/<slug>/index.html` (any existing stub; the
   build fills it in). The sitemap picks the page up from `site.json`.
4. Link to it from its neighbours. Renaming or moving a heading? Grep for
   inbound `PAGE.md#anchor` and `docs/<slug>/#anchor` links first.

Link between pages by file (`[scenarios](SCENARIOS.md#parallel-steps)`); the
build turns that into a site link and fails on links that leave the
repository.

## 3. Examples

- ```` ```proschi ```` is a **live example**: a complete document that
  parses with no diagnostics (the docs tests check it). The reader can play
  its use cases. Keep it to three to eight nodes and show one idea.
- ```` ```proschi fragment ```` is highlighted only: for a partial document,
  a syntax shape, or a line that is wrong on purpose.
- **Try-it prompt.** After a live example, a blockquote that starts with
  `**Try it:**` gives the reader one change to make and what they will see:

  ```markdown
  > **Try it:** change `x2` to `x1` on `db`, then press **Play** on
  > "Place order › DB down".
  ```

  One prompt per example, one action per prompt, and say the visible result.
  The build places it under the example.
- Never an untagged fence that looks like Proschi. Shell commands in
  ```` ```sh ````, output in ```` ```text ````.

### Annotated examples

```` ```proschi annotated ```` is a live example whose lines carry short
notes. On the site the code sits beside the diagram; hovering, focusing or
tapping an annotated line shows its note and lights up the matching box or
arrow. Use it on the start page and at the top of a concept page, at most
once per page.

The syntax (D2 builds it):

````markdown
```proschi annotated
title "Notes"

# @note A node: an id, a display name and a tech stack from the catalog.
api "Notes API" [REST API]
db  "Notes DB"  [PostgreSQL]

# @note A connection. Use case steps can only follow connections.
api -> db : SQL
```
````

- A **note line** is a line whose trimmed text starts with `# @note ` (a
  Proschi comment, so the fence still parses as written). The note text is
  the rest of the line.
- A note **annotates the next line that is neither blank nor a note line**.
  Consecutive note lines join into one note, separated by spaces.
- **What lights up** follows from the annotated line: a node declaration
  lights that node; a connection or a use case step lights that edge; a
  `group` or `system` line lights the group or system; any other line
  (`title`, `usecase`, `traffic`, a capacity line) shows its note and lights
  nothing.
- The build **removes every note line** from the code it shows and from the
  source the diagram is drawn from. The shown code and the diagram's line
  numbers match.
- Note text is plain text; `backticks` render as code, nothing else.
- It is a build error when a note annotates nothing (it is the last line),
  or an annotated fence has no notes. `annotated` with `fragment` is an
  error too.
- Without JavaScript, or on GitHub, the notes read as ordinary comments.

Write notes as one or two short sentences, at most 25 words, saying what the
line does for the reader. The start page (`README.md`) explains every
meaningful line, with one note on a block's first line (`traffic {`); when
two lines teach the same thing, the second note adds something new. Other
pages: three to eight notes per example.

## 4. Images

1. **Generated diagrams first.** A picture of a diagram is rendered from a
   committed `.proschi` source by script, never drawn by hand, and a test
   fails when it is stale.
2. **Screenshots** of the editor or an IDE come from the screenshot script,
   run by hand, so they can be retaken after a UI change. No manual crops.
3. **Concept SVGs** (how load flows, headroom, playback, team systems) only
   when no diagram or screenshot can show the idea. Static SVG, no scripts,
   no external fonts, readable in light and dark.

Every image has real alt text (STYLE.md "SEO"). If a live example can show
it, use the live example instead of an image.

Put an image on a line of its own, so it becomes a figure with its size and
lazy loading, and its title becomes the caption:

```markdown
![Order Processing in red, sent 2k rps against 1.2k of headroom](images/diagrams/org.svg "The example above, rendered.")
```

Images live in `docs/images/` (`.svg` or `.png`; the build fails on any other
path, a missing file or empty alt text):

| Folder | What | How to regenerate |
|---|---|---|
| `diagrams/` | Diagrams rendered from `src/<name>.proschi` (a first line `# render: --expand orders` passes flags; team files go in `src/teams/`) | `npm run docs:images` in `tooling/`. `npm test` there fails when a committed SVG is stale or over 100 KB. |
| `screens/` | Editor screenshots, 1440×860, light theme | `npm run build`, then `npm run docs:screenshots` in `frontend/` (`e2e/docs-screenshots.screens.ts`). Not in CI. Keep each under 250 KB. |
| `concepts/` | Hand-drawn SVGs: a light `#FFF8E7` background, ink `#111111` boxes with a 3 px offset shadow, the site's accents, Archivo and JetBrains Mono with system fallbacks | Edit the SVG by hand. Keep it under 100 KB. |

At most one or two images per page, each on the page that explains its idea.

## 5. Review before you finish

1. **Read it aloud.** Every sentence you stumble on gets shorter.
2. **Slop check.** Go through STYLE.md "Anti-slop checklist" line by line.
   `grep -nE "—|seamless|powerful|simply|just |robust|leverage" docs/<NAME>.md`
   catches the common hits.
3. **Word budget.** `wc -w docs/<NAME>.md` against the table above. Report
   the count before and after when you rewrite a page.
4. **Verify every claim.** Each command, flag, keyword, default and limit is
   checked against the code (`tooling/src/cli.ts`, `frontend/src/dsl`,
   `frontend/src/sim`). Run the commands you show.
5. **Run the docs tests** from `frontend/` (prefix with
   `NODE_OPTIONS=--no-experimental-webstorage` on macOS if they fail with
   webstorage errors):

   ```sh
   npx vitest run plugins/docsSite.test.ts src/onboarding   # examples parse, links, anchors
   npm run build && npx playwright test e2e/docs.e2e.ts      # pages, sidebar, live examples (needs `npm run build:accounts` once)
   ```

6. Look at the page in `npx vite preview` at desktop width and at 390px,
   light and dark, before you hand it over.
