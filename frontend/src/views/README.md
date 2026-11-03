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

## `layout.ts`

Where the boxes go. `readScope` says what a level is; this says where it sits and
how the arrows run, as numbers.

```ts
const layout = layoutScope(readScope(graph, spec), { labelOf: (id) => nameOf[id] });
// layout.frame?  {x, y, width, height}   the opened node, drawn around the level
// layout.boxes[] {id, label, x, y, width, height, children}
// layout.edges[] {relation, from, to, kind, count, members, crosses, path: Point[], label: Point}
// layout.width, layout.height            the canvas
```

The ranks are the model's own direction: a box sits below everything it points at,
from the longest path along the drawn edges, in model order within a rank. No ELK,
no worker, no DOM — the whole file is arithmetic, so the picture can be checked
without a browser, and painting it is a `<svg>` that loops over the result.

Four routes, and `kind` says which one an arrow got:

| `kind` | When | Drawn as |
| --- | --- | --- |
| `forward` | to a lower rank | out of the bottom, into the top, one elbow |
| `back` | to the same or a higher rank | around the left of both boxes |
| `self` | both ends on one box | a loop on its right edge |
| `cross` | an end is outside the scope | a stub on the frame of the opened node |

Two things this deliberately does not do. It does not measure text — a box widens
with its label by an approximation (`charWidth`), because measuring needs a DOM and
that would put the layout in the browser. And it does not avoid crossings: a
`depends-on` cycle ranks as far as the cap allows and its closing edge becomes a
`back` edge, so a broken model still produces a finite picture. The checker has
already said the model is broken; this only refuses to hang on it.

A level that was opened is framed, and the frame is where a `cross` edge stops —
which is what `crosses` means: the rest of the edge is behind the frame, one click
away, not lost.

## `ink.ts`

The last step before a `<svg>`: attribute strings.

```ts
const d = drawnPath(edge);      // the line, stopped at the base of the head
const head = headPath(edge);    // the filled triangle, turned into the last leg
const text = fitLabel(box.label, box.width, { charWidth: 7 });
```

Strings are what an element needs and what a test can read, so this file has no
DOM either. Two decisions belong here, and only here: the line has to stop where
the head begins, or the stroke runs out past the point; and a label longer than its
box is shortened with an ellipsis, because a box that grows with its label would
undo the ranks. Colour, dash and weight are the stylesheet's business: `kind` is
handed out by the layout and styled by CSS.

## Not written yet

The component that loops over a layout and returns a `<svg>`, and the two readings
that are not a level of a tree (§6 of `docs/design/metamodel.md`): the Harel-style
statechart and the control-flow reading of `step` nodes. Both are drawn from
`expandMachine`/`readPaths` in `src/ontology/`, and are not scope questions — a statechart is not drawn one level at a time.
