/**
 * The types of the engine.
 *
 * A model is a typed graph: nodes carry a type, edges carry a relation, and an
 * ontology says which names may appear and how they combine. Nothing here knows
 * what a name means — "module", "state" and "depends on" are data an ontology
 * supplies (see src/ontology/) — so the same engine, checks and views serve any
 * subject matter.
 *
 * Boundary rule: this directory imports nothing from outside itself and names
 * no subject matter of its own (see README.md and scripts/check-engine-boundary.mjs).
 */

/** A stable identifier of a node or an edge within one graph. */
export type Id = string;

/** 1-based position of a construct in its source text. */
export interface SourceRef {
  line: number;
  col: number;
  length: number;
  /** Path of the file the construct is written in; absent for the document being edited. */
  file?: string;
}

export type Severity = 'error' | 'warning' | 'info';

/** One thing wrong with an ontology or a graph. */
export interface Issue {
  severity: Severity;
  /** Stable, machine-readable kind: `unknown-type`, `cycle`, `too-many-in`, … */
  code: string;
  /** Sentence for a reader, ending with a full stop. */
  message: string;
  /** Id of the node, edge or type the issue is about, when there is one. */
  subject?: Id;
  /** Where the subject is written, when the source is known. */
  loc?: SourceRef;
}

/**
 * A value a node, an edge or a type declaration carries. Scalars only: a model
 * stays plain data, so that it can be compared, saved and diffed without
 * surprises. An absent key means "not set"; there is no null.
 */
export type Attribute = string | number | boolean;

export type AttributeKind = 'string' | 'number' | 'boolean';

/** What one attribute may hold, as the type that declares it says. */
export interface AttributeSpec {
  kind: AttributeKind;
  /** Closed set of allowed values; a subtype may narrow it, never widen it. */
  values?: readonly Attribute[];
  /** True when every instance of the declaring type must set it. */
  required?: boolean;
  /**
   * True when a subtype may redeclare the attribute (with the same kind, and a
   * narrower set of values). Inheritance is closed by default: the type that
   * declares an attribute decides whether it may change.
   */
  override?: boolean;
  /** One sentence for a reader, shown by views. */
  doc?: string;
}

/** One node: an instance of one type. */
export interface Node {
  id: Id;
  /** Name of a type the ontology declares. */
  type: string;
  /** Text a view shows; absent means the id. */
  name?: string;
  attributes?: Readonly<Record<string, Attribute>>;
  loc?: SourceRef;
}

/** One edge: an instance of one relation, from one node to another. */
export interface Edge {
  id: Id;
  /** Name of a relation the ontology declares. */
  relation: string;
  source: Id;
  target: Id;
  /** Text a view shows on the edge. */
  label?: string;
  attributes?: Readonly<Record<string, Attribute>>;
  loc?: SourceRef;
}

/**
 * A typed graph: flat lists of nodes and edges. Nesting is not part of the shape
 * — a container is a relation (see `maxIn` in RelationSpec) — so every view
 * reads the same flat model.
 */
export interface Graph {
  nodes: readonly Node[];
  edges: readonly Edge[];
}

/** A type of node, as an ontology writes it. */
export interface TypeSpec {
  name: string;
  /** Names of the types this one extends; their attributes and documentation are merged in. */
  extends?: readonly string[];
  attributes?: Readonly<Record<string, AttributeSpec>>;
  /** Set to false for a type that only exists to be extended, never instantiated. */
  instantiable?: boolean;
  doc?: string;
}

/** A kind of edge, as an ontology writes it. */
export interface RelationSpec {
  name: string;
  /** Type names allowed at the source end; absent means any type. */
  source?: readonly string[];
  /** Type names allowed at the target end; absent means any type. */
  target?: readonly string[];
  /** Most edges of this relation leaving one node. */
  maxOut?: number;
  /** Most edges of this relation entering one node (1 makes the target a single parent). */
  maxIn?: number;
  /** True when a node may not reach itself through this relation. */
  acyclic?: boolean;
  /** True when an edge may start and end on the same node; default true. */
  allowSelfLoops?: boolean;
  /**
   * What an edge of this relation may carry, checked against the edge exactly as a
   * node's attributes are checked against its type. A relation declares these
   * itself: relations do not extend one another, so there is nothing to inherit.
   */
  attributes?: Readonly<Record<string, AttributeSpec>>;
  doc?: string;
}

/** An ontology as an ontology module writes it; registry.ts checks and resolves it. */
export interface OntologySpec {
  types: readonly TypeSpec[];
  relations: readonly RelationSpec[];
}

/** A type after inheritance has been merged in. */
export interface ResolvedType {
  name: string;
  /** Ancestors from the root of the chain down to this type, itself included and last. */
  lineage: readonly string[];
  /** Inherited attributes and own ones, own last and winning where the parent allowed it. */
  attributes: Readonly<Record<string, AttributeSpec>>;
  /** False for a type that only exists to be extended. */
  instantiable: boolean;
  doc?: string;
}

/** A relation after defaults have been filled in. */
export interface ResolvedRelation {
  name: string;
  source?: readonly string[];
  target?: readonly string[];
  maxOut?: number;
  maxIn?: number;
  /** True when a node may not reach itself through this relation. */
  acyclic: boolean;
  /** True when an edge may start and end on the same node. */
  allowSelfLoops: boolean;
  /** What an edge of this relation may carry; empty when it declares nothing. */
  attributes: Readonly<Record<string, AttributeSpec>>;
  doc?: string;
}

/** An ontology after inheritance has been merged in and checked. */
export interface Ontology {
  types: Readonly<Record<string, ResolvedType>>;
  relations: Readonly<Record<string, ResolvedRelation>>;
  /** Every type name, each one after the types it extends. */
  order: readonly string[];
  /** Names of the types that extend nothing. */
  roots: readonly string[];
}
