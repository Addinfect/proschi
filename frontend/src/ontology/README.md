# The architecture ontology

The engine knows nodes, edges, types and relations. This directory says what the
names mean for software architecture, and how to read one graph three ways. Why
the vocabulary is cut this way, and what it cannot express yet, is in
[`docs/design/metamodel.md`](../../../docs/design/metamodel.md).

```
architecture.ts      ARCHITECTURE: types, relations, layer vocabulary — plain data
expand.ts            expandMachine(): inheritance flattened, a state hierarchy read
paths.ts             readPaths(): what each output may hold in each state, checked
architecture.test.ts
paths.test.ts
hierarchy.test.ts
```

## One graph, three readings

| Reading | Relation | Question it answers |
| --- | --- | --- |
| Structure | `depends-on` (acyclic) | what may call what; what a layer may see |
| Flow | `uses`, `composes` | what is built from what; which path data takes |
| Behaviour | `owns`, `contains`, `starts-at`, `moves-to`, `inherits` | what a machine does |

The three share one node set, so a module drawn in the structure view is the same
node the behaviour view names. `depends-on` is declared `acyclic: true`, which
makes the engine report a `cycle` issue and lets `topologicalOrder` answer "in
what order can these be built". `uses` deliberately omits it: a flow may come
back.

`element` is `instantiable: false`. It exists so relations can say "any element"
without inventing a node nobody draws; the engine reports `abstract-type` when a
model tries to use it directly.

## An override names an id, not a type

`state` carries a free `overrides` attribute holding the **id** of the state it
replaces:

```ts
{ id: 'undoing', type: STATE, attributes: { overrides: 'rendering' } }
```

Ids are the only thing unique per node — a type name is shared by every node of
that type — so an override that pointed at a type could not say which one it
meant. `expandMachine` walks the `inherits` chain ancestors-first, keeps the
order the parent declared, and puts the overriding state in the slot of the state
it replaces. Transitions are then resolved through the same map, so an inherited
`parsing → rendering` becomes `parsing → undoing` and is flagged
`retargeted: true`; the view can show the seam instead of hiding it.

Two consequences worth keeping:

- A state may not override a state its own machine declares (`double-override`) —
  that is not overriding, that is naming.
- If the replaced state is not in force at that point in the chain the override
  is unknown (`unknown-override`). It is reported, not silently dropped.

## The trigger is an attribute

`RelationSpec` declares what an edge carries, and `validateGraph` checks an edge
against that declaration exactly as it checks a node against its type. `moves-to`
declares two string attributes — both **names**, never expressions, because nothing
evaluates them:

```ts
{
  id: 't1',
  relation: MOVES_TO,
  source: 'idle',
  target: 'parsing',
  attributes: { [TRIGGER]: 'input', [GUARD]: 'ready' },
}
```

`expandMachine` reads them into `TransitionView.trigger` and `.guard`. `label` is
back to being a caption. A model written before relations could declare
attributes still reads its trigger from the label; that fallback is one expression
in `expand.ts`, so it goes in a single commit once those models are migrated.

## What a trigger rules out

An event names what the machine waits for, and a machine is in one state at a
time. Two transitions that leave the same state on the same event *and* the same
guard therefore leave the next state undecided, which is an error rather than a
choice left to the reader:

- `duplicate-trigger` — the same event leaves one state twice (same guard, or
  neither). Two different guards make it legitimate: the event arrives and the
  guard picks.
- `many-defaults` — two transitions without a trigger leave the same state with
  different guards. Nothing evaluates a guard, so nothing can pick.

One transition without a trigger per state is the default: what the machine does
when no named event arrives. That is the slot the `entry`/`exit` notation will be
lowered onto, which is why it is allowed exactly once.

Both checks belong here and not in `src/engine/`: "in one state at a time" is what
a state machine means, not what a typed graph means. The engine checks that a
trigger is a string; this file checks what the string rules out.

## What a state writes

`entry` and `exit` are one string each: `name = value` pieces separated by `;`,
where a value is a number, `true`, `false` or a quoted string. `do` names an
activity and writes nothing.

```ts
{
  id: 'armed',
  type: STATE,
  attributes: {
    [ENTRY]: 'armed = 1; mode = "auto"',
    [EXIT]: 'armed = 0',
    [ACTIVITY]: 'poll',
  },
}
```

