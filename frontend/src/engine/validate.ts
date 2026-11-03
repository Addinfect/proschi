import { cycles, indexGraph } from './graph';
import { accepts } from './registry';
import type {
  Attribute,
  AttributeSpec,
  Graph,
  Id,
  Issue,
  Node,
  Ontology,
  Severity,
} from './types';

/**
 * Checks a graph against its ontology: every node is an instance of a declared
 * type and carries what that type asks for, every edge is an instance of a
 * declared relation between types that relation allows, and the counts and
 * acyclicity the relation states hold.
 *
 * Issues are returned, never thrown, in graph order so that a list of them reads
 * like the model: nodes first, then edges, then counts and cycles. The caller
 * decides what an error stops (an editor shows it, an import refuses the file).
 */

/** How strict the attribute check is. */
export interface ValidateOptions {
  /** Severity for an attribute whose name the type does not declare; default 'warning'. */
  unknownAttribute?: Severity;
  /** False to skip the check for attributes a type requires; default true. */
  checkRequired?: boolean;
}

/** Checks a graph against an ontology and returns every issue, in graph order. */
export function validateGraph(
  ontology: Ontology,
  graph: Graph,
  options: ValidateOptions = {},
): Issue[] {
  const issues: Issue[] = [];
  const nodes = new Map<Id, Node>();

  for (const node of graph.nodes) {
    if (nodes.has(node.id)) {
      issues.push({
        severity: 'error',
        code: 'duplicate-id',
        subject: node.id,
        message: `Node "${node.id}" is declared twice; the second declaration is ignored.`,
        loc: node.loc,
      });
      continue;
    }
    nodes.set(node.id, node);
    const type = ontology.types[node.type];
    if (!type) {
      issues.push({
        severity: 'error',
        code: 'unknown-type',
        subject: node.id,
        message: `Node "${node.id}" is a "${node.type}", which the ontology does not declare.`,
        loc: node.loc,
      });
      continue;
    }
    if (!type.instantiable) {
      issues.push({
        severity: 'error',
        code: 'abstract-type',
        subject: node.id,
        message: `Node "${node.id}" is a "${node.type}", which only exists to be extended.`,
        loc: node.loc,
      });
    }
    issues.push(...checkAttributes(type.attributes, node.attributes, node.id, node.loc, options));
  }

  const edgeIds = new Set<Id>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) {
      issues.push({
        severity: 'error',
        code: 'duplicate-id',
        subject: edge.id,
        message: `Edge "${edge.id}" is declared twice; the second declaration is ignored.`,
        loc: edge.loc,
      });
      continue;
    }
    edgeIds.add(edge.id);
    const relation = ontology.relations[edge.relation];
    if (!relation) {
      issues.push({
        severity: 'error',
        code: 'unknown-relation',
        subject: edge.id,
        message: `Edge "${edge.id}" is a "${edge.relation}", which the ontology does not declare.`,
        loc: edge.loc,
      });
      continue;
    }
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source) {
      issues.push({
        severity: 'error',
        code: 'unknown-node',
        subject: edge.id,
        message: `Edge "${edge.id}" leaves "${edge.source}", which the graph does not declare.`,
        loc: edge.loc,
      });
    }
    if (!target) {
      issues.push({
        severity: 'error',
        code: 'unknown-node',
        subject: edge.id,
        message: `Edge "${edge.id}" enters "${edge.target}", which the graph does not declare.`,
        loc: edge.loc,
      });
    }
    if (edge.source === edge.target && !relation.allowSelfLoops) {
      issues.push({
        severity: 'error',
        code: 'self-loop',
        subject: edge.id,
        message: `Edge "${edge.id}" is a "${edge.relation}", which may not start and end on the same node.`,
        loc: edge.loc,
      });
    }
    if (source && !accepts(ontology, edge.relation, 'source', source.type)) {
      issues.push({
        severity: 'error',
        code: 'relation-source',
        subject: edge.id,
        message: `Edge "${edge.id}" is a "${edge.relation}", which may not leave a "${source.type}".`,
        loc: edge.loc,
      });
    }
    if (target && !accepts(ontology, edge.relation, 'target', target.type)) {
      issues.push({
        severity: 'error',
        code: 'relation-target',
        subject: edge.id,
        message: `Edge "${edge.id}" is a "${edge.relation}", which may not enter a "${target.type}".`,
        loc: edge.loc,
      });
    }
    issues.push(
      ...checkAttributes(relation.attributes, edge.attributes, edge.id, edge.loc, options),
    );
  }

  const index = indexGraph(graph);
  for (const relation of Object.values(ontology.relations)) {
    const ofRelation = graph.edges.filter((edge) => edge.relation === relation.name);

    if (relation.maxOut !== undefined) {
      const counts = new Map<Id, number>();
      for (const edge of ofRelation) counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
      for (const [id, count] of counts) {
        if (count <= relation.maxOut) continue;
        issues.push({
          severity: 'error',
          code: 'too-many-out',
          subject: id,
          message: `"${id}" has ${count} "${relation.name}" edges leaving it, and at most ${relation.maxOut} ${relation.maxOut === 1 ? 'is' : 'are'} allowed.`,
        });
      }
    }

    if (relation.maxIn !== undefined) {
      const counts = new Map<Id, number>();
      for (const edge of ofRelation) counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
      for (const [id, count] of counts) {
        if (count <= relation.maxIn) continue;
        issues.push({
          severity: 'error',
          code: 'too-many-in',
          subject: id,
          message: `"${id}" has ${count} "${relation.name}" edges entering it, and at most ${relation.maxIn} ${relation.maxIn === 1 ? 'is' : 'are'} allowed.`,
        });
      }
    }

    if (relation.acyclic) {
      for (const group of cycles(index, { relations: [relation.name] })) {
        const first = group[0];
        issues.push({
          severity: 'error',
          code: 'cycle',
          subject: first,
          message: `"${relation.name}" may not close a cycle: ${[...group, first].join(' → ')}.`,
        });
      }
    }
  }

  return issues;
}

