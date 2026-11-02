/**
 * The engine: a typed graph, the ontology that says what may appear in it, walks
 * over it, and checks against it.
 *
 * It knows no subject matter. An ontology (src/ontology/) declares types and
 * relations, a model instantiates them, and a view (src/views/) draws the result;
 * the engine sits between the three and stays the same whichever of them changes.
 * See README.md for the boundary this module keeps.
 */

export type {
  Attribute,
  AttributeKind,
  AttributeSpec,
  Edge,
  Graph,
  Id,
  Issue,
  Node,
  Ontology,
  OntologySpec,
  RelationSpec,
  ResolvedRelation,
  ResolvedType,
  Severity,
  SourceRef,
  TypeSpec,
} from './types';

export { accepts, buildOntology, isA, lineageOf } from './registry';

export type { Degree, GraphIndex, WalkOptions } from './graph';
export {
  cycles,
  degreeOf,
  edgesOf,
  indexGraph,
  predecessors,
  reachableFrom,
  reaches,
  sinks,
  sources,
  subgraphOf,
  successors,
  topologicalOrder,
  transitiveClosure,
  weaklyConnected,
} from './graph';

export type { ValidateOptions } from './validate';
export { checkAttributes, validateGraph } from './validate';
