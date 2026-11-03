# Views

How to draw a graph for a reader. A view reads the model and owns no data: it takes
the graph as an argument, returns plain objects, and never adds a rule the ontology
does not declare. That is what lets several readings share one graph and one set of
checks.

```
engine ──▶ ontology ──▶ views
nodes,      the subject    how to draw
edges,      matter, as     one graph
checks      data           for a reader
```

## `scope.ts`

One level of a tree, as a reader has opened it. `composes` (structure) and
`contains` (behaviour) are the trees; a scope is a node that is opened, or nothing
for the top level.

```ts
readScope(graph, { nests: 'composes', draws: ['depends-on', 'realizes'] })
readScope(graph, { root: 'control', nests: 'composes', draws: ['depends-on'] })
```

The spec names relations, not types, so a second ontology works with the same
function. What comes back:

| Field | Meaning |
| --- | --- |
| `boxes` | the nodes drawn at this level, in model order, with the ids of what sits directly inside each |
| `edges` | the edges between those boxes, with `from`, `to`, `count`, `members` and `crosses` |
| `issues` | `unknown-root`, and nothing else — a broken tree is the checker's finding |

Three rules, and the reasons for them:

- **What sits deeper is folded into its box.** Opening the box is the same call with
  a deeper root, so a level loses nothing that the next level cannot restore.
- **An edge with an end outside the scope is lifted to the boundary** and marked
  `crosses`, which is what a renderer draws as a stub.
- **Edges lifted the same way are one edge.** `count` says how many, `members` says
  which — because collapsing three internal edges into one arrow is only honest if
  the three can be named again.

An edge that touches a box is drawn at the level of that box: something inside `b`
that points at `b` is a loop on the box (`b -> b`). Hiding it would make a box look
quiet while it is not. The price is that an edge written `b` to something outside the
opened node is drawn as `root -> root` with `crosses`; the renderer decides how to
draw an arrow that begins at the frame it is drawn in.

## Not written yet

The renderers themselves (§6 of `docs/design/metamodel.md`): architecture graph, flow,
Harel-style statechart, and the control-flow reading of `step` nodes. The behaviour
reading mostly exists already as `expandMachine` and `readPaths` in `src/ontology/`,
and is not a scope question — a statechart is not drawn one level at a time.
