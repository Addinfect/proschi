import { memo, useId, useState, type SyntheticEvent } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { ArrowUpRight, Boxes, CircleAlert, CircleCheck, CircleDashed, Maximize2, Minimize2, TriangleAlert } from 'lucide-react';
import { useSystemActions, type SystemNodeData } from './systemActions';
import type { SystemStatus, SystemSummary } from './systemSummary';
import './canvas.css';

/**
 * A team's design as one box (docs/design/team-systems-and-imports.md): its
 * name and team, the promise its requirements make, what the rest of the
 * diagram sends against what it takes, its entry points, and whether that
 * load saturates it or breaks its SLA. Double-click (or Open) navigates into
 * the design; Expand unfolds it in place.
 */
function SystemNode({ id, data, selected }: NodeProps<SystemNodeData>) {
  const s = data.system;
  const actions = useSystemActions();
  const status = s?.status ?? 'unsimulated';
  return (
    <div className="pc-node pc-system" data-selected={selected || undefined} data-status={status} data-stub={s && !s.linked ? '' : undefined}>
      <Handle type="target" position={Position.Top} className="pc-handle" />

      <div className="pc-system__head">
        <div className="pc-node__icon">
          <Boxes aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="pc-node__name pc-system__name" title={data.name}>
            {data.name}
          </div>
          <div className="pc-node__tech truncate">
            {data.ownerTeam ? `@${data.ownerTeam}` : 'system'}
          </div>
        </div>
        {s && <StatusPill summary={s} side />}
      </div>

      {s && (
        <dl className="pc-system__facts">
          <dt>Promise</dt>
          <dd className="truncate">{s.promise ?? 'none stated'}</dd>
          <dt>Load</dt>
          <dd>
            <span className="truncate">{s.headroom?.text ?? '—'}</span>
            {s.headroom && s.headroom.ratio > 0 && (
              <span className="pc-node__bar pc-system__bar" aria-hidden="true">
                <span style={{ width: `${Math.min(100, s.headroom.ratio * 100)}%` }} />
              </span>
            )}
          </dd>
        </dl>
      )}

      {s && !s.linked && <p className="pc-system__unlinked">{s.stub ? 'Declared, no design linked' : 'Declared, no design and no capacity: not simulated'}</p>}

      {/* Entry points and the buttons share the last row, so neither is squeezed out of the box. */}
      <div className="pc-system__foot">
        {s && s.ports.length > 0 && (
          <ul className="pc-system__ports" aria-label="Entry points">
            {s.ports.map((p) => (
              <li key={p.id} title={p.useCase ? `${p.name} → "${p.useCase}"` : p.name}>
                {p.id}
              </li>
            ))}
          </ul>
        )}
        {actions && s?.linked && (
          <div className="pc-system__actions nodrag">
            <button type="button" onClick={() => actions.open(id)} aria-label={`Open ${data.name}`} title="Open this team's design (double-click)">
              <ArrowUpRight size={13} aria-hidden="true" />
              Open
            </button>
            <button type="button" onClick={() => actions.toggle(id)} aria-label={`Expand ${data.name}`} title="Unfold the design here">
              <Maximize2 size={12} aria-hidden="true" />
              Expand
            </button>
          </div>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} className="pc-handle" />
    </div>
  );
}

const STATUS_ICON: Record<SystemStatus, typeof CircleCheck> = {
  ok: CircleCheck,
  idle: CircleDashed,
  hot: TriangleAlert,
  over: CircleAlert,
  unsimulated: CircleDashed,
};

/**
 * The status, with what the simulation found and who to ask in a short
 * tooltip (on hover and on focus): beside the box with `side`, so it does not
 * cover the boxes above; below the pill otherwise. Where the canvas has no
 * room for it there, it goes to the left of the box, else below, opening to whichever side fits. The full
 * findings are in the Results tab.
 */
export function StatusPill({ summary: s, side }: { summary: SystemSummary; side?: boolean }) {
  const tipId = useId();
  const Icon = STATUS_ICON[s.status];
  const details = s.tip.lines.length > 0 || s.hint;
  const [place, setPlace] = useState<TipPlace>(side ? 'right' : 'below');
  const fit = (e: SyntheticEvent<HTMLElement>) => setPlace(fitTip(e.currentTarget, side));
  return (
    <span className="pc-system__status nodrag" data-status={s.status} data-side={side || undefined} data-place={place} onMouseEnter={fit} onFocus={fit}>
      <button type="button" aria-describedby={details ? tipId : undefined} tabIndex={details ? 0 : -1} className="pc-system__pill">
        <Icon size={12} strokeWidth={2.5} aria-hidden="true" />
        {s.label}
      </button>
      {details && (
        <span role="tooltip" id={tipId} className="pc-system__tip">
          <strong className="pc-system__tip-head">{s.tip.headline}</strong>
          {s.tip.lines.length > 0 && (
            <span className="pc-system__tip-lines">
              {s.tip.lines.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </span>
          )}
          {s.hint && <span className="pc-system__hint">{s.hint}</span>}
        </span>
      )}
    </span>
  );
}

type TipPlace = 'right' | 'left' | 'below' | 'below-start';

/** Where the tooltip fits inside the canvas: beside the box (`side` only, right then left), else below, opening left or right. */
function fitTip(status: HTMLElement, side?: boolean): TipPlace {
  const tip = status.querySelector<HTMLElement>('.pc-system__tip');
  if (!tip) return side ? 'right' : 'below';
  // The tooltip is laid out against the box with `side`, against the pill otherwise.
  const anchor = ((side && status.closest('.pc-system')) || status).getBoundingClientRect();
  const bounds = (status.closest('.react-flow') ?? document.documentElement).getBoundingClientRect();
  const width = tip.getBoundingClientRect().width;
  const gap = 14 * (width / (tip.offsetWidth || width));
  if (side && anchor.right + gap + width <= bounds.right) return 'right';
  if (side && anchor.left - gap - width >= bounds.left) return 'left';
  return anchor.right - width >= bounds.left ? 'below' : 'below-start';
}

/** The header controls of an expanded system's frame: status, open, collapse. */
export function SystemFrameHeader({ id, name, team, summary }: { id: string; name: string; team?: string; summary: SystemSummary }) {
  const actions = useSystemActions();
  return (
    <div className="pc-system-frame__head">
      <Boxes size={14} aria-hidden="true" />
      <span className="pc-group__name" title={name}>
        {name}
      </span>
      {team && <span className="pc-system-frame__team" title={`@${team}`}>@{team}</span>}
      <StatusPill summary={summary} />
      {actions && (
        <span className="pc-system__actions nodrag">
          <button type="button" onClick={() => actions.open(id)} aria-label={`Open ${name}`}>
            <ArrowUpRight size={13} aria-hidden="true" />
            Open
          </button>
          <button type="button" onClick={() => actions.toggle(id)} aria-label={`Collapse ${name}`}>
            <Minimize2 size={12} aria-hidden="true" />
            Collapse
          </button>
        </span>
      )}
    </div>
  );
}

export default memo(SystemNode);
