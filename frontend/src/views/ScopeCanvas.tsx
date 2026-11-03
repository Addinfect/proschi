import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';
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
 * The window onto the picture is the `viewBox`, and the wheel, a drag and a double
 * click are all it takes to move it: zoom about the pointer, pan with the button,
 * back to the whole picture on a double click. Nothing below this line knows about
 * any of that, because a camera only shows a part of the same drawing -- it never
 * changes which drawing it is, and it never moves a box.
 *
 * The window has a shape of its own (`shape`), and that is what makes it a window:
 * a `<svg>` that took the proportions of whatever level it held would grow and
 * shrink with every level and move the page under the reader. The picture moves
 * inside it instead.
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
  /**
   * The window's shape: its width over its height. Absent, 16:10.
   *
   * Pass the picture's own proportions (`layout.width / layout.height`) to get a
   * shrink-wrap instead -- what a level of one row wants, and what nothing with a
   * rank structure does.
   */
  readonly shape?: number;
  readonly className?: string;
}

/** The drawn font size. `layoutScope`'s `charWidth` assumes the same, roughly. */
const FONT = 11;

/** How far a pressed pointer may wander and still be a click on a box. */
const DRAG_SLOP = 2;

/** The closest the camera comes: eight times the fit. Past that, a label is not text any more. */
const MAX_ZOOM = 8;

/** Wheel pixels to e-folds: one notch of a mouse wheel is about a fifth closer. */
const ZOOM_RATE = 0.0015;

/**
 * The window's shape -- width over height -- when the host names none.
 *
 * Fixed, and deliberately not the picture's. A slice of ink is easier to read in a
 * window with room than in a shrink-wrap of the ink, and the room is the point of
 * being able to zoom at all.
 */
const SHAPE = 16 / 10;

/**
 * Where the window onto the picture sits: its left and top edge, and how much of
 * the picture's width it shows.
 *
 * The height is derived from the window's shape, never stored. `viewBox` and window
 * then have the same proportions, so no box is ever stretched -- and the `<svg>`
 * keeps its size on the page while the picture moves inside it.
 */
interface Camera {
  readonly x: number;
  readonly y: number;
  readonly w: number;
}

/** A press that may become a pan: what it started on, and where the camera was. */
interface Drag {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly view: Camera;
  moved: boolean;
}