/**
 * Checks the attributes of one instance against the attributes its type declares:
 * required ones are set, known ones have the declared kind and one of the allowed
 * values, and unknown ones are reported as the caller asks.
 */
export function checkAttributes(
  declared: Readonly<Record<string, AttributeSpec>>,
  given: Readonly<Record<string, Attribute>> | undefined,
  subject: Id,
  loc: Issue['loc'],
  options: ValidateOptions = {},
): Issue[] {
  const issues: Issue[] = [];
  const values = given ?? {};

  if (options.checkRequired !== false) {
    for (const [key, spec] of Object.entries(declared)) {
      if (!spec.required || Object.hasOwn(values, key)) continue;
      issues.push({
        severity: 'error',
        code: 'missing-attribute',
        subject,
        message: `"${subject}" must set "${key}".`,
        loc,
      });
    }
  }

  for (const [key, value] of Object.entries(values)) {
    const spec = declared[key];
    if (!spec) {
      issues.push({
        severity: options.unknownAttribute ?? 'warning',
        code: 'unknown-attribute',
        subject,
        message: `"${subject}" sets "${key}", which its type does not declare.`,
        loc,
      });
      continue;
    }
    if (typeof value !== spec.kind) {
      issues.push({
        severity: 'error',
        code: 'attribute-kind',
        subject,
        message: `"${subject}.${key}" is a ${typeof value}, and a ${spec.kind} is expected.`,
        loc,
      });
      continue;
    }
    if (spec.values && !spec.values.includes(value)) {
      issues.push({
        severity: 'error',
        code: 'attribute-value',
        subject,
        message: `"${subject}.${key}" is ${JSON.stringify(value)}, which is not one of ${spec.values.map((allowed) => JSON.stringify(allowed)).join(', ')}.`,
        loc,
      });
    }
  }

  return issues;
}
