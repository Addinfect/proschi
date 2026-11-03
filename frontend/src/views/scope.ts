import type { Graph, Id, Issue } from '../engine';

/**
 * A scope: one level of a tree, as a reader has opened it.
 *
 * The model is flat -- `composes`, `contains` or another `maxIn: 1` relation makes
 * it a tree -- and a view is given a *scope*: the node a reader has opened, or
 * nothing for the top level. What comes back is that one level. Everything deeper
 * is folded into the box it sits in, and opening a box is the same call with a
 * deeper root, so nothing is thrown away to draw a level: an edge that vanished
 * into a box comes back with its own id when the box is opened.
 *
 * Two things a renderer has to be able to show, and therefore two things this
 * returns. An edge with an end outside the scope is lifted to the boundary and
 * marked `crosses`; several edges lifted the same way are one edge with a `count`
 * and its `members`, because collapsing must not lose the fact that there were
 * three. And an edge touching a box is drawn at the level of that box -- something
 * inside a box that points at the box is a loop on the box, not a hidden fact.
 *
 * A view adds no rule. The tree is whatever the relation says, and one broken by
 * the model (two parents, a cycle) is the checker's finding: this reads what it
 * can, in the order the model declares things, and says nothing about the rest.
 */

export interface ScopeSpec {
  /** The node a reader opened. Absent draws the top level. */
  readonly root?: Id;
  /** The relation that makes the tree: `composes`, `contains`, ... */
  readonly nests: string;
  /** The relations drawn at this level. The nesting relation is never drawn. */
  readonly draws: readonly string[];
}

/** One box at this level: a node, and what sits directly inside it. */
export interface ScopeBox {
  readonly id: Id;
  /** Ids of the nodes directly inside it; empty means there is nothing to open. */
  readonly children: readonly Id[];
}

/** One edge at this level, standing for one or more edges of the model. */
export interface ScopeEdge {
  readonly relation: string;
  /** The box the edge leaves, as drawn at this level. */
  readonly from: Id;
  /** The box the edge enters, as drawn at this level. */
  readonly to: Id;
  /** How many edges of the model this stands for. One means nothing collapsed. */
  readonly count: number;
  /** Their ids, in the order the model declares them -- enough to re-expand. */
  readonly members: readonly Id[];
  /** Whether an end lies outside the scope and was lifted to the boundary. */
  readonly crosses: boolean;
}

export interface ScopeView {
  readonly root?: Id;
  /** The boxes this level shows, in the order the model declares the nodes. */
  readonly boxes: readonly ScopeBox[];
  readonly edges: readonly ScopeEdge[];
  readonly issues: readonly Issue[];
}

/** Reads one level of the tree a scope opens, and the edges between its boxes. */
export function readScope(graph: Graph, spec: ScopeSpec): ScopeView {
  const root = spec.root;
  const nodes = new Set(graph.nodes.map((node) => node.id));
  if (root !== undefined && !nodes.has(root)) {
    return {
      root,
      boxes: [],
      edges: [],
      issues: [
        {
          severity: 'error',
          code: 'unknown-root',
          subject: root,
          message: `The scope opens "${root}", which the graph does not declare.`,
        },
      ],
    };
  }

  const parentsOf = new Map<Id, Id[]>();
  for (const edge of graph.edges) {
    if (edge.relation === spec.nests) push(parentsOf, edge.target, edge.source);
  }
  const childrenOf = new Map<Id, Id[]>();
  for (const node of graph.nodes) {
    for (const parent of parentsOf.get(node.id) ?? []) push(childrenOf, parent, node.id);
  }

  /**
   * The box an id is drawn as at this level, or absent when it lies outside the
   * scope. A second parent and a cycle are read as the first parent, and the walk
   * gives up rather than looping -- the checker has already said what is wrong.
   */
  const anchorOf = (id: Id): Id | undefined => {
    if (root === undefined) {
      let cur = id;
      const seen = new Set<Id>([cur]);
      for (;;) {
        const parent = parentsOf.get(cur)?.[0];
        if (parent === undefined || seen.has(parent)) return cur;
        seen.add(parent);
        cur = parent;
      }
    }
    if (id === root) return root;
    let cur = id;
    const seen = new Set<Id>([cur]);
    for (;;) {
      const parent = parentsOf.get(cur)?.[0];
      if (parent === undefined || seen.has(parent)) return undefined;
      if (parent === root) return cur;
      seen.add(parent);
      cur = parent;
    }
  };

  const boxes: ScopeBox[] =
    root === undefined
      ? graph.nodes
          .filter((node) => (parentsOf.get(node.id) ?? []).length === 0)
          .map((node) => ({ id: node.id, children: childrenOf.get(node.id) ?? [] }))
      : (childrenOf.get(root) ?? [])
          .filter((id) => nodes.has(id))
          .map((id) => ({ id, children: childrenOf.get(id) ?? [] }));

  const draws = new Set(spec.draws);
  const groups = new Map<
    string,
    { relation: string; from: Id; to: Id; members: Id[]; crosses: boolean }
  >();
  for (const edge of graph.edges) {
    if (!draws.has(edge.relation)) continue;
    const sourceAnchor = anchorOf(edge.source);
    const targetAnchor = anchorOf(edge.target);
    // An edge with neither end at this level belongs to the inside of a box: opening
    // that box is where it is drawn. `from`/`to` keep the ends the level does have.
    const sourceAtLevel = sourceAnchor === edge.source;
    const targetAtLevel = targetAnchor === edge.target;
    if (!sourceAtLevel && !targetAtLevel && sourceAnchor === targetAnchor) continue;
    const from = sourceAnchor ?? root;
    const to = targetAnchor ?? root;
    if (from === undefined || to === undefined) continue;
    const key = `${edge.relation}\u0000${from}\u0000${to}`;
    const crosses = sourceAnchor === undefined || targetAnchor === undefined;
    const group = groups.get(key);
    if (group) {
      group.members.push(edge.id);
      group.crosses = group.crosses || crosses;
    } else {
      groups.set(key, { relation: edge.relation, from, to, members: [edge.id], crosses });
    }
  }

  const edges: ScopeEdge[] = [...groups.values()].map((group) => ({
    ...group,
    count: group.members.length,
  }));

  return { root, boxes, edges, issues: [] };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
