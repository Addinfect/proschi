import type { Edge, Node } from 'reactflow';
import type { ComponentMetadata } from '../types/canvas';
import type { Diagram, DiagramNode } from './types';
import { bundledElk, layoutGraph, type EdgeRoute, type LaidOutNode, type Layout, type LayoutOptions } from './autoLayout';
import { ElkWorkerUnavailable, workerElk } from './elkWorker';
import { NODE_TYPE, toMetadata } from './toCanvas';

/**
 * Positions every node for the canvas. The placement itself lives in
 * autoLayout.ts (shared with `proschi render`); this turns it into React Flow
 * nodes, with group members positioned relative to their group. Each
 * edge's route rides on its source node (`data.routes`), where the edge
 * component (Canvas/RoutedEdge.tsx) reads it together with where the node is now.
 *
 * In the browser ELK runs in a Web Worker (elkWorker.ts); where there is no
 * Worker (tests in Node) or it cannot start, ELK runs on this thread.
 */

let useWorker = typeof Worker !== 'undefined';

/** A collapsed system box (Canvas/SystemNode.tsx): name, promise, load, entry points and controls. */
export const SYSTEM_NODE_SIZE = { width: 300, height: 168 };

const CANVAS_SIZES: LayoutOptions = { nodeSize: (node: DiagramNode) => (node.kind === 'system' ? SYSTEM_NODE_SIZE : undefined) };

async function place(diagram: Diagram): Promise<Layout> {
  if (useWorker) {
    try {
      return await layoutGraph(diagram, workerElk, CANVAS_SIZES);
    } catch (error) {
      if (!(error instanceof ElkWorkerUnavailable)) throw error;
      console.warn('Laying out on the main thread:', error);
      useWorker = false;
    }
  }
  return layoutGraph(diagram, bundledElk, CANVAS_SIZES);
}

export async function layoutDiagram(diagram: Diagram): Promise<Node<ComponentMetadata>[]> {
  const { nodes, routes } = await place(diagram);
  return toFlowNodes(diagram, nodes, routes);
}

// Matches autoLayout's node sizes closely enough for a first frame.
const CELL = { width: 240, height: 110, gapX: 48, gapY: 72 };
const GROUP_PAD = { top: 56, side: 24 };

/**
 * A cheap grid placement, available at once, for the first frame while ELK
 * loads; layoutDiagram's result replaces it. Pinned positions are kept.
 */
export function provisionalLayout(diagram: Diagram): Node<ComponentMetadata>[] {
  const boxes = new Map<string, LaidOutNode>();
  const ids = new Set(diagram.nodes.map((n) => n.id));
  const children = new Map<string | undefined, Diagram['nodes']>();
  for (const node of diagram.nodes) {
    const parent = node.parent && ids.has(node.parent) ? node.parent : undefined;
    children.set(parent, [...(children.get(parent) ?? []), node]);
  }
  // Lays out the members of `parent`, returns the size they take.
  const place = (parent: string | undefined): { width: number; height: number } => {
    const members = children.get(parent) ?? [];
    const columns = Math.max(1, Math.ceil(Math.sqrt(members.length)));
    const offset = parent ? { x: GROUP_PAD.side, y: GROUP_PAD.top } : { x: 0, y: 0 };
    let x = offset.x;
    let y = offset.y;
    let rowHeight = 0;
    const extent = { width: 0, height: 0 };
    members.forEach((node, i) => {
      if (i > 0 && i % columns === 0) {
        x = offset.x;
        y += rowHeight + CELL.gapY;
        rowHeight = 0;
      }
      const size = node.kind === 'group' ? grow(place(node.id)) : node.kind === 'system' ? SYSTEM_NODE_SIZE : { width: CELL.width, height: CELL.height };
      const position = node.position ?? { x, y };
      boxes.set(node.id, { id: node.id, position, ...size, ...(parent ? { parent } : {}) });
      x += size.width + CELL.gapX;
      rowHeight = Math.max(rowHeight, size.height);
      extent.width = Math.max(extent.width, position.x + size.width);
      extent.height = Math.max(extent.height, position.y + size.height);
    });
    return extent;
  };
  const grow = (inner: { width: number; height: number }) => ({
    width: Math.max(300, inner.width + GROUP_PAD.side),
    height: Math.max(200, inner.height + GROUP_PAD.side),
  });
  place(undefined);
  return toFlowNodes(diagram, [...boxes.values()]);
}

function toFlowNodes(diagram: Diagram, laidOut: LaidOutNode[], routes: Record<string, EdgeRoute> = {}): Node<ComponentMetadata>[] {
  const boxes = new Map(laidOut.map((b) => [b.id, b]));
  const bySource = new Map<string, Record<string, EdgeRoute>>();
  for (const edge of diagram.edges) {
    if (routes[edge.id]) bySource.set(edge.source, { ...bySource.get(edge.source), [edge.id]: routes[edge.id] });
  }
  return diagram.nodes.map((node): Node<ComponentMetadata> => {
    const box = boxes.get(node.id)!;
    const rfNode: Node<ComponentMetadata> = {
      id: node.id,
      type: NODE_TYPE[node.kind],
      position: box.position,
      data: bySource.has(node.id) ? { ...toMetadata(node), routes: bySource.get(node.id) } : toMetadata(node),
    };
    if (box.parent) rfNode.parentNode = box.parent;
    if (node.kind === 'group') {
      rfNode.style = { width: box.width, height: box.height };
      rfNode.zIndex = -1;
    } else if (node.kind === 'system') {
      rfNode.style = { width: box.width, height: box.height };
    } else {
      rfNode.style = { width: box.width };
    }
    return rfNode;
  });
}

export function toFlowEdges(diagram: Diagram): Edge[] {
  return diagram.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, label: e.label }));
}