`expandMachine` reads them into `StateView.entry`, `.exit` and `.activity` as
`AssignmentView[]`, so a view never re-parses text. The names must be declared by
the machine — `outputs: 'armed, mode'` — because that declaration is what turns a
misspelt output into `unknown-output` instead of a new signal:

- `bad-effect` — a piece that is not `name = value`, or a value that is a bare
  word. Bare words are refused on purpose: `mode = auto` is one keystroke away from
  `mode = "auto"`, and only the quoted one is a decision.
- `unknown-output` — the name is not among the outputs in force. Inherited outputs
  count, because a child that extends a machine still enters its states.
- `duplicate-output` — one machine names the same output twice. A child redeclaring
  a parent's output is not this: that is the same output, not a second one.
- `duplicate-effect` — one `entry`, `exit` or `sets` string writes the same name
  twice. The list is kept as written and the last piece wins, because
  `armed = 1; armed = 0` reads as an afterthought, not as an order to rely on. A
  silent override is exactly what a reader has to be told about.

Outputs are collected along the chain, own first and then inherited, so the same
state is checked in the machine that declares it and again in every machine that
inherits it. It may be fine in one and not the other, and that is the honest answer:
the writing is the state's, the declaration is the machine's.

The shorthand `armed = 1` written straight onto a state as an attribute is **not**
supported, although `docs/design/intent.md` §4 sketched it — that form needs the
output names to be ontology attributes, which ties the ontology to one project's
signals. One notation, not two.

## A state inside a state

A state may `contains` other states: one container per state, no cycles, so the
states of a machine form a tree.

```ts
{ id: 'running', type: STATE, attributes: { [ENTRY]: 'armed = true' } }   // a level
{ id: 'spinning', type: STATE, attributes: { [ENTRY]: 'speed = 1' } }    // a state
{ id: 'c1', relation: CONTAINS, source: 'running', target: 'spinning' }
{ id: 's1', relation: STARTS_AT, source: 'running', target: 'spinning' }
```

A container is a **level** of the statechart, not a state the machine can be in. The
machine is always in one of the states at the bottom of the tree, so `readPaths`
gives those a row each and the containers none. Ownership does not change:
`spinning` is still owned by the machine, and `contains` only says where inside it
the state sits — `owns` is whose it is, `contains` is where.

Two things follow that a flat machine cannot say:

- **Entering a container lands on the state it starts at.** An edge into `running`
  arrives in `spinning`. A container that names no `starts-at` is `no-entry` — which
  state the machine enters is undecided, not defaulted to the first one drawn.
- **An edge written on a container stands for one crossing per state at the bottom
  of it.** `estop` on `running` is the n edges of the flat model collapsed into the
  one the model wrote: `expandMachine` returns one transition per leaf, all carrying
  that edge's id, and `declaredFrom` / `declaredTo` say where it was written. That is
  also why the determinism check stays quiet — two copies of one edge are not two
  transitions leaving one state.

Because a crossing leaves and enters a chain rather than a state, `entry` and `exit`
compose: the `exit` pieces run from the state left outwards, the `entry` pieces run
from the outermost container inwards, and the two chains meet at the lowest container
both ends are inside. Between two states of the same container that is just their
own pieces; leaving `running` also writes `running.exit`, which is how "leaving this
mode sets `drive = 0`" is written once instead of in every state within it. A
transition from a state to itself still writes that state's `exit` and then its
`entry`, exactly as it does in a flat machine.

Nesting is not inheritance. A container is not a machine: it declares no `outputs`,
it cannot be inherited, and its `starts-at` is a level's entry rather than a second
initial state — the machine still has exactly one. Two errors come with the
relation, `contains-cycle` when the containers run in a circle and `no-entry` when a
container does not say what it starts in; a state inside two containers reuses
`many-parents`, because "inside two" is the same modelling mistake as "owned by
two".

## What a variable holds in a state

`paths.ts` answers that question, and it is a path question: there is no time in
the model, so an output holds whatever the path into the state wrote last. Three
rules, and they are all of it — cross a transition from `A` to `B`, and for output
`o`:

1. if `B.entry` writes `o`, `B` holds that constant: entering overrides what the
   path carried;
