import type { KeyboardEvent } from 'react';
import type { Id } from '../engine';
import { drawnPath, edgeText, fitLabel, headPath, membersText } from './ink';
import type { LayoutBox, LayoutEdge, ScopeLayout } from './layout';

/**
 * A placed level, drawn: `<svg>` and a loop over the numbers.
 *
 * Every position, every path and every string here comes from `layoutScope` and
 * `ink`; this file decides nothing about the model and very little about the
 * picture. That is the point of the split: the drawing can be checked without a
 * browser, and what is left here is small enough to read in one go.
 *
 * What it *does* decide is what a reader can hit, and that is the reason there is
 * no diagram library under it. A box is a `<g role="button">` with a `<rect>`, so
 * the thing a click lands on is the thing that was drawn -- no wrapper geometry,
 * no hit testing, and focus, Enter and Space come out of the platform rather than
 * out of a package. A box that opens, opens; a box that does not, is marked. One
 * target, one action, and the host supplies both as callbacks: the canvas knows
 * nothing about routes, history or stores.
 *
 * Zoom and pan are not here yet. They belong on the `viewBox`, one state and two
 * handlers, and they change nothing below this line.
 */

export interface ScopeCanvasProps {
  readonly layout: ScopeLayout;
  /** A box with something inside it. Absent, no box opens. */
  readonly onOpen?: (id: Id) => void;
  /** A box without: marking it without leaving the picture. */
  readonly onSelect?: (id: Id) => void;
  /** The marked box. Drawn, never decided, here. */
  readonly selected?: Id;
  /** The picture's accessible name. Without one it is decoration. */
  readonly label?: string;
  readonly className?: string;
}

/** The drawn font size. `layoutScope`'s `charWidth` assumes the same, roughly. */
const FONT = 11;

export default function ScopeCanvas({
  layout,
  onOpen,
  onSelect,
  selected,
  label,
  className,
}: ScopeCanvasProps) {
  const frame = layout.frame;
  return (
    <svg
      className={cx('block h-auto w-full font-mono select-none', className)}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role={label === undefined ? undefined : 'group'}
      aria-label={label}
      data-scope-canvas=""
    >
      {frame !== undefined && (
        <g data-frame={frame.id}>
          <title>{frame.label}</title>
          <rect
            className="fill-none stroke-muted"
            strokeWidth={1}
            strokeDasharray="6 4"
            x={frame.x}
            y={frame.y}
            width={frame.width}
            height={frame.height}
          />
          <text className="fill-muted" fontSize={FONT} x={frame.x + 8} y={frame.y + 16}>
            {frame.label}
          </text>
        </g>
      )}
      <g data-edges="">{layout.edges.map(edgeInk)}</g>
      <g data-boxes="">
        {layout.boxes.map((box) => boxInk(box, { onOpen, onSelect, selected }))}
      </g>
    </svg>
  );
}

/** Every edge is its own group, so the stylesheet can colour one without a class per kind. */
function edgeInk(edge: LayoutEdge) {
  const line = drawnPath(edge);
  const head = headPath(edge);
  const members = membersText(edge);
  return (
    <g key={`${edge.relation}:${edge.from}->${edge.to}`} data-edge={`${edge.relation}:${edge.from}->${edge.to}`} data-kind={edge.kind}>
      {members !== '' && <title>{members}</title>}
      {line !== '' && (
        <path
          className="fill-none stroke-muted"
          strokeWidth={1.5}
          // A stub leaves the frame: dashed says the rest is one click away, not lost.
          strokeDasharray={edge.kind === 'cross' ? '4 4' : undefined}
          d={line}
        />
      )}
      {head !== '' && <path className="fill-muted stroke-none" d={head} />}
      <text
        className="fill-muted stroke-surface"
        // The halo is painted under the fill (`paintOrder`), so the line does not
        // run through its own label.
        strokeWidth={3}
        paintOrder="stroke"
        fontSize={FONT}
        textAnchor="middle"
        dominantBaseline="middle"
        x={edge.label.x}
        y={edge.label.y}
      >
        {edgeText(edge)}
      </text>
    </g>
  );
}

interface Marks {
  readonly onOpen?: (id: Id) => void;
  readonly onSelect?: (id: Id) => void;
  readonly selected?: Id;
}

/**
 * A box, and the one thing it can do.
 *
 * A box that has something inside opens; a box that does not is marked. Neither
 * without the host's callback, and then it is not a button either -- an element
 * that can be focused but does nothing is worse than a plain rectangle.
 */
function boxInk(box: LayoutBox, { onOpen, onSelect, selected }: Marks) {
  const opens = box.children.length > 0 && onOpen !== undefined;
  const live = opens || onSelect !== undefined;
  const marked = box.id === selected;
  const activate = (): void => {
    if (opens) onOpen?.(box.id);
    else onSelect?.(box.id);
  };
  // Enter and Space, because that is what a button does; nothing else, so the
  // arrow keys stay free for panning the picture later.
  const onKey = (event: KeyboardEvent<SVGGElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    activate();
  };
  const right = box.x + box.width;
  const middle = box.y + box.height / 2;
  return (
    <g
      key={box.id}
      data-box={box.id}
      data-children={box.children.length}
      data-marked={marked ? '' : undefined}
      className={live ? 'group cursor-pointer' : 'group'}
      role={live ? 'button' : undefined}
      tabIndex={live ? 0 : undefined}
      aria-label={live ? box.label : undefined}
      onClick={live ? activate : undefined}
      onKeyDown={live ? onKey : undefined}
    >
      <title>{box.label}</title>
      <rect
        className={cx(
          'stroke-ink',
          marked ? 'fill-paper' : 'fill-surface',
          live && 'group-hover:fill-paper group-focus-visible:stroke-pop-blue',
        )}
        strokeWidth={marked ? 2.5 : 1.5}
        x={box.x}
        y={box.y}
        width={box.width}
        height={box.height}
      />
      <text className="fill-ink" fontSize={FONT} textAnchor="middle" dominantBaseline="middle" x={box.x + box.width / 2} y={middle}>
        {fitLabel(box.label, box.width)}
      </text>
      {/* Something to open: a chevron on the right edge, drawn, not a glyph. */}
      {box.children.length > 0 && (
        <path
          className="fill-none stroke-muted"
          strokeWidth={1.5}
          d={`M ${right - 14} ${middle - 4} l 4 4 l -4 4`}
        />
      )}
    </g>
  );
}

function cx(...parts: readonly (string | false | undefined)[]): string {
  return parts.filter((part) => typeof part === 'string' && part !== '').join(' ');
}
