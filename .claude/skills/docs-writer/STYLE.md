# Proschi writing style

The one style guide for everything a reader of proschi.app sees: the docs
(`docs/*.md`), the blog (`blog/*/index.md`) and the practice lessons. `/docs-writer`
and `/blog-post` both follow it. Change a rule here, never in a copy.

## Voice

- Plain words. Write "use", not "utilize"; "start", not "initiate".
- Short sentences: one idea each, 20 words or fewer as a rule. A semicolon
  usually means two sentences.
- Second person and present tense: "you add a node", "the simulation flags
  it". Not "the user", not "we". Past tense only for what changed in a
  release ("0.12.0 added `system`").
- Concrete over abstract. Show the line of code, the command, the number.
  If a sentence would fit any product's docs, delete it.
- Say what it does, not how it feels. No hype, no superlatives.
- Names as the product spells them: Proschi, VS Code, Claude Code, GitHub.
  Keywords, ids, flags and file names in `code`.
- Use one term for one thing. A use case is always a "use case", never also
  a "flow" or a "journey" on the next line.
- British or American spelling: keep whatever the page already uses.

## Structure

- **One idea per paragraph.** Two to four sentences. A paragraph that needs
  a sub-point is two paragraphs.
- **Show, then explain.** Lead with a live example (a ```proschi fence), then
  say what each part does. The reader sees the result before the rules.
- **Headings say what the reader does or asks.** On guides and concept
  pages: "Draw one box per team", "How load reaches a node". On reference
  pages a plain noun is fine: "Traffic", "Selectors and kinds".
- **Lists only for parallel items**: steps, options, or facts of the same
  kind. Numbered when order matters. Never a list of one, and no nesting
  deeper than one level.
- **Tables** when two or more items share the same attributes (statement,
  syntax, notes; flag, default, meaning). Not for prose. Keep cells to one
  sentence.
- **Link instead of repeating.** If another page explains it, say it in one
  sentence and link there. Every fact lives on one page.
- **Say limits plainly.** What it does not do, in one sentence, where the
  reader would hit it.
- **End when the content ends.** No closing summary. A guide may end with
  "Go further": two to four links.

## Anti-slop checklist

Read the page against this list before you call it done, and fix every hit.

Banned words and phrases: delve, dive into, deep dive, seamless(ly),
unlock, unleash, empower, elevate, supercharge, game-changer, revolutionize,
cutting-edge, robust, leverage (as a verb), harness, streamline,
effortless(ly), powerful, exciting, we're thrilled, in today's fast-paced
world, in the ever-evolving landscape, look no further, take it to the next
level, at the end of the day, whether you're X or Y, it's worth noting,
needless to say, simply, just (as in "just add"), easily, of course,
basically, crucial, comprehensive, intuitive, a wide range of, a variety of,
best-in-class, rest assured, let's explore, buckle up.

Banned patterns:

- "It's not just X, it's Y" and "not only X but also Y".
- Rule-of-three padding: three adjectives or three parallel clauses where
  one would do ("fast, simple and powerful").
- Em dashes. Use a full stop, a colon or parentheses. Never chain them.
- Filler intros: "In this guide, we will…", "Welcome to…", "Have you ever…?".
  Start with the thing.
- Filler outros: "In short", "To sum up", "Happy diagramming!", "Now you
  know…".
- Rhetorical questions as openers.
- Hedge stacks: "may potentially", "can generally help to", "it might be
  possible". Say what happens, or name the condition.
- Fake enthusiasm: exclamation marks, "Great!", "Voilà", "magic".
- Emoji, and emoji bullets.
- Bold sprinkled through running text. Bold is for UI labels (**Share →
  Copy link**) and the lead-in of a definition list item.
- Claims without a source: a number, limit or flag the code does not show.

## SEO

Each page is found through search, so each page gets:

- **A title** of 60 characters or fewer in the browser tab, main term first:
  "Scenarios in Proschi use cases", not "How to branch with scenarios". The
  build appends " · Proschi docs" (15 characters) to the `title` in
  `docs/site.json`, so that field stays at 45 characters or fewer.
- **A meta description** (`description` in `docs/site.json`, `description`
  in a post's frontmatter) of 120 to 155 characters that answers the page's
  question in a sentence. Not a list of keywords.
- **One H1**: the Markdown file's first line. Every other heading is `##` or
  `###`, in order, never skipping a level.
- **Descriptive link text**: "[scenarios](SCENARIOS.md)", never
  "[here](SCENARIOS.md)" or "this page".
- **Internal links**: each page links to the pages before and after it in
  its topic and to the reference for every keyword it introduces. No page
  without a link into it.
- **Alt text** on every image: what the picture shows, in one sentence
  ("The checkout diagram with Order Service in red at 140% load"). Not
  "diagram" or "screenshot".
- **Stable URLs.** Never rename a slug or a heading that something links to
  without a redirect. Check with `grep -rn "PAGE.md#anchor"` first.
