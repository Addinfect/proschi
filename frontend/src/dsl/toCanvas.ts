import type { CanvasEdge, CanvasNode, ComponentMetadata } from '../types/canvas';
import { DASH_ARRAY, cssTint, nodeBaseColor } from './palette';
import type { Diagram, DiagramEdge, DiagramNode } from './types';

type CSSProperties = NonNullable<CanvasEdge['style']>;

export const NODE_TYPE: Record<DiagramNode['kind'], string> = {
  component: 'componentNode',
  group: 'groupNode',
  text: 'textNode',
  // A collapsed system: its contract and status (Canvas/SystemNode.tsx).
  system: 'systemNode',
};

const GRID_COLUMNS = 4;
const GRID_X = 260;
const GRID_Y = 180;

/**
 * Converts a parsed diagram into canvas nodes and edges. Nodes without an
 * explicit `pos` get a simple grid position until auto-layout replaces it.
 */
export function toCanvas(diagram: Diagram): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  let unplaced = 0;

  const nodes = diagram.nodes.map((node): CanvasNode => {
    const position = node.position ?? {
      x: (unplaced % GRID_COLUMNS) * GRID_X,
      y: Math.floor(unplaced / GRID_COLUMNS) * GRID_Y,
    };
    if (!node.position) unplaced++;

    return { id: node.id, type: NODE_TYPE[node.kind], position, data: toMetadata(node) };
  });

  const edges = diagram.edges.map((edge): CanvasEdge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    ...edgeStyle(edge),
  }));

  return { nodes, edges };
}

export function toMetadata(node: DiagramNode): ComponentMetadata {
  const data: ComponentMetadata = {
    id: node.id,
    name: node.name,
    type: node.type,
    techStack: node.techStack,
    ownerTeam: node.ownerTeam,
    description: node.description,
  };
  if (node.kind === 'text') {
    data.textContent = node.description ?? node.name;
    data.fontSize = 14;
  }
  // Colors as CSS that follows the theme: explicit color, then tag, then the category default (palette.ts).
  const base = nodeBaseColor(node);
  if (base) {
    const tint = cssTint(base);
    data.backgroundColor = node.kind === 'group' ? tint.groupFill : tint.fill;
    data.borderColor = tint.line;
  }
  if (node.style?.dash) data.borderStyle = node.style.dash;
  if (node.tag) data.tag = node.tag;
  if (node.critical) data.critical = true;
  return data;
}

/**
 * The stroke of a tagged edge, as the React Flow edge's `style` (and its tag
 * in `data`), so any edge component draws it; nothing for an untagged edge.
 */
export function edgeStyle(edge: DiagramEdge): { style?: CSSProperties; data?: { tag: string } } {
  if (!edge.tag) return {};
  const style: CSSProperties = {};
  if (edge.style?.color) style.stroke = cssTint(edge.style.color).line;
  if (edge.style?.dash) style.strokeDasharray = DASH_ARRAY[edge.style.dash];
  return { style, data: { tag: edge.tag } };
}

/** Adds each diagram edge's tag style to the React Flow edge with its id. */
export function withEdgeStyles<E extends { id: string; style?: CSSProperties; data?: unknown }>(diagram: Diagram, edges: E[]): E[] {
  const byId = new Map(diagram.edges.map((e) => [e.id, e]));
  return edges.map((edge) => {
    const source = byId.get(edge.id);
    const extra = source ? edgeStyle(source) : {};
    if (!extra.style) return edge;
    const data = edge.data && typeof edge.data === 'object' ? edge.data : {};
    return { ...edge, style: { ...edge.style, ...extra.style }, data: { ...data, ...extra.data } };
  });
}