export default function ScopeCanvas({
  layout,
  onOpen,
  onSelect,
  selected,
  label,
  shape,
  className,
}: ScopeCanvasProps) {
  const aspect = shape ?? SHAPE;
  const frame = layout.frame;
  const svg = useRef<SVGSVGElement | null>(null);
  const [view, setView] = useState<Camera>(() => fit(layout, aspect));
  const [seen, setSeen] = useState<ScopeLayout>(layout);
  // Another level is another picture, and a window onto the old one means nothing
  // on it: back to fit. Adjusting state while rendering is deliberate -- the
  // alternative is a frame drawn through a camera that belongs to a picture that is
  // no longer there.
  if (seen !== layout) {
    setSeen(layout);
    setView(fit(layout, aspect));
  }
  const height = view.w / aspect;
  const zoomed = view.w < whole(layout, aspect);
  const drag = useRef<Drag | undefined>(undefined);
  const swallow = useRef(false);

  // Not `onWheel`: React registers wheel as passive, so the handler could not keep
  // the page from scrolling under the picture it was zooming.
  useEffect(() => {
    const element = svg.current;
    if (element === null) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      setView((current) => zoom(layout, aspect, current, event, box));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [layout, aspect]);

  const onPointerDown = (event: PointerEvent<SVGSVGElement>): void => {
    // Only the first button pans, and only when something is out of sight: at fit
    // there is nothing past the edge to go and look at, so a press there stays the
    // click on a box that it was before.
    if (event.button > 0 || !zoomed) return;
    swallow.current = false;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, view, moved: false };
    // No capture yet. Capturing here would retarget the click that follows a press
    // onto this `<svg>`, and a box under the pointer would stop opening.
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>): void => {
    const start = drag.current;
    if (start === undefined || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!start.moved && Math.abs(dx) <= DRAG_SLOP && Math.abs(dy) <= DRAG_SLOP) return;
    start.moved = true;
    // Now it is a pan, so the picture keeps following the pointer even when it
    // leaves the element -- and the click that would have landed on a box is
    // swallowed below.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // No capture here: the drag then ends where the pointer leaves the picture.
    }
    const box = event.currentTarget.getBoundingClientRect();
    // Unmeasured -- a test, or a picture not laid out yet -- a pixel is a unit.
    const per = box.width > 0 ? start.view.w / box.width : 1;
    setView(clamp(layout, aspect, { w: start.view.w, x: start.view.x - dx * per, y: start.view.y - dy * per }));
  };

  const endDrag = (event: PointerEvent<SVGSVGElement>): void => {
    const start = drag.current;
    if (start === undefined || start.id !== event.pointerId) return;
    // Come to rest where it started: that was a click, not a pan, and the box under
    // it still gets it.
    swallow.current = start.moved;
    drag.current = undefined;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // It was never captured.
    }
  };

  const onCaptureClick = (event: MouseEvent<SVGSVGElement>): void => {
    if (!swallow.current) return;
    swallow.current = false;
    event.stopPropagation();
    event.preventDefault();
  };

  return (
    <svg
      ref={svg}
      className={cx(
        'block h-auto w-full font-mono select-none',
        // Something to grab only when there is something to move.
        zoomed && 'cursor-grab touch-none active:cursor-grabbing',
        className,
      )}
      viewBox={`${n(view.x)} ${n(view.y)} ${n(view.w)} ${n(height)}`}
      role={label === undefined ? undefined : 'group'}
      aria-label={label}
      data-scope-canvas=""
      data-zoomed={zoomed ? '' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClickCapture={onCaptureClick}
      // Back to the whole picture. The way out of a corner, and the only one.
      onDoubleClick={() => {
        if (zoomed) setView(fit(layout, aspect));
      }}
    >
      {frame !== undefined && (
        <g data-frame={frame.id}>
          <title>{frame.label}</title>
          {/* Solid and thin: the frame is a boundary, and nothing more. Dashes say
              one thing only -- the arrow goes on where this level cannot show. */}
          <rect
            className="fill-none stroke-muted"
            strokeWidth={1}
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

/**
 * How wide a window has to be to hold the whole picture at the given shape.
 *
 * Wider than the picture or taller than it, whichever it takes: the whole picture
 * fits, and the window may end up with margins on one axis. That is the fit, and it
 * is also the widest the camera ever gets -- there is nothing out there.
 */
function whole(layout: ScopeLayout, shape: number): number {
  return Math.max(layout.width, layout.height * shape);
}

/** The whole picture, centred in a window of the given shape: every level starts here. */
function fit(layout: ScopeLayout, shape: number): Camera {
  const w = whole(layout, shape);
  return { x: (layout.width - w) / 2, y: (layout.height - w / shape) / 2, w };
}

/**
 * The camera, put back inside the picture.
 *
 * Never wider than the fit, never closer than `MAX_ZOOM` times in, never past an
 * edge. Centring counts as inside: a window with room to spare may have margins,
 * but only equal ones. That is also why zooming out of a corner arrives at the whole
 * picture without anyone telling it to, and a drag stops where the ink stops.
 */
function clamp(layout: ScopeLayout, shape: number, camera: Camera): Camera {
  if (layout.width <= 0 || layout.height <= 0) return fit(layout, shape);
  const fitWidth = whole(layout, shape);
  const w = Math.min(Math.max(camera.w, fitWidth / MAX_ZOOM), fitWidth);
  const x = slide(camera.x, w, layout.width);
  const y = slide(camera.y, w / shape, layout.height);
  return w === camera.w && x === camera.x && y === camera.y ? camera : { x, y, w };
}

/** One axis of the clamp: centred when the window is the wider one, slid when it is not. */
function slide(at: number, size: number, of: number): number {
  return size >= of ? (of - size) / 2 : Math.min(Math.max(at, 0), of - size);
}

/**
 * One turn of the wheel, about the point under the pointer: that point stays where
 * it is, which is the only thing that makes zooming feel like it is not a jump.
 */
function zoom(layout: ScopeLayout, shape: number, camera: Camera, event: WheelEvent, box: DOMRect): Camera {
  // A wheel that counts lines rather than pixels (Firefox, some drivers).
  const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
  const h = camera.w / shape;
  if (delta === 0 || camera.w <= 0 || h <= 0) return camera;
  const w = camera.w / Math.exp(-delta * ZOOM_RATE);
  const ratio = w / camera.w;
  // The point under the pointer, in picture units -- or the middle of the window,
  // when the element has not been measured.
  const fx = box.width > 0 ? camera.x + ((event.clientX - box.left) / box.width) * camera.w : camera.x + camera.w / 2;
  const fy = box.height > 0 ? camera.y + ((event.clientY - box.top) / box.height) * h : camera.y + h / 2;
  return clamp(layout, shape, { w, x: fx - (fx - camera.x) * ratio, y: fy - (fy - camera.y) * ratio });
}

/** `viewBox` is text, and two decimals is well under a pixel at any zoom worth having. */
function n(value: number): number {
  return Math.round(value * 100) / 100;
}