2. otherwise, if `A.exit` writes `o`, `B` holds that — an `exit` is a default for
   successors that say nothing;
3. otherwise `B` holds what `A` held, unchanged. A state that writes nothing keeps
   everything, which is why waiting does not drive an output anywhere.

`A` and `B` are states at the bottom of the tree. With states inside states the same
three rules are read along the chain a crossing leaves and enters (see above), and
the initial state is followed down to the leaf it stands on.

The initial state is rule 1 alone: what it writes on entry, otherwise **nothing has
written it yet** — which is not zero, and is reported as such.

The answer is one output and state at a time, with every value the model allows
and the transition that brought it:

```
in "wait" "drive" is 1 via "release" and 0 via "clear" and nothing via start
```

That sentence is the point of the exercise. A state that can hold two values is
either a model that forgot to write the output on every path, or a model that is
honestly path-dependent — and only the model can say which. `readPaths` reports
the choice instead of making it. The value set is finite (what the states write),
so the walk is a fixed point and terminates on cycles and self-loops.

## `sets` asserts, it never writes

A `moves-to` edge may carry `sets`, in the same notation as `entry`:

```ts
{ id: 'idle-busy', relation: MOVES_TO, source: 'idle', target: 'busy',
  attributes: { [SETS]: 'armed = 1' } }
```

This is the model saying what it believes holds after crossing, and nothing is
written by it: the values come from the states' `entry` and `exit`, always. Read
that twice, because a reader coming from a programming language will assume it
assigns.

What is checked is the assertion against every path the model allows, and the
three outcomes are the reason to write it down at all:

- it agrees — one value crosses and it is the asserted one, so there is no issue;
- `sets-undecided` (warning) — the asserted value is reachable, but so is another
  one: the claim holds on some paths only. Also reported when nothing wrote the
  output before the transition, so the value might be *nothing*.
- `sets-contradicted` (error) — the assertion cannot hold on any path.

When a claim holds on some paths only, the message names where each conflicting value
came from. A value the crossing decides by itself — the successor's `entry`, or the
`exit` the predecessor left behind — is the same on every path, so it is printed bare.
A carried value names the transition that brought it, because that is the answer to
"why is this not determined?", and naming the edge the reader is already looking at
would answer nothing.

`output-never-set` is the cheap companion warning: a machine declares an output
and no state ever writes it, so it keeps whatever it held before the machine
started. For a hardware model that silence usually means a state is missing.

## Known gaps

- **No orthogonal regions.** Containment is a tree and a machine is in exactly one
  state at a time, so two independent aspects — operating state and safety state —
  cannot be held side by side. `contains` has already collapsed the n-fold emergency
  stop into one edge on the container; a region is the case where two such
  hierarchies hold at once, and that is a second relation rather than a reading.
- **No reachability issue.** `readPaths` reports a state no path arrives at
  (`reachable: false`, no values) and `expandMachine` reports a missing initial
  state, but neither reports an unreachable state as an issue of its own — the
  warning waits until a view needs to draw it.
- **No arithmetic and no timing.** An output is set to a constant and only that.
  Nothing computes `armed + 1`, and nothing says how long a state is held, so a
  statement about a value that is only true *while a transition is crossing* cannot
  be written and is not checked. `exit` is the closest the vocabulary gets, and it
  is a default for the successor rather than an event.
- **Nothing has no type.** An output nobody has written yet is reported as
  *nothing*, not as `0` or `false`. That is honest for a model that does not say
  what an output is before the machine starts, and it means an initial-state `entry`
  is the only way to pin a value down.
- **Guard overlap is not checked.** Two guards on the same event are accepted,
  and whether both can hold at once is never asked: a guard is a name, and
  deciding that needs the requirement predicates the model does not carry yet.
- **`layer` is a closed list, not an order.** `values: LAYERS` checks the word,
  not that a `presentation` module may only depend on `application`. Layer
  ordering is a relation between types, which the metamodel cannot express yet.

## Reading order

`architecture.ts` is data and can be read top to bottom. `expand.ts` collects the
chain, flattens the states, resolves the transitions and checks that leaving each
state is decidable. `paths.ts` takes that expanded machine and reads it along its
paths: reachability first, then the values per state and output, then the
assertions. It does not consult the graph, so nothing it says depends on how the
model was written down.
