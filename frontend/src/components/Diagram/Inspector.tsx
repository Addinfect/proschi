import { useEffect, useId, useState } from 'react';
import { Minus, Plus, Trash2, X } from 'lucide-react';
import { componentCatalog } from '../../catalog/componentCatalog';
import { isDataStore, kindOf } from '../../dsl/kinds';
import {
  CAPACITY_FIELD,
  renameNode,
  setCapacity,
  setDescription,
  setEdgeLabel,
  setOwner,
  setReplicas,
  setSize,
  setTech,
  type CapacityPart,
} from '../../dsl/edit';
import type { CapacityOverride, DiagramEdge, DiagramNode, InstanceSize } from '../../dsl/types';
import { eyebrow, field, iconButton } from '../Playground/ui';
import type { SystemSummary } from '../Canvas/systemSummary';
import { formatRps } from '../../sim';

type Edit = (source: string) => string;

interface InspectorProps {
  node?: DiagramNode;
  edge?: DiagramEdge;
  /** The node's line in the `capacity` block, if any. */
  capacity?: CapacityOverride;
  /** The file a node or connection is declared in, when it is not this document: it is then read-only here. */
  importedFrom?: string;
  /** What the simulation says about a system box: its contract and the load it is sent. */
  system?: SystemSummary;
  /** Applies a text edit to the document. */
  onEdit: (edit: Edit) => void;
  /** Deletes the node or connection from the text. */
  onDelete: () => void;
  onClose: () => void;
}

const TECHS = componentCatalog.filter((c) => c.type !== 'group').map((c) => c.techStack);

const CAPACITY_ROWS: { part: CapacityPart; label: string; unit: string; storeOnly?: boolean }[] = [
  { part: 'rate', label: 'Capacity', unit: 'rps' },
  { part: 'latency', label: 'Latency', unit: 'ms' },
  { part: 'availability', label: 'Availability', unit: '%' },
  { part: 'cost', label: 'Cost', unit: 'usd/month' },
  { part: 'shards', label: 'Shards', unit: '', storeOnly: true },
];

/**
 * The settings of the selected node or connection. Every change is a small
 * edit of the text, which stays the source of truth.
 */
