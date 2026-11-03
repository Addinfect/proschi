# The architecture ontology

The engine knows nodes, edges, types and relations. This directory says what the
names mean for software architecture, and how to read one graph three ways. Why
the vocabulary is cut this way, and what it cannot express yet, is in
[`docs/design/metamodel.md`](../../../docs/design/metamodel.md).

```
architecture.ts  ARCHITECTURE: types, relations, layer vocabulary — plain data
expand.ts        expandMachine(): an inheritance chain flattened into one machine
architecture.test.ts
```

## One graph, three readings

| Reading | Relation | Question it answers |
| --- | --- | --- |
| Structure | `depends-on` (acyclic) | what may call what; what a layer may see |
| Flow | `uses`, `composes` | what is built from what; which path data takes |
| Behaviour | `owns`, `starts-at`, `moves-to`, `inherits` | what a machine does |

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

## Known gaps

- **No composite states.** A machine is flat. Nesting means an `owns` edge from
  state to state, plus a rule that the child machine's `starts-at` is entered on
  entry — neither is declared.
- **No reachability check.** `expandMachine` reports a missing initial state, but
  not a state no transition can reach. The engine already has `reachableFrom`;
  wiring it in is a few lines once a view wants to show it.
- **Guard overlap is not checked.** Two guards on the same event are accepted,
  and whether both can hold at once is never asked: a guard is a name, and
  deciding that needs the requirement predicates the model does not carry yet.
- **`layer` is a closed list, not an order.** `values: LAYERS` checks the word,
  not that a `presentation` module may only depend on `application`. Layer
  ordering is a relation between types, which the metamodel cannot express yet.

## Reading order

`architecture.ts` is data and can be read top to bottom. `expand.ts` is the only
place with logic, and its shape is: collect the chain, flatten the states, resolve
the transitions, then check that leaving each state is decidable.
