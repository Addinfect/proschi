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

A state is not just a label; it does things. The vocabulary is the familiar one —
`entry`, `do`, `exit` — with the restriction that keeps it checkable: `entry` and
`exit` may only assign a **constant** to a declared output (`entry { output = 1 }`),
never an expression, and `do` names a continuous activity without writing anything
(an activity that writes is a state of its own).

Two notations, one meaning. `output = 1` written on the state is shorthand for
`entry { output = 1 }`. **Implemented is only the canonical one** — `entry` and
`exit` as one string of `name = value` pieces, with the names declared by the
machine in `outputs` (see `frontend/src/ontology/README.md`). The shorthand needs
the output names to be attributes, which ties the ontology to one project's
signals; it can come back the day a `signal` node can be named by id. `sets: output = 0` on a transition is redundant with
`entry`/`exit`, and survives only as an *assertion*: a declared change has to
agree with what the two states' entries imply, or the model contradicts itself.

Because the model has no time, three simplifications hold — and they are what make
the checks cheap:

- `exit` is a default for the successors that do not write the variable; there is
  no "during the transition" to distinguish from "on entry".
- A variable holds the value the path last wrote. A state that does not write it
  keeps it, which is the `WAIT()` case.
- A path is a finite walk, so the value of a variable in a state is computable from
  the graph alone.

So a check has three outcomes: *agrees*, *contradicts*, or **path-dependent** —
"in `WAIT`, `output` is `1` via `ON` and `0` via `OFF`". Path-dependence is not
the same as a mistake: it is the smell that behaviour depends on history, and it
is precisely what an emergency-stop requirement must not have.

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

### Requirements as prose, and as property

TRLC holds **application** requirements, written as prose, reviewed by people. The
diagram is *one* model of how such a requirement could be implemented — it does
not restate the sentence. So a requirement node carries `source`, the links, and
**optionally** a `check`: one named predicate over the design, such as
`no-output-active` evaluated over the states reachable after `estop`.

That "optionally" is the design, not a compromise. Most requirements stay prose
with traceability links: the finding they earn is "nothing implements it". A few
are graph properties and get a predicate. Nothing anywhere promises that the tool
verifies a German sentence.

The risk to say out loud: prose and formalisation are two artifacts, and they
drift. The sentence grows "for more than 20 ms", the predicate still checks
"never", the check stays green while the requirement moved. The tool cannot close
that gap. It can only show the two side by side, and mark a predicate stale when
the requirement behind it changed.

Which is the real use of an AI here: let it propose the sentence *and* the
formalisation together, and let the checker catch where the formalisation is
wrong — a mismatch against the prose is then found by a human reading both,
which is cheaper than a human writing predicates.

## 7. What we deliberately do not build

| Not building | Why |
| --- | --- |
| Variables and arithmetic inside control flow | The moment steps compute, this is a programming language with a worse debugger. Steps are named actions; a condition is a name, never an expression to evaluate. |
| Timing (`within 20 ms`) | The metamodel has no time. Saying so early is better than being asked for it later. |
| Verification of reality | A check proves the model agrees with the requirement — not the firmware with the machine. It is a review tool, and calling it verification would be a lie with consequences in a safety process. |
| Deriving the model from code | Attractive later for `includes`; not now. Hand-written control flow is *intent*, and it rots the moment it pretends to be code. |

## 8. Order of work

1. ~~**Edge attributes in `RelationSpec`**~~ — done. Triggers and guards are
   attributes on `moves-to`, and the checks that makes possible are in
   `expand.ts`: `duplicate-trigger` (one event leaves a state twice) and
   `many-defaults` (two transitions without a trigger under different guards).
   Both are machine semantics, so they stay out of `src/engine/`. What is left of
   this step is guard *overlap*, which needs predicates and is parked with them (§9).
2. ~~**`entry` / `do` / `exit` lowered onto state attributes**~~ (§4) — done, in
   three parts. Read and checked: the pieces are parsed, the names are declared, and
   `bad-effect`, `unknown-output`, `duplicate-output` and `duplicate-effect` are
   reported. Then the path analysis, in `paths.ts`: crossing a transition, the
   successor's `entry` wins, then the predecessor's `exit`, then what the path
   carried, so a state that writes nothing keeps everything and the initial state
   holds nothing until something writes it. Then the three outcomes, written as
   `sets` on an edge: agreed, `sets-undecided` (the asserted value is reachable but
   so is another one), `sets-contradicted` (no path delivers it). `sets` is an
   assertion only — it writes nothing, and the analysis says so in one place.
   `output-never-set` covers the output nobody drives at all. What is *not* checked
   from §4: arithmetic, timing, and a value that only holds while a transition
   crosses — the vocabulary has none of those, and guessing at them would be worse
   than the silence.
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
| ~~Where are output variables declared?~~ | Decided: one `outputs` attribute on the machine, comma-separated (`outputs: 'armed, mode'`), collected along the inheritance chain. Keeps the ontology free of one project's signals and still makes a typo an `unknown-output`. A `signal` node owned by the machine remains the better answer once a requirement has to name an output by id — nothing built here blocks it. |
| Does a state's attribute ever change *without* a transition? | Today: no. Interrupts write outputs asynchronously, so a model that says otherwise is a lie; if it is needed, it is a second kind of edge, not an exception to this one. |
