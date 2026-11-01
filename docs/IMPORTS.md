# Imports

`import` pulls another `.proschi` file into a document, so you can write
the infrastructure once and keep use cases in other files.

```proschi
# infra.proschi
title "Shop infrastructure"
gateway  "API Gateway"   [AWS API Gateway]
orders   "Order Service" [REST API] @Orders
ordersDb [PostgreSQL]
gateway -> orders
orders  -> ordersDb
```

```proschi fragment
# checkout.proschi
title "Checkout"
import "infra.proschi"

usecase "Place order" {
  gateway -> orders : POST /orders
  orders -> ordersDb : INSERT order
  orders --> gateway : 201
}
```

`import "path"` goes at the top level. A [system's](SYSTEMS.md#the-system-block)
`from` file is found the same way.

## How imported files combine

- **Paths** are relative to the importing file, and imported files may
  import others. A path may also be a [remote source](#remote-sources).
- **Everything is shared.** Nodes, groups, connections, use cases and
  [high-level design](HLD.md) blocks all join the diagram. Only the
  importing document's title counts.
- **Once only.** A file reached along several paths is included once. An
  import cycle, or a missing file, is an error on that import.
- **Unique ids.** The same id in two files is an error at the later one,
  naming the first.
- **Undeclared ids** become plain nodes only after every file is read, so a
  use case file may use nodes its imports declare.
- Problems in an imported file are reported with its path.

## Where imports are found

- **In the web editor**, among the diagrams saved in your browser, by file
  name. An opened `.proschi` file keeps its name, and a new diagram takes
  one from its title (Shop Infra becomes `shop-infra.proschi`). A folder is
  part of the name (`payments/api.proschi`). Rename or move a file in the
  list of diagrams beside the code: double-click its name, or use its
  **⋯** menu.
- **Everywhere else** (the command line and the editor and Claude Code
  plugins), on disk inside the [project root](#the-project-root), preferring
  unsaved editor text. Remote files come from the
  [sync](#syncing-remote-imports) cache.

Canvas edits only change the open document: moving, renaming or deleting
something from an imported file is refused. The problems panel prefixes an
imported file's problems with its name, and clicking one opens it.

## The project root

On disk, imports and `from` files must stay inside the project root. It is
the first of these that exists:

1. the folder of the nearest `proschi.json`, at or above the entry file (the
   file you check, render or open);
2. the root of its git repository;
3. the entry file's folder.

Inside the root, `../` works. An absolute path, a path that leaves the root
and a symlink to a file outside it are errors.

To import from above the entry file outside a repository, put a
`proschi.json` containing `{}` in a folder that holds both files.

## Remote sources

An import or a `from` can name a file in a git repository or at an https URL:

```proschi fragment
import "git:github.com/acme/platform//diagrams/infra.proschi@v1.4.0"
import "https://example.com/diagrams/shared.proschi"
```

- A git source is `git:<host>/<org>/<repo>//<path>@<ref>`. The `//` ends the
  repository, and the ref is a tag, branch or commit. Your own `git` fetches
  it, with your credentials and `url.<base>.insteadOf` settings, from
  `https://<host>/<org>/<repo>.git` by default.
- Only `https://` URLs work, without a user name, password or `#fragment`.
- A relative import inside a remote file reads from the same repository and
  ref, or the same origin, and may not leave it.
- The web editor never fetches. A remote file reaches the browser only
  inside a link made by [`proschi share-link`](EDITORS.md#imports).
  `cloud:` sources are the one exception (below).

## Cloud sources

A `cloud:` source names a [saved version](VERSIONS.md) of a diagram in your
own Proschi account:

```proschi fragment
import "cloud:shared-infra"
system orders "Order Processing" @Orders {
  from "cloud:orders:2026-11-01"
  expose api -> "Place order"
}
```

- The form is `cloud:<name>:<tag>`. `cloud:<name>` means
  `cloud:<name>:latest`, the newest version saved. `latest` never reads the
  unsaved draft.
- `<name>` is the diagram's file name in your account, with or without
  `.proschi`: letters, digits, `.`, `_`, `+`, `-` and `/`, no spaces. To
  reference a diagram whose name has a space, rename it first.
- A relative import inside a version reads the files saved with it.
- A `cloud:` source only looks in the account you are signed in to. A
  `cloud:` import inside a `git:` or `https://` file is an error, because a
  shared file names no account.

**In the web editor**, signed in, the editor fetches each version the
diagram needs from proschi.app before it draws. Signed out, the import is
unresolved and says to sign in. A share link carries the fetched versions,
so the person who opens it needs no account.

**On the command line**, sign in once with
[`proschi login`](EDITORS.md#sign-in-from-the-command-line), then run
`proschi imports sync`. It pins each `cloud:` source in `proschi.lock` to the
version's tag and sha256. `cloud:orders` (latest) is pinned to the tag it
resolved to and stays there. To pick up a newer version:

```sh
proschi imports sync --update                 # every cloud:<name> (latest) import
proschi imports sync --update cloud:orders    # only this one
```

`--update` prints each old and new tag. A source with a concrete tag never
moves.

## Syncing remote imports

```sh
proschi imports sync            # every .proschi file below this folder
proschi imports sync --frozen   # in CI: fail instead of changing proschi.lock
```

`proschi imports sync [--frozen] [<file|dir>…]` is the only command that
uses the network. It writes, at the project root:

- `proschi.lock`: the commit each git ref resolved to, and a sha256 of each
  file. Commit it.
- `.proschi/cache/`: the downloaded files. Add `.proschi/` to `.gitignore`.

Everything else reads the cache. The first sync trusts what it downloads.
After that, a ref stays on its locked commit, and changed content is an
error. To update, change the ref or delete its lock entry, and sync again.
`--frozen` never writes: it fails when the lock is missing, out of date or
doesn't match the source.

Limits: 1 MB per imported file, 500 files per document, 32 levels of
nesting, and 1024 characters per remote source.

## Security model for imports

Proschi never runs anything in an imported file. Beyond the rules above
(network only in `proschi imports sync`, nothing outside the project root,
no credentials in URLs), it guarantees:

- **Pinned content.** Each remote file is pinned to a sha256, and each git
  file to a commit. Review changes to `proschi.lock` like code, and an
  invalid lock is an error. `proschi share-link` reads through the same
  checks.
- **HTTPS only**, also after a redirect, with at most five redirects.
- **Git runs locked down**: a shallow fetch into a temporary bare
  repository, no checkout, hooks, submodules or `ext::` transport, and only
  regular files are read.
- **`cloud:` reads your own account only.** The web editor's one fetch
  goes to proschi.app with your session and returns only your data, so a
  diagram cannot make the browser contact any other host. A tagged version
  never changes, and its sha256 is checked against what arrives.

One gap: the Claude Code plugin cannot resolve symlinks, so it follows a
symlink in the project that points outside it. `proschi check` reports it.

## Import errors

| Message (shortened) | What to do |
|---|---|
| `… is outside the project root` | Move the file into the project, or add a `proschi.json` above both files. |
| `… is a symlink to a file outside the project root` | Copy the file into the project, or import it from git. |
| `… is an absolute path` | Write the path relative to the importing file. |
| `… run proschi imports sync` | Run `proschi imports sync`, and commit `proschi.lock`. |
| `… does not match its sha256 in proschi.lock` | Find out why it changed. If expected, delete its entry and sync again. |
| `proschi.lock is out of date` | From `--frozen`: sync locally and commit `proschi.lock`. |
| `git fetch failed` | Check that `git` reaches the repository and the ref exists. |
| `… is a version in your Proschi account; run proschi imports sync` | Run `proschi login` once, then `proschi imports sync`. |

## Go further

- [Org diagrams and team systems](SYSTEMS.md): one box per team.
- [Imports in the editors](EDITORS.md#imports): `share-link` and editor
  support.
