import { memo } from 'react';
import { NodeResizer } from '@reactflow/node-resizer';
import { Handle, Position, type NodeProps } from 'reactflow';
import { FolderOpen } from 'lucide-react';
import { CANVAS_ACCENT } from '../../utils/canvasColors';
import type { SystemNodeData } from './systemActions';
import { SystemFrameHeader } from './SystemNode';
import './canvas.css';

/**
 * A dashed frame around its members; a color or tag (dsl/palette.ts) tints it.
 * The frame of an expanded system has the system's status and controls in its header.
 */
function GroupNode({ id, data, selected }: NodeProps<SystemNodeData>) {
  const custom = {
    ...(data.backgroundColor ? { backgroundColor: data.backgroundColor } : {}),
    ...(data.borderColor ? { borderColor: data.borderColor } : {}),
    ...(data.borderStyle ? { borderStyle: data.borderStyle } : {}),
  };

  return (
    <div className="relative w-full h-full">
      <NodeResizer color={CANVAS_ACCENT} isVisible={selected} minWidth={300} minHeight={200} />
      <div className="pc-group" style={custom} data-system={data.system ? data.system.status : undefined}>
        {data.system ? (
          <SystemFrameHeader id={id} name={data.name} team={data.ownerTeam} summary={data.system} />
        ) : (
          <div className="pc-group__name" style={data.borderColor ? { color: data.borderColor } : undefined}>
            <FolderOpen size={14} aria-hidden="true" />
            {data.name}
          </div>
        )}
        {data.description && <div className="pc-group__desc">{data.description}</div>}
      </div>
      {/* React Flow draws no edge to a node without handles, so `gw -> services` needs these. */}
      <Handle type="target" position={Position.Top} className="pc-handle--hidden" isConnectable={false} />
      <Handle type="source" position={Position.Bottom} className="pc-handle--hidden" isConnectable={false} />
    </div>
  );
}

export default memo(GroupNode);
