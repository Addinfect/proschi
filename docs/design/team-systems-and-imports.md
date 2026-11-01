# Design: team systems and imports

Status: accepted · Applies to: language, simulation, tooling, web editor

## Goal

Org-level diagrams. A drone startup has teams Frontend, Orders, Warehouse and
Feed; each team owns a full `.proschi` design with its own traffic, capacity
and requirements. In the org diagram each team is one box, expanded only when
you want to deep-dive. When one team sends more traffic into another, the
simulation says, on the org diagram and without expanding anything, that the
other team's design cannot take it or breaks its SLA.

This page records the decisions behind that feature (D1 to D7) and the
decisions about where imported files may come from (I1 to I6).

---

## D1. A `system` keyword, not an extended `group`

```proschi fragment
system orders "Order Processing" @Orders {
  from "./teams/orders.proschi"
  expose api "Orders API" -> "Place order"
  capacity { 2k rps p99 150ms availability 99.95% }
}
web -> orders.api : place order
```

A group is a drawing frame around nodes of one scope; a system is a separate
scope with a contract. Overloading `group` would make every group a scope
boundary or need a flag that changes what ids mean, so it gets its own word.

- Header: `system id ["Name"] [@team] [pos x,y] [color c] [.tag] [rank N] {`,
  at the top level or inside a group. `system` is a keyword only in that
  shape (a line ending in `{`), so a node may still be called `system`.
- `from "path"`: the team's design (optional).
- `expose id ["Name"] [-> "Use case"]`: an entry point, mapped to one of the
  team's use cases. The mapping may be left out when the team file has
  exactly one use case, and must be left out without `from`.
- `capacity { … }`: a stub contract for a system without `from`: a rate, a
  `p99` (or `latency`, a mean) and an `availability`, written like a
  `capacity` line without the node id. On one line or over several.
- Outside the block, `orders.api` names an entry point and `orders` the whole
  box. `orders.api` is one reference (no space before the dot); `b .tag` with
  a space is still a tag, and `b.tag` on a connection to a non-system stays a
  tag as before.

## D2. A system has its own scope

The file named by `from` is parsed on its own, as if it were a root document:
its ids, title, summary, `direction`, `layout`, traffic, requirements,
capacity and tests stay inside it and never clash with the parent. Seen from
outside, its ids are namespaced: `orders.db` is the `db` of the Orders file.
Nested systems inside a team file are allowed; the files of the `import` and
`from` chain together are checked for cycles, with the same message style as
an import cycle. A file used by several systems is parsed once per root
parse.

Rules at the boundary:

- **Edges from outside reach only exposed entry points.** `web -> orders.db`
  is an **error** when `db` is not exposed. A hidden dependency bypasses the
  contract: the load would not reach the team's simulation, and the edge has
  nowhere to go when the box is collapsed. Expose it, or connect to an entry
  point. An unknown entry point is an error too, with the closest match.
- `orders` alone may be used by edges (drawing only) and by steps when the
  system has exactly one entry point; with several, a step must name one.
- Diagnostics of the team file are reported with its path, like an import.

## D3. The collapsed box's numbers are derived

A system's contract is computed from its team file, once per system per
analysis (and memoised per parsed team diagram):

- **Promise**: the team's own `requirements`: the latency limits and
  availability of the use case each entry point maps to (a requirement for
  that use case, else one for every use case).
- **Headroom**: per entry point, how much extra load on its use case the
  team's design takes on top of its own traffic before a node runs hot (over
  70%) and before one saturates (100%), and which node that is. Load is
  linear in traffic, so this is solved per node from the load of 1 rps.

Without `from`, the `capacity { … }` stub is the contract: the rate is the
saturation point, the p99 and availability the promise. Both a `from` and a
stub is a warning; the file wins. A system with neither is a warning: it is
drawn but not simulated.

## D4. Load flows in through entry points

When a step of a parent use case hits `orders.api`, its rate (traffic ×
scenario share × fan-out) is added on top of the team's own traffic for the
mapped use case, and the team design is analysed under that combined load.
The results are attached to the system node:

- saturation: "Orders: 1.8k rps into 'Place order' (api); its design
  saturates at 1.2k rps (warehouse-db)";
- runs hot, the same way at 70%;
- SLA breach: a team requirement on that use case that fails under the
  combined load.

In the parent simulation the system behaves like one hop: its latency is the
team use case's simulated latency under the combined load, its availability
that use case's availability. A stub behaves like a node with the stub's
capacity, latency and availability.

## D5. One resolver for `import` and `from`

`from` paths go through the same synchronous `ImportResolver` as `import`,
unchanged and with the raw path. Whatever the resolver enforces (project
root, sources, the lock file below) applies to team files too. A resolver
error named `ImportError` is reported with its own message.

## D6. A pure view transform

`viewDiagram(diagram, { expanded, focus })` in `frontend/src/dsl/view.ts`
returns a layout-ready `Diagram`:

- collapsed (the default): the system is one node of kind `system`; edges and
  steps to its entry points end at the box;
- expanded: the system is a frame (a `group` with `system` set to its id, so
  today's layout handles it), its team design inside under namespaced ids,
  and edges to an entry point rerouted to where the mapped use case starts:
  the sender of its first request, or the receiver when that sender is a
  client (the team file's stand-in for its callers);
- `focus`: only that system's team design, for navigating into it.

The web editor, the CLI renderer, the terminal and the plugin use it; the
parsed diagram itself is the collapsed view.

## D7. This page

The decision log for systems and imports lives here, starting with this
document.

---

## Where imports come from (implemented separately)

- **I1. Project root.** Imports and `from` paths are confined to the project
  root: the nearest `proschi.json`, else the git root. Absolute paths and
  paths that escape the root are errors.
- **I2. Remote sources.** `git:host/org/repo//path@ref` and `https://…`.
- **I3. Only sync touches the network.** `proschi imports sync` fetches remote
  sources and writes `proschi.lock` (the exact commit and a sha256 per file)
  and a local cache. Trust on first sync; `--frozen` fails when the lock and
  the source disagree.
- **I4. Everything else reads the cache.** Render, check, the language server
  and the plugin never fetch.
- **I5. The browser never fetches imports.** `proschi share` bundles them into
  the link.
- **I6. Out of scope:** a fetch proxy for the browser, a host allowlist,
  workspace aliases.
