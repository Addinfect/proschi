# Design: versions and cloud references

Status: accepted · Applies to: language, backend, tooling, web editor

## Goal

A team's design changes while other diagrams depend on it. The org diagram
of [team systems](team-systems-and-imports.md) should be able to say "the
Orders design as it was on 2026-11-01", not "whatever Orders looks like
today", and an owner should be able to see what changed between two saved
states. Diagrams saved in a Proschi account get versions, and other
diagrams can import or embed those versions with a `cloud:` source.

This page records the decisions behind that (V1 to V9). It extends I1 to I6
of the team systems page; one of them, I5, gets a narrow exception (V6).

---

## V1. A version is an immutable snapshot

Saving a version copies the diagram's source and its bundled imports at that
moment, with a tag and a sha256 of the source. A version is never edited
afterwards. Its owner may delete it, but its tag is never handed out again
for that diagram, so `cloud:orders:2026-11-01` means one content forever or
nothing at all: a reader either gets the bytes it pinned or an error, never
different bytes under the same name.

## V2. Tags are free-format, a date is recommended

A tag is 1 to 64 characters: letters, digits, `.`, `_` and `-`, starting
with a letter or digit (`/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`). The editor
suggests today's date (`2026-11-01`), because a date reads well in an
import and sorts; `v2` or
`before-sharding` are fine too. The rule keeps tags safe in a URL, a file
name and a lock key without escaping.

## V3. `latest` is the newest saved version, never the draft

`latest` is reserved: no version can be tagged `latest` (in any case). It
names the most recently saved version that still exists. It never names
the live draft: what another diagram imports is always something the owner
chose to save. When the newest version is deleted, `latest` falls back to
the one before it.

## V4. The `cloud:` source

```proschi fragment
import "cloud:shared/infra"
system orders "Order Processing" @Orders {
  from "cloud:teams/orders:2026-11-01"
  expose api -> "Place order"
}
```

- `cloud:<name>:<tag>`, or `cloud:<name>` for `cloud:<name>:latest`, as in
  Docker. Allowed wherever a path is: `import` and `system … { from }`.
- `<name>` is the diagram's file name in the account, with or without
  `.proschi`: `/`-separated segments of letters, digits, `.`, `_`, `+` and
  `-`, at most 200 characters, no `:`, no spaces, no `.` or `..` segment.
  File names are free text in the editor; a diagram whose name has other
  characters (a space, say) cannot be referenced until it is renamed. That
  keeps the spec unquoted and unescaped, like `git:` sources.
- The canonical form, which is also the key a resolver and a lock see, is
  `cloud:<name-without-.proschi>:<tag>`. So `cloud:orders`,
  `cloud:orders.proschi` and `cloud:orders:latest` are one file.
- A relative import inside a version reads the files saved with it:
  `cloud:orders:v1//db.proschi`, relative to the diagram, never above it.
  Other remote sources inside a version resolve as usual.
- Bad names and tags are errors that say what is allowed. Implemented in
  `parseRemoteSpec` / `formatRemoteSpec` (`frontend/src/dsl/imports.ts`).

## V5. Your own account only

`<name>` is looked up in the signed-in user's account, nobody else's. There
is no `cloud:user/name` form and no sharing of versions between accounts
(yet). Consequences:

- A diagram with `cloud:` imports renders for its owner. Anyone else, and a
  signed-out editor, sees the import as unresolved, with the reason.
- A `cloud:` import inside a `git:` or `https://` file is an error: a shared
  file names no account, so the reference would mean something different
  for every reader.
- Share links carry the resolved versions in the link, like other imports
  (I5), so a recipient sees what the owner saw.

## V6. The one fetch the browser makes

I5 says the browser never fetches imports. `cloud:` sources are a
deliberate, narrow exception: before the synchronous parse, the web editor
lists the versions a document needs (`cloudSpecsOf` in
`frontend/src/dsl/imports.ts`, repeated until it finds nothing new),
fetches each from `GET /api/me/versions/resolve?name=&tag=`, and adds the
source and its saved files to the resolver's map. The parse itself still
never touches the network.

Why it is safe where a general fetch is not:

- **Own account.** The request goes to proschi.app with the user's session
  and returns only that user's data. A diagram cannot make the browser
  contact another host, so there is no request forgery, tracking pixel or
  exfiltration channel, and no host allowlist to maintain (I6).
- **Immutable.** A tagged version never changes (V1), so it can be cached by
  `(name, tag, sha256)`. Only `latest` needs asking again, and it can only
  move to another version the user saved.
- **Pinned in the CLI.** The CLI keeps I3 and I4: only
  `proschi imports sync` fetches, and it writes the concrete tag and sha256
  `latest` resolved to into `proschi.lock`. Render, check, the language
  server and the plugin read the lock and the cache; `--frozen` fails when
  they disagree. Until sync supports `cloud:`, those commands say to run it
  (and that it needs `proschi login`).

## V7. Plan limits in one module, no payments

How many versions a diagram keeps, how many diagrams an account has and how
large they are, are numbers in one limits module per plan, checked by the
backend and shown by the editor. There is one plan today, free, and no
payment code. A paid plan later only adds a plan with larger numbers; no
feature is built twice.

## V8. CLI login: loopback and PKCE

`proschi login` follows RFC 8252 (OAuth for native apps): the CLI listens on
`127.0.0.1` at a random port, opens the browser at proschi.app with a PKCE
challenge (S256) and a `state`, the user signs in there, and the browser is
redirected to the loopback address with a one-time code that the CLI
exchanges, with its verifier, for an app token. No password or session
cookie ever passes through the CLI, and a code alone is useless without the
verifier. The token is stored readable only by the user, and can be
revoked from the account like any app token.

## V9. Its own release

Versions, `cloud:` sources and `proschi login` ship together as 0.14.0, with
their own blog post, separate from the team systems release (0.13.0).

---

## Diffs between versions

`diffDiagrams(before, after)` in `frontend/src/dsl/diff.ts` compares two
parsed diagrams structurally: nodes, use cases and systems by id, edges by
`from->to` (and their label where one pair has several), scenarios by use
case and id, requirements by what they constrain (so a new limit is a
change, not a removal and an addition), traffic by use case and capacity by
node. Each change lists the attributes that differ, old to new; source
positions and formatting never count. A renamed id is a removal and an
addition. `summarizeDiff` counts them. It is pure, so the editor, the CLI
and the backend can share it.
