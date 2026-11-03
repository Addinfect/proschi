import { describe, expect, it } from 'vitest';
import {
  accepts,
  buildOntology,
  cycles,
  degreeOf,
  indexGraph,
  isA,
  reachableFrom,
  reaches,
  sinks,
  sources,
  subgraphOf,
  successors,
  topologicalOrder,
  transitiveClosure,
  validateGraph,
  weaklyConnected,
  type Graph,
  type OntologySpec,
} from './index';

/**
 * The engine holds no subject matter, so these tests use one of their own: units
 * that are parts of groups, joined by `links`, contained by `owns`, and loosely
 * `mentions`ed. If a test passes, the same machinery serves any other ontology.
 */

const spec: OntologySpec = {
  types: [
    { name: 'unit', instantiable: false },
    { name: 'part', extends: ['unit'], attributes: { label: { kind: 'string', override: true } } },
    { name: 'group', extends: ['part'], attributes: { size: { kind: 'number', required: true } } },
  ],
  relations: [
    { name: 'links', source: ['unit'], target: ['unit'], acyclic: true },
    { name: 'owns', source: ['group'], target: ['part'], maxIn: 1, acyclic: true },
    { name: 'mentions' },
  ],
};

const { ontology, issues: ontologyIssues } = buildOntology(spec);

/** a → b → c by `links`, and c owns a. */
const graph: Graph = {
  nodes: [
    { id: 'a', type: 'part' },
    { id: 'b', type: 'part' },
    { id: 'c', type: 'group', attributes: { size: 2 } },
  ],
  edges: [
    { id: 'a-links-b', relation: 'links', source: 'a', target: 'b' },
    { id: 'b-links-c', relation: 'links', source: 'b', target: 'c' },
    { id: 'c-owns-a', relation: 'owns', source: 'c', target: 'a' },
  ],
};

const index = indexGraph(graph);

/** The codes of the issues a graph produces, for a short assertion. */
function codesOf(graphed: Graph): string[] {
  return validateGraph(ontology, graphed).map((issue) => issue.code);
}

describe('buildOntology', () => {
  it('accepts a sound ontology', () => {
    expect(ontologyIssues).toEqual([]);
  });

  it('merges inherited attributes', () => {
    expect(Object.keys(ontology.types.group.attributes).sort()).toEqual(['label', 'size']);
    expect(ontology.types.group.lineage).toEqual(['unit', 'part', 'group']);
  });

  it('orders every type after the types it extends', () => {
    expect(ontology.order).toEqual(['unit', 'part', 'group']);
    expect(ontology.roots).toEqual(['unit']);
  });

  it('tells ancestry from descent', () => {
    expect(isA(ontology, 'group', 'unit')).toBe(true);
    expect(isA(ontology, 'unit', 'group')).toBe(false);
  });

  it('accepts a subtype where a relation names the type it extends', () => {
    expect(accepts(ontology, 'links', 'source', 'group')).toBe(true);
    expect(accepts(ontology, 'links', 'target', 'unit')).toBe(true);
    expect(accepts(ontology, 'missing', 'source', 'unit')).toBe(false);
  });

  it('reports a redeclaration the parent did not open', () => {
    const closed = buildOntology({
      types: [
        { name: 'base', attributes: { flag: { kind: 'boolean' } } },
        { name: 'child', extends: ['base'], attributes: { flag: { kind: 'boolean' } } },
      ],
      relations: [],
    });
    expect(closed.issues.map((issue) => issue.code)).toEqual(['closed-override']);
    // The inherited declaration stands, so the child keeps a shape a view can draw.
    expect(closed.ontology.types.child.attributes.flag.kind).toEqual('boolean');
  });

  it('reports a redeclaration that changes the kind or widens the values', () => {
    const changed = buildOntology({
      types: [
        { name: 'base', attributes: { mode: { kind: 'string', values: ['one'], override: true } } },
        { name: 'child', extends: ['base'], attributes: { mode: { kind: 'string', values: ['one', 'two'] } } },
        { name: 'other', extends: ['base'], attributes: { mode: { kind: 'number' } } },
      ],
      relations: [],
    });
    expect(changed.issues.map((issue) => issue.code)).toEqual(['wider-values', 'override-kind']);
  });

  it('keeps a requirement a subtype inherits', () => {
    const narrow = buildOntology({
      types: [
        { name: 'base', attributes: { flag: { kind: 'boolean', required: true } } },
        { name: 'child', extends: ['base'] },
      ],
      relations: [],
    });
    expect(narrow.ontology.types.child.attributes.flag.required).toBe(true);
  });

  it('reports an inheritance cycle once and stays usable', () => {
    const cyclic = buildOntology({
      types: [
        { name: 'one', extends: ['two'] },
        { name: 'two', extends: ['one'] },
      ],
      relations: [],
    });
    expect(cyclic.issues.filter((issue) => issue.code === 'inheritance-cycle')).toHaveLength(1);
    expect(Object.keys(cyclic.ontology.types).sort()).toEqual(['one', 'two']);
  });

  it('reports what it cannot resolve', () => {
    const broken = buildOntology({
      types: [
        { name: 'unit' },
        { name: 'unit' },
        { name: 'lost', extends: ['nowhere'] },
      ],
      relations: [
        { name: 'links', source: ['unit'] },
        { name: 'links' },
        { name: 'owns', maxIn: 0 },
        { name: 'jumps', target: ['nowhere'] },
      ],
    });
    expect(broken.issues.map((issue) => issue.code).sort()).toEqual([
      'bad-limit',
      'duplicate-relation',
      'duplicate-type',
      'unknown-type',
      'unknown-type',
    ]);
  });
});

