import ReactFlow, { Background, BackgroundVariant, Controls, Panel, ReactFlowProvider } from 'reactflow';
import type { Edge, EdgeTypes, Node } from 'reactflow';
import 'reactflow/dist/style.css';
import ComponentNode from '../Canvas/ComponentNode';
import GroupNode from '../Canvas/GroupNode';
import SystemNode from '../Canvas/SystemNode';
import TextNode from '../Canvas/TextNode';
import RoutedEdge from '../Canvas/RoutedEdge';
import Legend from '../Canvas/Legend';
import type { LegendEntry } from '../../dsl/types';
import { FIT_VIEW_OPTIONS, useFitOnChange } from './useFitOnChange';

/**
 * A read-only canvas of a parsed diagram, for pages that show a design without
 * editing it through the canvas (the HLD overview, the practice editor).
 */

const nodeTypes = { componentNode: ComponentNode, groupNode: GroupNode, systemNode: SystemNode, textNode: TextNode };
/** Plain edges follow their layout route (RoutedEdge). */
const ROUTED_EDGE_TYPES: EdgeTypes = { default: RoutedEdge };

interface DiagramCanvasProps {
  nodes: Node[];
  edges: Edge[];
  /** Hide zoom controls, e.g. for a small preview. */
  compact?: boolean;
  /** Changes when the canvas becomes visible again, so it can re-fit. */
  fitKey?: string;
  /** No pan or zoom by hand, so touch and wheel scroll the page (an embedded preview). */
  still?: boolean;
  /** Glide to each new fit over this many ms instead of jumping. */
  fitDuration?: number;
  /** Custom edge types (a stable object), e.g. the playback edge of a canvas that plays use cases; plain edges are routed by default. */
  edgeTypes?: EdgeTypes;
  /** The diagram's legend, drawn in the top-right corner. */
  legend?: LegendEntry[];
}

function Canvas({ nodes, edges, compact, fitKey, still, fitDuration, edgeTypes, legend }: DiagramCanvasProps) {
  useFitOnChange(`${nodes.map((n) => n.id).join('|')}#${fitKey ?? ''}`, { duration: fitDuration });

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes ?? ROUTED_EDGE_TYPES}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      deleteKeyCode={null}
      zoomOnScroll={!compact && !still}
      zoomOnPinch={!still}
      zoomOnDoubleClick={!still}
      panOnDrag={!still}
      preventScrolling={!compact && !still}
      fitView
      fitViewOptions={FIT_VIEW_OPTIONS}
      minZoom={0.1}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
      {!compact && !still && <Controls showInteractive={false} />}
      {legend && (
        <Panel position="top-right">
          <Legend entries={legend} />
        </Panel>
      )}
    </ReactFlow>
  );
}

export default function DiagramCanvas(props: DiagramCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
