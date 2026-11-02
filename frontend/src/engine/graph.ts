import type { Edge, Graph, Id, Node } from './types';

/**
 * Walks over a typed graph: adjacency, reachability, order, cycles.
 *
 * Every function is pure and takes the index `indexGraph` builds, so a view that
 * asks many questions builds adjacency once. None of them care which relations
 * exist; `WalkOptions` chooses the edges a walk follows, which is how one graph
 * is read as a dependency order, a flow, or a containment tree.
 */

/** A graph with its adjacency built once, so walks do not scan every edge. */
export interface GraphIndex {
  /** The graph the index was built from, nodes and edges in declaration order. */
  graph: Graph;
  /** Nodes by id; a repeated id keeps its first node. */
  nodes: ReadonlyMap<Id, Node>;
  edges: readonly Edge[];
  /** Edges leaving a node, by node id. Absent means none. */
  outgoing: ReadonlyMap<Id, readonly Edge[]>;
  /** Edges entering a node, by node id. Absent means none. */
  incoming: ReadonlyMap<Id, readonly Edge[]>;
}

/** Which edges a walk follows. */
export interface WalkOptions {
  /** Only these relations; absent means every relation. */
  relations?: readonly string[];
  /** Only edges this predicate accepts; absent means every edge. */
  where?: (edge: Edge) => boolean;
}

/** True when the edge passes the options. */
function follows(edge: Edge, options?: WalkOptions): boolean {
  if (!options) return true;
  if (options.relations && !options.relations.includes(edge.relation)) return false;
  if (options.where && !options.where(edge)) return false;
  return true;
}

/** Builds the adjacency of a graph; repeated node ids keep the first node. */
export function indexGraph(graph: Graph): GraphIndex {
  const nodes = new Map<Id, Node>();
  for (const node of graph.nodes) {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  }
  const outgoing = new Map<Id, Edge[]>();
  const incoming = new Map<Id, Edge[]>();
  const push = (into: Map<Id, Edge[]>, key: Id, edge: Edge): void => {
    const list = into.get(key);
    if (list) list.push(edge);
    else into.set(key, [edge]);
  };
  for (const edge of graph.edges) {
    push(outgoing, edge.source, edge);
    push(incoming, edge.target, edge);
  }
  return { graph, nodes, edges: graph.edges, outgoing, incoming };
}

/** The edges a walk follows, in declaration order. */
export function edgesOf(index: GraphIndex, options?: WalkOptions): readonly Edge[] {
  return options ? index.edges.filter((edge) => follows(edge, options)) : index.edges;
}

/** The ids the edges leaving `id` lead to, once each, in declaration order. */
export function successors(index: GraphIndex, id: Id, options?: WalkOptions): Id[] {
  const result: Id[] = [];
  for (const edge of index.outgoing.get(id) ?? []) {
    if (!follows(edge, options)) continue;
    if (!result.includes(edge.target)) result.push(edge.target);
  }
  return result;
}

/** The ids the edges entering `id` come from, once each, in declaration order. */
export function predecessors(index: GraphIndex, id: Id, options?: WalkOptions): Id[] {
  const result: Id[] = [];
  for (const edge of index.incoming.get(id) ?? []) {
    if (!follows(edge, options)) continue;
    if (!result.includes(edge.source)) result.push(edge.source);
  }
  return result;
}

/** Nodes no followed edge enters; a node with no edges at all is one of them. */
export function sources(index: GraphIndex, options?: WalkOptions): Id[] {
  const result: Id[] = [];
  for (const id of index.nodes.keys()) {
    if (predecessors(index, id, options).length === 0) result.push(id);
  }
  return result;
}

/** Nodes no followed edge leaves; a node with no edges at all is one of them. */
export function sinks(index: GraphIndex, options?: WalkOptions): Id[] {
  const result: Id[] = [];
  for (const id of index.nodes.keys()) {
    if (successors(index, id, options).length === 0) result.push(id);
  }
  return result;
}

/** How many followed edges enter and leave a node. */
export interface Degree {
  /** Followed edges entering the node. */
  in: number;
  /** Followed edges leaving the node. */
  out: number;
}

/** Counts the followed edges entering and leaving one node. */
export function degreeOf(index: GraphIndex, id: Id, options?: WalkOptions): Degree {
  const incoming = (index.incoming.get(id) ?? []).filter((edge) => follows(edge, options));
  const outgoing = (index.outgoing.get(id) ?? []).filter((edge) => follows(edge, options));
  return { in: incoming.length, out: outgoing.length };
}

/**
 * Every node reachable from `start` by followed edges. `start` is left out
 * unless a cycle leads back to it.
 */
export function reachableFrom(index: GraphIndex, start: Id, options?: WalkOptions): ReadonlySet<Id> {
  const seen = new Set<Id>();
  let frontier: Id[] = [start];
  while (frontier.length > 0) {
    const next: Id[] = [];
    for (const id of frontier) {
      for (const target of successors(index, id, options)) {
        if (seen.has(target)) continue;
        seen.add(target);
        next.push(target);
      }
    }
    frontier = next;
  }
  return seen;
}