export default function Inspector({ node, edge, capacity, importedFrom, system, onEdit, onDelete, onClose }: InspectorProps) {
  const title = node ? node.name : edge ? `${edge.source} → ${edge.target}` : '';
  const readOnly = importedFrom !== undefined;
  return (
    <aside
      role="region"
      aria-label={`${title} settings`}
      className="pointer-events-auto flex max-h-full w-full flex-col rounded border-bw-1 border-ink bg-surface shadow-brutal-md"
    >
      <div className="flex items-center gap-2 border-b border-ink/15 py-1 pl-3 pr-1">
        <h2 className="min-w-0 flex-1 truncate text-sm font-bold text-ink">{title}</h2>
        <button
          type="button"
          aria-label={`Delete ${title}`}
          title="Delete"
          onClick={onDelete}
          className={`${iconButton} text-red-700 dark:text-red-300`}
        >
          <Trash2 size={16} />
        </button>
        <button type="button" aria-label="Close settings" onClick={onClose} className={iconButton}>
          <X size={16} />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {readOnly && <p className="text-xs text-muted">Declared in {importedFrom}; edit it there.</p>}
        {node && node.kind === 'system' ? (
          <SystemFields node={node} system={system} readOnly={readOnly} onEdit={onEdit} />
        ) : (
          node && <NodeFields node={node} capacity={capacity} readOnly={readOnly} onEdit={onEdit} />
        )}
        {edge && (
          <TextField
            label="Label"
            value={edge.label ?? ''}
            placeholder="e.g. reads, HTTPS"
            disabled={readOnly || /[{[<]/.test(edge.label ?? '')}
            onCommit={(label) => onEdit((src) => setEdgeLabel(src, edge.id, label || null))}
          />
        )}
      </div>
    </aside>
  );
}

function NodeFields({ node, capacity, readOnly, onEdit }: { node: DiagramNode; capacity?: CapacityOverride; readOnly: boolean; onEdit: (edit: Edit) => void }) {
  const listId = useId();
  const id = node.id;
  const kind = kindOf(node);
  // Clients, notes and groups have no capacity to set.
  const simulated = kind !== 'client' && kind !== 'other';
  const store = isDataStore(kind);
  const replicas = node.replicas ?? 1;
  return (
    <>
      <p className="font-mono text-xs text-muted">id: {id}</p>
      <TextField
        label="Name"
        value={node.name}
        disabled={readOnly}
        onCommit={(name) => {
          if (!name) return false;
          onEdit((src) => renameNode(src, id, name));
        }}
      />
      {node.kind !== 'group' && (
        <>
          <TextField
            label="Tech"
            value={node.techStack === 'Rectangle' ? '' : node.techStack}
            list={listId}
            placeholder="Redis, PostgreSQL…"
            disabled={readOnly}
            onCommit={(tech) => onEdit((src) => setTech(src, id, tech || null))}
          />
          <datalist id={listId}>
            {TECHS.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </>
      )}
      {simulated && (
        <div>
          <span className={eyebrow}>Replicas</span>
          <div className="mt-1 flex items-center gap-1">
            <button type="button" aria-label="Fewer replicas" disabled={readOnly || replicas <= 1} onClick={() => onEdit((src) => setReplicas(src, id, replicas - 1))} className={iconButton}>
              <Minus size={16} />
            </button>
            <span aria-live="polite" className="w-10 text-center font-mono text-sm tabular-nums">
              x{replicas}
            </span>
            <button type="button" aria-label="More replicas" disabled={readOnly} onClick={() => onEdit((src) => setReplicas(src, id, replicas + 1))} className={iconButton}>
              <Plus size={16} />
            </button>
          </div>
        </div>
      )}
      <TextField label="Owner team" value={node.ownerTeam ?? ''} placeholder="e.g. payments" disabled={readOnly} onCommit={(team) => onEdit((src) => setOwner(src, id, team || null))} />
      <TextField label="Description" value={node.description ?? ''} disabled={readOnly} onCommit={(text) => onEdit((src) => setDescription(src, id, text || null))} />
      {simulated && (
        <fieldset className="space-y-2 border-t border-ink/15 pt-3">
          <legend className={eyebrow}>Capacity per replica</legend>
          <p className="text-xs text-muted">Leave empty for the tech's defaults.</p>
          <label className="block">
            <span className={eyebrow}>Instance size</span>
            <select
              value={capacity?.size ?? 'S'}
              disabled={readOnly}
              onChange={(e) => onEdit((src) => setSize(src, id, e.target.value === 'S' ? null : (e.target.value as InstanceSize)))}
              className={`${field} mt-1 w-full`}
            >
              <option value="S">S (the tech's defaults)</option>
              <option value="M">M: ×2 capacity, ×1.8 cost</option>
              <option value="L">L: ×4 capacity, ×3.5 cost</option>
            </select>
          </label>
          {CAPACITY_ROWS.filter((r) => !r.storeOnly || store).map((row) => {
            const current = capacity?.[CAPACITY_FIELD[row.part]];
            return (
              <TextField
                key={row.part}
                label={row.label}
                unit={row.unit}
                inputMode="decimal"
                value={typeof current === 'number' ? String(current) : ''}
                disabled={readOnly || (row.part === 'rate' && (capacity?.readRps !== undefined || capacity?.writeRps !== undefined))}
                onCommit={(text) => {
                  const value = text === '' ? null : Number(text.replace(/[,_\s]/g, ''));
                  if (value !== null && !(value >= 0)) return false;
                  onEdit((src) => setCapacity(src, id, row.part, value));
                }}
              />
            );
          })}
        </fieldset>
      )}
    </>
  );
}

/** A system box: its name, and what its team promises and what it is sent (its own settings are in its block in the text). */
function SystemFields({ node, system: s, readOnly, onEdit }: { node: DiagramNode; system?: SystemSummary; readOnly: boolean; onEdit: (edit: Edit) => void }) {
  return (
    <>
      <p className="font-mono text-xs text-muted">
        system: {node.id}
        {node.ownerTeam ? ` · @${node.ownerTeam}` : ''}
      </p>
      <TextField
        label="Name"
        value={node.name}
        disabled={readOnly}
        onCommit={(name) => {
          if (!name) return false;
          onEdit((src) => renameNode(src, node.id, name));
        }}
      />
      {s && (
        <section aria-label="Contract" className="space-y-2 border-t border-ink/15 pt-3 text-sm">
          <p>
            <span className={eyebrow}>Status</span>{' '}
            <span className={`font-bold ${s.status === 'over' ? 'text-red-700 dark:text-red-300' : s.status === 'hot' ? 'text-amber-800 dark:text-amber-200' : 'text-ink'}`}>{s.label}</span>
          </p>
          <p className="text-xs text-muted">{s.linked ? `Design: ${s.file ?? 'linked'}` : s.stub ? 'Declared, no design linked: its capacity { … } is the contract.' : 'Declared, no design linked and no capacity: not simulated.'}</p>
          {s.promise && (
            <p>
              <span className={eyebrow}>Promise</span> <span className="font-mono text-xs">{s.promise}</span>
            </p>
          )}
          {s.ports.length > 0 && (
            <ul className="space-y-1">
              {s.ports.map((p) => (
                <li key={p.id} className="font-mono text-xs">
                  <span className="font-bold">→ {p.id}</span>
                  {p.useCase ? ` "${p.useCase}"` : ''}: {formatRps(p.sentRps)} sent, takes {Number.isFinite(p.limitRps) ? `${formatRps(p.limitRps)} more` : 'any load'}
                </li>
              ))}
            </ul>
          )}
          {s.warnings.map((w) => (
            <p key={w} className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
              {w}
            </p>
          ))}
          {s.hint && <p className="text-xs font-bold text-ink">{s.hint}</p>}
        </section>
      )}
    </>
  );
}

interface TextFieldProps {
  label: string;
  value: string;
  unit?: string;
  placeholder?: string;
  list?: string;
  inputMode?: 'decimal';
  disabled?: boolean;
  /** Called on Enter or blur with a changed value; returning false rejects it. */
  onCommit: (value: string) => void | false;
}

/** An input that keeps its own text while typing and writes it on Enter or blur. */
function TextField({ label, value, unit, placeholder, list, inputMode, disabled, onCommit }: TextFieldProps) {
  const [text, setText] = useState(value);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(value);
    setInvalid(false);
  }, [value]);
  const commit = () => {
    const clean = text.trim();
    if (clean === value) return;
    const ok = onCommit(clean) !== false;
    setInvalid(!ok);
  };
  return (
    <label className="block">
      <span className={eyebrow}>{label}</span>
      <span className="mt-1 flex items-center gap-1.5">
        <input
          value={text}
          list={list}
          inputMode={inputMode}
          placeholder={placeholder}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setText(value);
          }}
          className={`${field} w-full min-w-0 aria-[invalid]:border-fail`}
        />
        {unit && <span className="flex-shrink-0 text-xs text-muted">{unit}</span>}
      </span>
    </label>
  );
}
