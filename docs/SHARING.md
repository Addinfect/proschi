# Sharing and embedding

A diagram in the [editor](https://proschi.app/app/) leaves it three ways,
all from the **Share** menu: a link that carries the diagram, a short link
with a preview image, and an embed for other pages.

## Links that carry the diagram

The editor's address always holds the whole document, compressed after
`#code=`. **Share → Copy link** copies it. Imported files travel in the same
link (`&imports=`), so it renders the same for someone who has none of
them. That includes the [saved versions](VERSIONS.md) a diagram reads with
`cloud:`, so the viewer needs no account. The part after `#` never reaches a server, so nothing is stored and
the link works offline.

While a use case plays, the link also names the use case, the scenario and
the step, and opens playback right there:

```text
https://proschi.app/app/#code=…&uc=create-order&alt=db-down&step=2
```

A bundled example opens by name: `https://proschi.app/app/?example=url-shortener`.
The names are `hello`, `ecommerce`, `serverless`, `login`, `events`,
`url-shortener` and `styled`.

Two limits apply. Some chat apps cut long links, and the editor warns once a
link passes 8,000 characters. A link preview in Slack, X or LinkedIn shows
Proschi's own image, because the preview bot never sees the diagram. A short
link fixes both.

## Make a short link with a preview

Signed in (with GitHub or Google, the same account as practice), **Share →
Short link with preview** stores the diagram on proschi.app and copies an
address like `https://proschi.app/s/Ab3dEf9hIj`.

- It stays short, whatever the size of the diagram.
- Link previews show the diagram's title and an image of it, rendered in
  your browser when you make the link.
- Opening it loads the diagram into the editor as a new diagram, or the
  saved copy with the same text. Viewers need no account.

A short link is a snapshot. Later edits don't change it, so make a new one
(the editor reuses the last one while the diagram is unchanged). Anyone with
the address can open it, and its ten random characters can't be guessed.

**Share → Your short links** lists yours. Deleting one stops it at once,
though chat apps may keep previews they already fetched. Deleting your
account deletes all of them (see [Privacy](PRIVACY.md)).

| Limit | Value |
|---|---|
| Diagram and its imports | 64 KiB |
| Preview image | 300 KiB |
| Short links per account | 100 |
| New short links | 10 a minute |

## Embed a diagram in a page

**Share → Embed** copies an `<iframe>` for a blog post, a wiki or docs:

```html
<iframe src="https://proschi.app/embed/?s=Ab3dEf9hIj" title="Checkout · Proschi"
        width="100%" height="480" style="border:0" loading="lazy" allowfullscreen></iframe>
```

The embed is read-only. It shows the diagram, a picker for its use cases and
scenarios, **Play**, and **Open in Proschi**, which opens the diagram in the
editor in a new tab. It has no code editor, so it loads fast.

- Signed in, the embed points at a short link (`?s=<id>`). Signed out, it
  carries the diagram in its address (`/embed/#code=…`), like a copied link.
- `theme=light` or `theme=dark` fixes its colours
  (`/embed/?s=Ab3dEf9hIj&theme=dark`, or `/embed/?theme=dark#code=…`).
  Without it, the embed follows the reader's system theme.
- A `height` of 480 to 600 pixels leaves room to play a use case.

Only `/embed/` may be framed by other sites. Every other page of proschi.app
refuses it.

### oEmbed

Sites that discover embeds through [oEmbed](https://oembed.com/) can ask
`https://proschi.app/api/oembed?url=<short link>` for a `rich` answer: the
iframe, its size (capped by `maxwidth` and `maxheight`) and the preview as a
thumbnail. A short link's page announces the endpoint with a
`<link rel="alternate" type="application/json+oembed">` tag. Whether a site
embeds from it is up to that site: some, Notion and Medium among them, only
embed providers registered with their embed service.