describe('walks', () => {
  it('lists what an edge leads to and comes from', () => {
    expect(successors(index, 'a', { relations: ['links'] })).toEqual(['b']);
    expect(degreeOf(index, 'a', { relations: ['links'] })).toEqual({ in: 0, out: 1 });
  });

  it('reaches through any number of edges, and not back to the start', () => {
    expect([...reachableFrom(index, 'a', { relations: ['links'] })].sort()).toEqual(['b', 'c']);
    expect(reaches(index, 'a', 'c', { relations: ['links'] })).toBe(true);
    // a reaches itself through `owns` coming back from c, but not through `links`.
    expect(reaches(index, 'a', 'a')).toBe(true);
    expect(reaches(index, 'a', 'a', { relations: ['links'] })).toBe(false);
  });

  it('builds the whole closure once', () => {
    expect(transitiveClosure(index, { relations: ['links'] }).get('c')?.size).toBe(0);
  });

  it('finds the ends of a flow', () => {
    expect(sources(index, { relations: ['links'] })).toEqual(['a']);
    expect(sinks(index, { relations: ['links'] })).toEqual(['c']);
  });

  it('orders nodes after the ones that reach them', () => {
    expect(topologicalOrder(index, { relations: ['links'] })).toEqual(['a', 'b', 'c']);
    // Read with every relation, c owns a, so the order has no beginning.
    expect(topologicalOrder(index)).toBeUndefined();
  });

  it('finds the groups that close a cycle', () => {
    expect(cycles(index)).toEqual([['a', 'b', 'c']]);
    expect(cycles(index, { relations: ['links'] })).toEqual([]);
  });

  it('groups nodes joined by any edge', () => {
    expect(weaklyConnected(index)).toEqual([['a', 'b', 'c']]);
  });

  it('keeps the part of a graph that is asked for', () => {
    const kept = subgraphOf(graph, new Set(['a', 'b']));
    expect(kept.nodes.map((node) => node.id)).toEqual(['a', 'b']);
    expect(kept.edges.map((edge) => edge.id)).toEqual(['a-links-b']);
  });
});

