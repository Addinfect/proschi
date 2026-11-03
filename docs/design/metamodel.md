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
| View | `frontend/src/views/` | how to draw a graph for a reader |

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
| `machine` | `element` | drawn as a statechart, not as a box; declares `outputs`, the names it drives (`string`) |
| `state` | — | deliberately *not* an element: it belongs to one machine and appears in no structural view. Declares what it writes — `entry`, `exit`, `do`, each a `string` list of `<output>=<constant>` pieces — plus `final` (`boolean`) and `overrides` (`string`, the id of the state it replaces). It may hold states of its own; a state that does is a level of the statechart, not a configuration |

| Relation | From → To | Rule |
| --- | --- | --- |
| `depends-on` | element → element | `acyclic` — a dependency cycle is a defect |
| `uses` | element → element | cycles allowed: a flow may come back |
| `composes` | element → element | `maxIn: 1`, `acyclic` — containment is a tree |
| `realizes` | module → interface | a module fulfils a contract |
| `owns` | machine → state | `maxIn: 1` — one owner per state |
| `contains` | state → state | `maxIn: 1`, `acyclic` — the states of a machine form a tree; a contained state is still owned by its machine |
| `starts-at` | machine → state, state → state | `maxOut: 1` — one entry state; on a container, which state is entered first |
| `moves-to` | state → state | self-loops allowed; declares `trigger`, `guard` and `sets` as **edge attributes** — the first two are names, never expressions; `sets` writes nothing, it asserts what the outputs already hold on arrival |
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
`unknown-machine`, `inherits-cycle`, `unknown-override`, `initial-unknown` and, as the
only warning there, `no-initial`. The hierarchy adds `contains-cycle` (the containers
run in a circle; the hierarchy is cut there) and `no-entry` (a container does not say
which of its states it starts in), and reuses `many-parents` for a state that sits
inside two and `initial-unknown` for one starting outside itself. Reading what a state
writes adds `duplicate-output`, `bad-effect`, `unknown-output` and `duplicate-effect`;
reading the transitions adds `duplicate-trigger`, `many-defaults` and the path codes
below. One defect carries one code: an edge that leaves and enters the same node is a
`self-loop` when the relation forbids self-loops, and a `cycle` when it allows them
but forbids cycles — never both.
Each issue says which node, and the reading falls back to what it can still say — a
broken machine still gets drawn.

**A state may hold states.** The machine is then never in the container: it is in one
of the states at the bottom of the tree, so `readPaths` gives those a row each and the
containers none, and entering a container lands on the state it says it `starts-at`.
An edge written on a container stands for one crossing from each state at the bottom
of it — one edge in the model, one expanded transition per leaf, all carrying that
edge's id and saying in `declaredFrom` / `declaredTo` where it was written, which is
why the determinism checks do not fire on the copies. What a crossing writes composes:
`exit` runs from the state left outwards, `entry` from the outermost container
inwards, and the two chains meet at the lowest container both ends are inside — so
leaving a mode can set an output once instead of in every state within it.

**What a variable holds.** A machine declares `outputs`; a state writes some of them
on `entry` and `exit`; `readPaths` then answers, for every state and every output,
which values can be there and by which transition each one arrived. The rule is one
line — on arrival at `B` an output keeps `B.entry`, else the `A.exit` it was leaving
with, else what it carried in — and the answer is the fixed point of that rule over
the transitions `expandMachine` found, with the initial state seeded by its own
`entry` and by nothing else. A value that no write ever puts there is `nothing`,
which is also what a state that writes nothing carries onward. This is why `sets`
on an edge is an assertion and not an effect: it is checked against the fixed point
(`sets-contradicted` when the value is impossible, `sets-undecided` when the arrival
is not determined) and can never change it. Unreachable states are marked rather
than reported, and an output no state ever writes is `output-never-set`.

## 5. Two relations people conflate

Hierarchy (a state contains substates) and inheritance (a machine specializes
another) are different relations and are kept apart: `owns` and `contains` are
hierarchy, `inherits` is specialization. A container is not a machine with fewer
states: it declares no `outputs`, it cannot be inherited, and its `starts-at` is a
level's entry rather than a second initial state — the machine still has exactly one.
What is still missing is the other axis, orthogonal regions, which is why §7 keeps
it.

## 6. One model, many renderers

| View | Reads | Renderer |
| --- | --- | --- |
| Architecture graph | modules, interfaces; `depends-on`, `realizes` | node-link |
| Flow | the same nodes along `uses` / `composes` | node-link, boxed |
| Statechart | one machine via `expandMachine` | Harel-style |

A view reads the model and never owns data, and it may not add a rule the ontology
does not declare. Adding a view is therefore a renderer, not a second model — which
is why the three can share one graph and one set of checks.

The piece all three share is written: `views/scope.ts` reads **one level of a tree**,
as a reader has opened it. `composes` and `contains` are those trees, and a scope is
a node that is opened or nothing for the top level. What sits deeper is folded into
its box; an edge with an end outside the scope is lifted to the boundary and marked
`crosses`; edges lifted the same way are one edge with a `count` and its `members`,
so collapsing three arrows into one does not lose the three. The spec names relations
and not types, so the same function reads the cloud vocabulary the day it becomes an
`OntologySpec`. A broken tree is not a view's finding: the only issue a scope raises
is `unknown-root`.

## 7. What is still open

| Gap | Why it is not closed yet |
| --- | --- |
| **Orthogonal regions** | `contains` made the hierarchy a tree, so a machine is in exactly one state at a time. Two aspects holding at once — operating state × safety state — need a second relation and a reading that runs two hierarchies side by side. Composite states themselves are in: `expandMachine` walks `contains` and `readPaths` reads a crossing as a chain. |
| **Unreachable states** | `readPaths` marks each state `reachable: false` and says so when a `sets` assertion depends on it, but it raises no issue of its own — a state nobody reaches is worth reporting, and worth deciding whether it is an error. |
| **Layer order** | `layer` is a closed list of words; it does not say that `presentation` may only depend on `application`. That is an order between types, which the metamodel cannot express. |
| **Dead-dependency detector** | The draft's "declared `depends-on` but never `uses` — is it really a dependency?" is a cross-relation query nobody has written. |
| **The existing cloud vocabulary** | `frontend/src/dsl/kinds.ts` (17 kinds: database, pipeline, instance, …) still stands beside this ontology. It is to become one more `OntologySpec` — the lower layer — with the file untouched until the views can read either. |

**Edge attributes are no longer on this list.** `RelationSpec` and `ResolvedRelation`
now carry `attributes`, so an edge is checked against its relation exactly as a node
is checked against its type — same function, same codes (`unknown-attribute`,
`missing-attribute`, `attribute-kind`, `attribute-value`) — and `buildOntology`
rejects a relation that declares a kind or an allowed value the engine cannot take
(`bad-attribute-kind`, `bad-attribute-value`). The transition trigger is therefore
data: `moves-to` declares `trigger` and `guard` as `string`, and `Edge.label` is a
caption again. `expandMachine` still falls back to the label, so a graph written
before the change keeps its behaviour; the fallback is one expression in one place.
What this unlocks is the interesting part: with a trigger named in the model, "a
transition with no trigger is the default", "two defaults leave one state" and "the
same trigger twice is a nondeterminism" become checkable questions rather than
drawing conventions.
