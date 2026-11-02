# The architecture ontology

The engine knows nodes, edges, types and relations. This directory says what the
names mean for software architecture, and how to read one graph three ways.

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

## The trigger is the edge label

A transition needs a trigger, and `RelationSpec` cannot declare edge attributes
yet (see below), so `moves-to` edges carry theirs in `Edge.label`:

```ts
{ id: 't1', relation: MOVES_TO, source: 'idle', target: 'parsing', label: 'input' }
```

`expandMachine` copies it to `TransitionView.trigger`. When `RelationSpec` grows
an `attributes` field this should become a declared attribute like any other, and
`label` should go back to being a caption.

## Known gaps

- **No edge attributes in the metamodel.** `RelationSpec` has no `attributes`, so
  nothing checks what an edge carries. Hence the label convention above.
- **No composite states.** A machine is flat. Nesting means an `owns` edge from
  state to state, plus a rule that the child machine's `starts-at` is entered on
  entry — neither is declared.
- **No reachability check.** `expandMachine` reports a missing initial state, but
  not a state no transition can reach. The engine already has `reachableFrom`;
  wiring it in is a few lines once a view wants to show it.
- **`layer` is a closed list, not an order.** `values: LAYERS` checks the word,
  not that a `presentation` module may only depend on `application`. Layer
  ordering is a relation between types, which the metamodel cannot express yet.

## Reading order

`architecture.ts` is data and can be read top to bottom. `expand.ts` is the only
place with logic, and its shape is: collect the chain, flatten the states, resolve
the transitions.