describe('validateGraph', () => {
  it('accepts a sound graph', () => {
    expect(validateGraph(ontology, graph)).toEqual([]);
  });

  it('rejects a node of an unknown or abstract type', () => {
    const codes = codesOf({
      nodes: [{ id: 'x', type: 'nothing' }, { id: 'y', type: 'unit' }],
      edges: [],
    });
    expect(codes).toEqual(['unknown-type', 'abstract-type']);
  });

  it('rejects an edge of an unknown relation or to an unknown node', () => {
    const codes = codesOf({
      nodes: [{ id: 'a', type: 'part' }],
      edges: [
        { id: 'gone', relation: 'nothing', source: 'a', target: 'a' },
        { id: 'dangling', relation: 'links', source: 'a', target: 'nowhere' },
      ],
    });
    expect(codes).toEqual(['unknown-relation', 'unknown-node']);
  });

  it('rejects an edge whose ends the relation does not allow', () => {
    const codes = codesOf({
      nodes: [{ id: 'a', type: 'part' }, { id: 'b', type: 'part' }],
      edges: [{ id: 'owns', relation: 'owns', source: 'b', target: 'a' }],
    });
    expect(codes).toEqual(['relation-source']);
  });

  it('rejects a cycle a relation forbids', () => {
    const codes = codesOf({
      nodes: [{ id: 'a', type: 'part' }, { id: 'b', type: 'part' }],
      edges: [
        { id: 'a-b', relation: 'links', source: 'a', target: 'b' },
        { id: 'b-a', relation: 'links', source: 'b', target: 'a' },
      ],
    });
    expect(codes).toEqual(['cycle']);
  });

  it('names a self-loop once, as a cycle, when the relation allows self-loops', () => {
    // `links` lets an edge start and end on the same node but forbids cycles, so the
    // loop of one is a `cycle` -- and not a `self-loop` beside it as well.
    const codes = codesOf({
      nodes: [{ id: 'a', type: 'part' }],
      edges: [{ id: 'a-a', relation: 'links', source: 'a', target: 'a' }],
    });
    expect(codes).toEqual(['cycle']);
  });

  it('names a self-loop once, as a self-loop, when the relation forbids them', () => {
    const built = buildOntology({
      types: [{ name: 'unit' }],
      relations: [
        {
          name: 'links',
          source: ['unit'],
          target: ['unit'],
          acyclic: true,
          allowSelfLoops: false,
        },
      ],
    });
    const codes = validateGraph(built.ontology, {
      nodes: [{ id: 'a', type: 'unit' }],
      edges: [{ id: 'a-a', relation: 'links', source: 'a', target: 'a' }],
    }).map((issue) => issue.code);
    expect(codes).toEqual(['self-loop']);
  });

  it('allows a cycle a relation permits', () => {
    expect(
      codesOf({
        nodes: [{ id: 'a', type: 'part' }, { id: 'b', type: 'part' }],
        edges: [
          { id: 'a-b', relation: 'mentions', source: 'a', target: 'b' },
          { id: 'b-a', relation: 'mentions', source: 'b', target: 'a' },
        ],
      }),
    ).toEqual([]);
  });

  it('counts the edges a relation limits', () => {
    const codes = codesOf({
      nodes: [
        { id: 'a', type: 'part', attributes: { size: 1 } },
        { id: 'b', type: 'group', attributes: { size: 2 } },
        { id: 'd', type: 'group', attributes: { size: 2 } },
      ],
      edges: [
        { id: 'b-owns-a', relation: 'owns', source: 'b', target: 'a' },
        { id: 'd-owns-a', relation: 'owns', source: 'd', target: 'a' },
      ],
    });
    // The first node is a part, which is what `owns` targets; its `size` is an
    // attribute of groups only, so that is reported too.
    expect(codes).toContain('too-many-in');
    expect(codes).toContain('unknown-attribute');
  });

  it('checks the attributes of a node', () => {
    const codes = codesOf({
      nodes: [
        { id: 'plain', type: 'group' },
        { id: 'wrong', type: 'group', attributes: { size: 'big' } },
        { id: 'extra', type: 'part', attributes: { colour: 'red' } },
      ],
      edges: [],
    });
    expect(codes).toEqual(['missing-attribute', 'attribute-kind', 'unknown-attribute']);
  });
});

describe('edge attributes', () => {
  /** A relation that declares what its edges carry; nothing to inherit, so declared once. */
  const spec: OntologySpec = {
    types: [{ name: 'unit' }],
    relations: [
      {
        name: 'links',
        attributes: {
          note: { kind: 'string' },
          weight: { kind: 'number' },
          bond: { kind: 'string', values: ['hard', 'soft'] },
          must: { kind: 'boolean', required: true },
        },
      },
    ],
  };

  const { ontology: onEdges } = buildOntology(spec);

  /** One edge that carries `attributes`, between two units. */
  const edge = (attributes: Record<string, string | number | boolean>): Graph => ({
    nodes: [
      { id: 'a', type: 'unit' },
      { id: 'b', type: 'unit' },
    ],
    edges: [{ id: 'a-links-b', relation: 'links', source: 'a', target: 'b', attributes }],
  });

  const codes = (attributes: Record<string, string | number | boolean>): string[] =>
    validateGraph(onEdges, edge(attributes)).map((issue) => issue.code);

  it('resolves the attributes a relation declares', () => {
    expect(Object.keys(onEdges.relations.links.attributes).sort()).toEqual([
      'bond',
      'must',
      'note',
      'weight',
    ]);
  });

  it('accepts an edge that carries what the relation declares', () => {
    expect(codes({ note: 'why', weight: 2, bond: 'hard', must: true })).toEqual([]);
  });

  it('reports an attribute the relation does not declare', () => {
    expect(codes({ must: true, colour: 'red' })).toEqual(['unknown-attribute']);
  });

  it('reports the wrong kind and a value outside the allowed set', () => {
    expect(codes({ must: true, weight: 'heavy' })).toEqual(['attribute-kind']);
    expect(codes({ must: true, bond: 'medium' })).toEqual(['attribute-value']);
  });

  it('reports an attribute the relation requires and the edge omits', () => {
    expect(codes({ note: 'why' })).toEqual(['missing-attribute']);
  });

  it('reports a declaration whose kind does not exist', () => {
    const declared = buildOntology({
      types: [],
      relations: [
        {
          name: 'links',
          attributes: {
            note: { kind: 'text' as 'string' },
            weight: { kind: 'number', values: [1, 'two'] },
          },
        },
      ],
    });
    expect(declared.issues.map((issue) => issue.code)).toEqual([
      'bad-attribute-kind',
      'bad-attribute-value',
    ]);
  });
});