/** True when followed edges lead from `from` to `to`; a node reaches itself only through a cycle. */
export function reaches(index: GraphIndex, from: Id, to: Id, options?: WalkOptions): boolean {
  return reachableFrom(index, from, options).has(to);
}

/**
 * Every node's reachable set, built once. Quadratic in the number of nodes, which
 * is fine for a model and too much for a large dataset.
 */
export function transitiveClosure(
  index: GraphIndex,
  options?: WalkOptions,
): ReadonlyMap<Id, ReadonlySet<Id>> {
  const closure = new Map<Id, ReadonlySet<Id>>();
  for (const id of index.nodes.keys()) closure.set(id, reachableFrom(index, id, options));
  return closure;
}

/**
 * Every node once, each one after the nodes that reach it through followed
 * edges, or undefined when those edges close a cycle. The order is stable: nodes
 * that could go either way keep their declaration order.
 */
export function topologicalOrder(index: GraphIndex, options?: WalkOptions): Id[] | undefined {
  const indegree = new Map<Id, number>();
  for (const id of index.nodes.keys()) indegree.set(id, 0);
  const out = new Map<Id, Id[]>();
  for (const edge of edgesOf(index, options)) {
    if (!index.nodes.has(edge.source) || !index.nodes.has(edge.target)) continue;
    const list = out.get(edge.source);
    if (list) list.push(edge.target);
    else out.set(edge.source, [edge.target]);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }
  const queue = [...indegree].filter(([, count]) => count === 0).map(([id]) => id);
  const order: Id[] = [];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    order.push(id);
    for (const target of out.get(id) ?? []) {
      const left = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, left);
      if (left === 0) queue.push(target);
    }
  }
  return order.length === indegree.size ? order : undefined;
}

/**
 * Groups of nodes that close a cycle among the followed edges, each group
 * sorted, the groups sorted too. A node with an edge to itself is a group of
 * one. The walk is recursive, so it is at home on a model rather than on a graph
 * of millions of nodes.
 */
export function cycles(index: GraphIndex, options?: WalkOptions): Id[][] {
  const edges = edgesOf(index, options);
  const adjacency = new Map<Id, Id[]>();
  for (const id of index.nodes.keys()) adjacency.set(id, []);
  for (const edge of edges) {
    if (!index.nodes.has(edge.source) || !index.nodes.has(edge.target)) continue;
    adjacency.get(edge.source)?.push(edge.target);
  }

  const entered = new Map<Id, number>();
  const low = new Map<Id, number>();
  const onStack = new Set<Id>();
  const stack: Id[] = [];
  const groups: Id[][] = [];
  let counter = 0;

  // Tarjan's strongly connected components.
  const strong = (id: Id): void => {
    entered.set(id, counter);
    low.set(id, counter);
    counter += 1;
    stack.push(id);
    onStack.add(id);
    for (const target of adjacency.get(id) ?? []) {
      if (!entered.has(target)) {
        strong(target);
        low.set(id, Math.min(low.get(id) ?? 0, low.get(target) ?? 0));
      } else if (onStack.has(target)) {
        low.set(id, Math.min(low.get(id) ?? 0, entered.get(target) ?? 0));
      }
    }
    if (low.get(id) !== entered.get(id)) return;
    const group: Id[] = [];
    let popped: Id | undefined;
    do {
      popped = stack.pop();
      if (popped === undefined) break;
      onStack.delete(popped);
      group.push(popped);
    } while (popped !== id);
    groups.push(group.reverse());
  };

  for (const id of index.nodes.keys()) {
    if (!entered.has(id)) strong(id);
  }

  const found: Id[][] = [];
  for (const group of groups) {
    if (group.length > 1) {
      found.push([...group].sort());
      continue;
    }
    const only = group[0];
    if (only === undefined) continue;
    if (edges.some((edge) => edge.source === only && edge.target === only)) found.push([only]);
  }
  return found.sort((a, b) => a.join('\u0000').localeCompare(b.join('\u0000')));
}

/** Groups of nodes joined by edges read as undirected, each group in declaration order. */
export function weaklyConnected(index: GraphIndex): Id[][] {
  const seen = new Set<Id>();
  const groups: Id[][] = [];
  for (const start of index.nodes.keys()) {
    if (seen.has(start)) continue;
    const group: Id[] = [];
    const queue: Id[] = [start];
    seen.add(start);
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) break;
      group.push(id);
      for (const edge of [...(index.outgoing.get(id) ?? []), ...(index.incoming.get(id) ?? [])]) {
        const other: Id = edge.source === id ? edge.target : edge.source;
        if (other === id || seen.has(other) || !index.nodes.has(other)) continue;
        seen.add(other);
        queue.push(other);
      }
    }
    groups.push(group);
  }
  return groups;
}

/** The part of a graph that keeps the given nodes; an edge with an end outside is dropped. */
export function subgraphOf(graph: Graph, keep: ReadonlySet<Id>): Graph {
  return {
    nodes: graph.nodes.filter((node) => keep.has(node.id)),
    edges: graph.edges.filter((edge) => keep.has(edge.source) && keep.has(edge.target)),
  };
}
