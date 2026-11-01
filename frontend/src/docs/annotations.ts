import type { Diagram } from '../dsl';

/** What an annotated line lights up on the diagram: React Flow node and edge ids. */
export interface Lit {
  nodes: string[];
  edges: string[];
}

/**
 * What a line of an annotated example draws, from where the parser says each
 * part is written: a node, group or system declared on the line lights that
 * box; a connection lights its arrow; a use case step (or its `-->` answer)
 * lights the arrow between its two nodes. Anything else lights nothing.
 */
export function litByLine(diagram: Diagram, line: number): Lit {
  const nodes = diagram.nodes.filter((n) => !n.implicit && !n.loc.file && n.loc.line === line).map((n) => n.id);
  const edges = new Set(diagram.edges.filter((e) => !e.loc.file && e.loc.line === line).map((e) => e.id));
  for (const useCase of diagram.useCases) {
    for (const step of useCase.scenarios.flatMap((s) => s.steps)) {
      if (step.loc.file || (step.loc.line !== line && step.responseLoc?.line !== line)) continue;
      const { fromServiceId: a, toServiceId: b } = step;
      const edge = diagram.edges.find((e) => (e.source === a && e.target === b) || (e.source === b && e.target === a));
      if (edge) edges.add(edge.id);
    }
  }
  return { nodes, edges: [...edges] };
}
