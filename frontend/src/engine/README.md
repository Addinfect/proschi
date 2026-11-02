# The engine

A typed graph, the ontology that says what may appear in it, walks over it, and
checks against it. Nothing in this directory knows what the names in a model
mean.

```
types.ts     Node, Edge, Graph, TypeSpec, RelationSpec, Ontology, Issue
registry.ts  buildOntology(): merges inheritance, reports what it cannot resolve
graph.ts     indexGraph(), reachability, topological order, cycles, subgraphs
validate.ts  validateGraph(): a graph against its ontology, as a list of issues
index.ts     the public surface; import from './engine', not from a file inside
```

## The boundary

The engine is sealed on two sides, and `npm run check:engine-boundary` fails when
either breaks:

1. **No imports from outside.** Every file imports only from `./…` in this
   directory. No React, no rendering, no parser, no solver. That is what lets the
   engine be tested and reused on its own.
2. **No subject matter.** The vocabulary of the thing being modelled (the words an
   ontology is made of: what the units are, how they connect, what is measured)
   must not appear here. The ban-list lives in `scripts/check-engine-boundary.mjs`
   so that this file can describe the rule without tripping over it.

The test for both: an ontology of some entirely different subject matter should
work with no change to this directory. `engine.test.ts` uses a toy one for exactly
that reason.

## What an ontology supplies

- **Types** (`TypeSpec`): a name, the types it `extends`, and attributes with a
  kind, optional allowed values, `required`, and `override`. Attributes are
  inherited; a subtype may redeclare one only when the declaring type sets
  `override: true`, with the same kind and a narrower set of values. Requirements
  are inherited and cannot be dropped.
- **Relations** (`RelationSpec`): a name, the types allowed at `source` and
  `target` (a subtype is accepted wherever a parent type is named), `maxOut` and
  `maxIn` counts, `acyclic`, and `allowSelfLoops`.

`acyclic: true` is what makes a relation an order (dependencies, containment);
leaving it off allows a cycle (usage, calls, transitions). `maxIn: 1` is what
makes a relation a tree (composition, inheritance of a single parent). One graph
therefore reads as several structures at once, chosen by `WalkOptions.relations`.

## Layers above

| Layer | Lives in | Knows |
| --- | --- | --- |
| Engine | `src/engine/` (this directory) | nodes, edges, types, relations, checks |
| Ontology | `src/ontology/` | the subject matter, as data |
| View | `src/views/` | how to draw a graph for a reader |
| Model | `src/model/` | one saved or edited graph |

The dependency arrow points one way: view → ontology → engine. An ontology may
declare types and relations; a view may not add rules the ontology does not have,
and the engine may not know either.

## Running it

```
npm test -- src/engine          # from frontend/
npm run check:engine-boundary   # from frontend/
npx tsc -b                      # from frontend/, type-checks the lot
```
