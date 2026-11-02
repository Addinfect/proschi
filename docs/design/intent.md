# What this fork is for

> Status: **intent**, not implementation. [`metamodel.md`](metamodel.md) says what
> the code does today; this page says what it is for and where it goes. Where the
> two differ, the gap is the work.

## 1. The job

Design and requirements documents for embedded control systems are written as
prose — increasingly by an AI — and reviewed as prose. A contradiction between
two pages is found in the review, or in the integration test, or on the machine.
The earlier it is found, the cheaper it is.

So the same content should exist as something that is *checked while it is
written*: modules and their dependencies, the control flow inside them, their
state machines, and the requirements they claim to satisfy — one model, several
readings, every reading checked against the same rules.

There are two readers, and they want different things:

- **The engineer** reviewing a design wants the contradiction: a dependency cycle,
  a transition that can never fire, a requirement nothing implements.
- **The AI** writing the document wants a target it can hit reliably — a boring,
  local grammar, loud errors and a lossless round trip, so the text can be
  regenerated and diffed. A wrong 400-line diagram nobody can check is worse than
  no diagram.

The second reader is why correctness signals matter more than looks.

## 2. Four readings, one model

| Reading | Nodes | Edges | Question |
| --- | --- | --- | --- |
| Structure | `module`, `interface` | `depends-on`, `uses`, `realizes`, `includes`, `composes` | what leans on what |
| Behaviour | `machine`, `state` | `owns`, `starts-at`, `moves-to`, `inherits` | what the system does over time |
| Control flow | `step` | guarded steps, loops | what the code inside one unit decides |
| Data flow *(later)* | the same nodes | `uses`, read/written | where a value comes from and goes |

All four read the same graph. A module drawn in the structure reading is the same
node the behaviour reading hangs a machine under, and the same node the control
flow reading opens.

**`#include` is not `depends-on`.** In real C, headers include each other in
cycles; a design rule that calls those errors is a rule nobody keeps. `includes`
is the file reality and may cycle, `depends-on` is the design intent and may not.
The difference between the two is the finding worth showing.

## 3. Nesting is zooming

A module can be opened: the view then shows what is inside it. This is **not**
nesting in the model — the graph stays flat, `composes` makes it a tree, and a
view is given a *scope* (a subtree) and draws what that scope contains.

Two consequences to design for, not around:

- **Edges cross the boundary.** With a scope open, an edge from inside to outside
  is lifted to the boundary and drawn as a stub; several internal edges that leave
  the same way collapse into one. Collapsing and re-expanding must not lose the
  information that there were three.
- **The same node appears in several readings, and in several scopes.** That is
  why the model must not nest: one node, one identity, many views.

## 4. What a state says about the world

A state is not just a label; it asserts things. `ON` says the output is `1`,
`OFF` says it is `0`, `WAIT` says nothing. Every state therefore carries
attributes, and a transition may declare an effect (`sets: output = 0`).

That gives the check this fork exists for:

- The output value is a property of the **state**, so "it does not change when we
  pass through" is not an effect anybody can forget to declare — it is the absence
  of a difference between the two states. Drift is impossible by construction.
- A declared effect is cross-checked against the difference of the two states: a
  transition claiming `output = 0` into a state that says `output = 1` is a
  contradiction, and it is found without running anything.

**Absent means "not asserted", not "inherited".** `WAIT` without an `output`
attribute is a hole in the model, not a promise to keep the previous value, and
the check says so in three outcomes: *agrees*, *contradicts*, or **unknown** —
"`WAIT` says nothing about `output`, so stability is not proven". Silent
inheritance would fill the hole and hide exactly the thing worth seeing.

## 5. Orthogonal regions, not more inheritance

Emergency stop applies regardless of what the machine is otherwise doing. Modelled
flat, that is one `estop` edge out of *every* state — n edges, and the next state
somebody adds is missing one. Orthogonal regions (operating state × safety state)
make it one edge that cannot be forgotten.

So machine inheritance — modelled because the first draft asked for it, and rarely
used in C — stays as it is and is not extended further; composite and orthogonal
states are the next real work, with the emergency stop as the test case:

> Pressing emergency stop leads to no output being driven — where "no output
> driven" is a state in which every declared output is `0`.

## 6. Requirements: trace first, check second

**Stage one — traceability, no checker.** A requirement is a node;
`satisfied-by` points at the states or transitions that implement it. What this
shows immediately is the review finding that matters: requirements nothing
implements, and behaviour no requirement claims. This is small and it is most of
the value.

**Stage two — checked predicates.** Not free text: a small closed list of named
predicates, each with code and a test behind it, evaluated in the existing
`requirements { … }` block the simulator already reads
(`p99 "Open a link" < 50ms`). The emergency stop becomes one predicate over
states reachable from an event, which the engine can already answer.

The requirement text itself should **not** be duplicated here. Two copies of a
sentence diverge. A requirement node names its source
(`source = "trlc:VEHICLE.Safety.EST-017"`) and the statement lives where it is
reviewed.

### TRLC

[TRLC](https://github.com/bmw-software-engineering/trlc) — *Treat Requirements
Like Code*, from BMW Software Engineering: requirement files in a text format,
compiled, with linking and linting, used in safety-critical projects. If it is
adopted, the split is clean: **TRLC owns requirement text and the links between
requirements; this model owns the design and points into it.** Neither duplicates
the other.

That is why `source` is an attribute and not a hard dependency: checking that a
referenced record exists is a text scan over the `.trlc` files, which belongs in a
script or in CI, not in a browser. Adopting TRLC later then costs an importer, not
a rework.

## 7. What we deliberately do not build

| Not building | Why |
| --- | --- |
| Variables and arithmetic inside control flow | The moment steps compute, this is a programming language with a worse debugger. Steps are named actions; a condition is a name, never an expression to evaluate. |
| Timing (`within 20 ms`) | The metamodel has no time. Saying so early is better than being asked for it later. |
| Verification of reality | A check proves the model agrees with the requirement — not the firmware with the machine. It is a review tool, and calling it verification would be a lie with consequences in a safety process. |
| Deriving the model from code | Attractive later for `includes`; not now. Hand-written control flow is *intent*, and it rots the moment it pretends to be code. |

## 8. Order of work

1. **Edge attributes in `RelationSpec`** — triggers, guards and effects become
   data. Everything else is blocked on this; the label convention was fine for
   drawing and is not fine for checking.
2. **State attributes, effects and the three-outcome check** (§4).
3. **Composite and orthogonal states** (§5), emergency stop as the test case.
4. **`src/views/` with a scope** (§3) — structure, behaviour, control flow.
5. **Control flow** as a reading: `step` nodes, guarded steps, loops, and the four
   cheap findings — missing else, unreachable step, loop with no exit, two guards
   that can both fire.
6. **Requirements, stage one**, TRLC-compatible by name.
7. **Renderer and animation** on the existing `usecase` player, not a new one.
8. Checked requirement predicates.

## 9. Open

| Question | Note |
| --- | --- |
| One edge for both `state` and `step`? | Their graphs are structurally the same: nodes, guarded edges, loops allowed, entry marked. Unifying `moves-to` to work on an abstract `vertex` (with `state` and `step` below it) makes control flow nearly free and the determinism check shared. Cost: a small change to the committed ontology and its test. |
| Does a state's attribute ever change *without* a transition? | Today: no. Interrupts write outputs asynchronously, so a model that says otherwise is a lie; if it is needed, it is a second kind of edge, not an exception to this one. |
