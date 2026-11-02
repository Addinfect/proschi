# The metamodel, as built

> Status: **implemented** in the commits below, not a plan. The v0.1 drafts this
> came from (`metamodel-draft.md`, `engine-boundary.md`) described an API and a
> licensing gate from before the source was available; where they disagree with
> this page, this page is what the code does and §7 says why.

| Commit | What it sealed |
| --- | --- |
| `96e8270` | `frontend/src/engine/` — a typed graph with no subject matter |
| `c74d4f5` | `frontend/src/ontology/` — the architecture vocabulary on top of it |

Base: a fork of [gvart/proschi](https://github.com/gvart/proschi) (MIT; LICENSE and
copyright notices kept), branch `reengineer/seal-engine`.

## 1. The seam

Four layers, each knowing only the one below:

| Layer | Lives in | Knows |
| --- | --- | --- |
| Engine | `frontend/src/engine/` | nodes, edges, types, relations, checks |
| Ontology | `frontend/src/ontology/` | the subject matter, as data |
| View | `frontend/src/views/` *(not written yet)* | how to draw a graph for a reader |

There is no model layer: the editor keeps the text, and the engine takes the
graph as an argument on every call. `frontend/src/model/` already exists and
means the numbers pinned into the simulation page (`pins.ts`) — taken, and not
to be reused.

`npm run check:engine-boundary` fails the build when the engine imports from
outside itself or mentions a word from its subject matter. The ban-list is data in
`frontend/scripts/check-engine-boundary.mjs`, so the prose can name the rule
without tripping over it. The test for the seam: an ontology about some entirely
different subject should work with no change to `src/engine/`.

## 2. The decisions worth knowing

**Relations are data.** "Depends-on must be a DAG" is a row in
`src/ontology/architecture.ts`, not product code: `acyclic: true` makes the engine
produce the `cycle` issue and makes `topologicalOrder` refuse. Flipping that flag
changes behaviour with no code change.

**Ontologies are TypeScript, not YAML.** The draft proposed a YAML registry with a
loader. Typed data gets checked by `tsc` — a misspelled attribute name or a
relation naming a type that does not exist fails the build — with no parser, no
runtime format and no schema to keep in step. A project that talks differently
writes another `OntologySpec` beside this one.

**The engine is read-only.** The draft sketched `createNode`/`updateNode` mutators.
What was built takes the graph as an argument and returns issues:
`validateGraph(graph, ontology)`, `indexGraph(graph)`, `expandMachine(graph, id)`.
Mutation stays in the editor, where the text and its undo live; the engine only
ever sees a finished graph. A pure function is what makes the checks testable
and the views free of state.

**Attributes are scalars.** `string | number | boolean`, and an absent key means
"not set" — there is no `null`. The kinds are spelled exactly as `typeof` returns
them so validation is one comparison. The price (no lists, no nested values) is
paid deliberately; see the engine README for what widening it would take.

**An override names an id.** Ids are unique per node, labels are not, so
replacement is something the model says rather than a side effect of two names
matching. This is what lets a machine be refined without the refinement being
indistinguishable from a coincidence.

## 3. Vocabulary

| Type | Extends | Notes |
| --- | --- | --- |
| `element` | — | abstract; exists so relations can say "any structural thing" |
| `module` | `element` | a unit of code with a boundary |
| `interface` | `element` | a contract, depended on rather than known |
| `machine` | `element` | drawn as a statechart, not as a box |
| `state` | — | deliberately *not* an element: it belongs to one machine and appears in no structural view |

| Relation | From → To | Rule |
| --- | --- | --- |
| `depends-on` | element → element | `acyclic` — a dependency cycle is a defect |
| `uses` | element → element | cycles allowed: a flow may come back |
| `composes` | element → element | `maxIn: 1`, `acyclic` — containment is a tree |
| `realizes` | module → interface | a module fulfils a contract |
| `owns` | machine → state | `maxIn: 1` — one owner per state |
| `starts-at` | machine → state | `maxOut: 1` — one entry state |
| `moves-to` | state → state | self-loops allowed; the edge **label** is the trigger |
| `inherits` | machine → machine | `maxOut: 1`, `acyclic` — one parent, so what is inherited is never in doubt |

Choosing between `uses` and `depends-on` is the whole product: a compile-time need
must not cycle, a runtime call may.

## 4. Behaviour

`expandMachine(graph, id)` reads a machine through its `inherits` chain and returns
the states and transitions **in force**: ancestors first in the order they declared
them, so refining a machine extends the picture instead of reshuffling it. Every
state carries `declaredBy`, and every transition whose end an override moved is
flagged `retargeted` — provenance is visible, not lost.

Problems are values, never exceptions. The engine reports `cycle`, `missing-attribute`,
`abstract-type`, `too-many-in` and the rest; the ontology layer adds
`unknown-machine`, `inherits-cycle`, `unknown-override`, `initial-unknown` and one
warning, `no-initial`. Each issue says which node, and the reading falls back to
what it can still say — a broken machine still gets drawn.

## 5. Two relations people conflate

Hierarchy (a state contains substates) and inheritance (a machine specializes
another) are different relations and are kept apart: `owns` is hierarchy,
`inherits` is specialization. Today the hierarchy is flat — one machine owns its
states, no nesting — which is why §7 lists composite states as the next gap rather
than as a design question.

## 6. One model, many renderers

| View | Reads | Renderer |
| --- | --- | --- |
| Architecture graph | modules, interfaces; `depends-on`, `realizes` | node-link |
| Flow | the same nodes along `uses` / `composes` | node-link, boxed |
| Statechart | one machine via `expandMachine` | Harel-style |

A view reads the model and never owns data, and it may not add a rule the ontology
does not declare. Adding a view is therefore a renderer, not a second model — which
is why the three can share one graph and one set of checks.

## 7. What is still open

| Gap | Why it is not closed yet |
| --- | --- |
| **Edge attributes** | `RelationSpec` has no `attributes`, so nothing can check what an edge carries. The transition trigger therefore lives in `Edge.label`; when the field exists it becomes a declared attribute and the label goes back to being a caption. |
| **Composite / orthogonal states** | Needs `owns` between states plus an entry rule. The metamodel can already express the edges; the reading in `expandMachine` does not walk them. |
| **Unreachable states** | `expandMachine` reports a missing entry state but not a state no transition reaches. `reachableFrom` already exists. |
| **Layer order** | `layer` is a closed list of words; it does not say that `presentation` may only depend on `application`. That is an order between types, which the metamodel cannot express. |
| **Dead-dependency detector** | The draft's "declared `depends-on` but never `uses` — is it really a dependency?" is a cross-relation query nobody has written. |
| **The existing cloud vocabulary** | `frontend/src/dsl/kinds.ts` (17 kinds: database, pipeline, instance, …) still stands beside this ontology. It is to become one more `OntologySpec` — the lower layer — with the file untouched until the views can read either. |
