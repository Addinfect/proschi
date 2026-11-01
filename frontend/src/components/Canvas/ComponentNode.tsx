import { memo, type CSSProperties } from 'react';
import { Handle, Position } from 'reactflow';
import { NodeResizer } from '@reactflow/node-resizer';
import { TriangleAlert } from 'lucide-react';
import type { NodeProps } from 'reactflow';
import type { ComponentMetadata } from '../../types/canvas';
import { getTechStackIcon } from '../../utils/iconMapping';
import { CANVAS_ACCENT } from '../../utils/canvasColors';
import { heat, heatText } from '../../utils/heat';
import type { NodeOverlay } from '../../sim/overlay';
import './canvas.css';

/**
 * A component on the canvas: monochrome card, thick border, hard shadow. Colour
 * is kept for what matters while you look: the selected node, and the active
 * or failing node during playback (classes from UseCasePlayback, styled in canvas.css).
 */
const ComponentNode = ({ data, selected }: NodeProps<ComponentMetadata>) => {
  const icon = getTechStackIcon(data.techStack, data.type);
  const o = data.overlay;
  const u = o?.utilization;

  return (
    <div
      className="pc-node"
      data-selected={selected || undefined}
      data-load={o ? (o.down ? 'down' : o.saturated ? 'over' : u !== undefined && u >= 0.9 ? 'hot' : 'ok') : undefined}
      data-heat={o ? heatText(u, o.down) : undefined}
      data-stack={o?.replicas && o.replicas > 1 ? Math.min(2, o.replicas - 1) : undefined}
      // The load overlay wins over the node's colors while it is on (D4).
      style={o ? { background: heat(u, o.down) } : tintVars(data)}
    >
      {data.critical && (
        <span className="pc-node__critical" role="img" aria-label="Critical" title="Critical">
          <TriangleAlert size={13} strokeWidth={2.5} aria-hidden="true" />
        </span>
      )}
      <NodeResizer color={CANVAS_ACCENT} isVisible={selected && !data.fixedSize} minWidth={180} minHeight={80} />

      <Handle type="target" position={Position.Top} className="pc-handle" />

      <div className="flex items-center gap-2.5">
        <div className="pc-node__icon">{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="pc-node__name truncate">{data.name}</div>
          <div className="pc-node__tech truncate">{data.techStack}</div>
        </div>
      </div>

      {data.ownerTeam && !o && <div className="pc-node__team truncate">Team: {data.ownerTeam}</div>}
      {o && <LoadBadge overlay={o} />}

      <Handle type="source" position={Position.Bottom} className="pc-handle" />
    </div>
  );
};

/** The node's colors as custom properties, so playback and overlay styles in canvas.css still win. */
function tintVars(data: ComponentMetadata): CSSProperties | undefined {
  if (!data.backgroundColor && !data.borderColor && !data.borderStyle) return undefined;
  return {
    ...(data.backgroundColor ? { '--pc-fill': data.backgroundColor } : {}),
    ...(data.borderColor ? { '--pc-line': data.borderColor } : {}),
    ...(data.borderStyle ? { '--pc-dash': data.borderStyle } : {}),
  } as CSSProperties;
}

/** Replicas, size, shards and how busy the node is, with a bar; "down" when it is. */
function LoadBadge({ overlay: o }: { overlay: NodeOverlay }) {
  const u = o.utilization;
  const parts = [o.replicas && o.replicas > 1 ? `×${o.replicas}` : '', o.size ?? '', o.shards && o.shards > 1 ? `⧉${o.shards}` : '', o.down ? 'down' : u !== undefined ? `${Math.round(u * 100)}%` : ''].filter(Boolean);
  return (
    <div className="pc-node__load">
      {parts.length > 0 && <div className="pc-node__stats">{parts.join(' · ')}</div>}
      {u !== undefined && !o.down && (
        <div className="pc-node__bar" aria-hidden="true">
          <div style={{ width: `${Math.min(100, u * 100)}%` }} data-over={u >= 1 || undefined} />
        </div>
      )}
    </div>
  );
}

export default memo(ComponentNode);
