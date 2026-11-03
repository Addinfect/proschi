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
// layout.edges[] {relation, from, to, kind, count, members, crosses, head, path: Point[], label: Point}
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
| `cross` | an end is outside the scope | through the wall of the opened node, and out |

Two things this deliberately does not do. It does not measure text — a box widens
with its label by an approximation (`charWidth`), because measuring needs a DOM and
that would put the layout in the browser. And it does not avoid crossings: a
`depends-on` cycle ranks as far as the cap allows and its closing edge becomes a
`back` edge, so a broken model still produces a finite picture. The checker has
already said the model is broken; this only refuses to hang on it.

A level that was opened is framed, and a `cross` edge runs *through* the wall and
stops outside it: the frame is a boundary, not a destination, and a line that ends
on it would say the opposite. That is why an arrow carries `head`: only an end that
lands on a box gets a point. The rest of the edge is behind the frame, one click
away, not lost.

Arrows do not share an anchor. Two relations leaving one box used to start on the
same pixel and read as one line that forks; each end is now spread evenly along the
side it uses, and a side with a single arrow keeps the middle.

Neither do they share a lane. Arrows crossing the same gap each get a horizontal line
of their own, seated in the order they land so the fan does not fold over itself, and
the gap grows when more arrows need it than the default one can seat. One line for
three relations put three counts on one pixel.

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

## `ScopeCanvas.tsx`

The `<svg>`, and nothing else: one loop over a layout.

```tsx
<ScopeCanvas
  layout={layoutScope(readScope(graph, spec), { labelOf })}
  onOpen={(id) => setRoot(id)}   // a box that has something inside
  onSelect={setSelected}         // a box that does not
  selected={selected}
/>
```

It is deliberately a plain `<svg>` and not a diagram library. Positions are already
computed — there is no dragging to do, and dragging a box whose place came from a
rank would be a lie about the model — so what a library would add is hit testing,
which a `<rect>` does by itself. A box is a `<g role="button" tabIndex={0}>` with
an `aria-label`, so click, hover, focus, Enter and Space come from the platform.

Three decisions worth naming:

- **One target, one action.** A box that opens, opens; a box that closes, is marked.
  Both come from the host as callbacks — the canvas knows nothing about routes or
  stores, so where the picture lives is decided at the call site.
- **No callback, no button.** Without `onOpen`/`onSelect` a box is a rectangle and
  not a tab stop, because a control that does nothing is worse than a drawing.
- **The ink is `ink.ts`'s.** The test compares the `d` it writes with `drawnPath`,
  so the two cannot drift apart.

### The window onto the picture

A level can be bigger than the space it is drawn in, so the canvas has a camera:
three numbers on the `viewBox` (`x`, `y`, and how much of the picture's width is
shown; the height follows, because a window with its own proportions would stretch
every box).

| Gesture | What it does |
| --- | --- |
| wheel | zooms about the point under the pointer, which stays where it is |
| drag | pans, and does not exist at fit — there is nothing past the edge then |
| double click | back to the whole picture |

Four rules make it behave without a library:

- **The camera cannot leave the picture.** It is clamped to the edges and to at most
  `MAX_ZOOM` times the fit, which is why zooming out of a corner lands on the whole
  picture without being told to.
- **A drag is not a click.** A press that wanders more than `DRAG_SLOP` pans, and the
  click that follows is swallowed in the capture phase — otherwise the box the pan
  started on would open. Pointer capture is taken only once it *is* a pan, for the
  same reason in reverse: a captured press retargets its own click onto the `<svg>`.
- **Another level resets it.** A camera belongs to a picture; `layout` changed means
  fit.
- **It changes nothing below.** The camera is not a `<g transform>`: no box is moved,
  no arrow is re-routed, and `layoutScope` never hears about it.

Not here yet: the keyboard. The arrow keys are free (`boxInk` claims only Enter and
Space), so panning them is a `tabIndex` on the `<svg>` and one more handler.

## Not written yet

The two readings
that are not a level of a tree (§6 of `docs/design/metamodel.md`): the Harel-style
statechart and the control-flow reading of `step` nodes. Both are drawn from
`expandMachine`/`readPaths` in `src/ontology/`, and are not scope
questions — a statechart is not drawn one level at a time.
