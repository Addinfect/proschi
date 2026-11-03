// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drawnPath, headPath } from './ink';
import { layoutScope } from './layout';
import ScopeCanvas from './ScopeCanvas';
import type { ScopeView } from './scope';

afterEach(cleanup);

// A level with three boxes, a lifted arrow and one end outside the scope.
const view: ScopeView = {
  root: 'orders',
  boxes: [
    { id: 'orders.web', children: ['orders.web.controller'] },
    { id: 'orders.store', children: [] },
    { id: 'orders.edge', children: [] },
  ],
  edges: [
    {
      relation: 'uses',
      from: 'orders.web',
      to: 'orders.store',
      count: 2,
      members: ['e1', 'e2'],
      crosses: false,
    },
    {
      relation: 'uses',
      from: 'orders.web',
      to: 'orders.edge',
      count: 1,
      members: ['e3'],
      crosses: false,
    },
    {
      relation: 'depends-on',
      from: 'elsewhere',
      to: 'orders.store',
      count: 1,
      members: ['e4'],
      crosses: true,
    },
  ],
  issues: [],
};

const layout = layoutScope(view);

// A level that is nothing like 16:10: four boxes, one below the other. The window's
// own shape has to show here, or it is not the window's shape at all.
const tall = layoutScope({
  boxes: [
    { id: 'chain.start', children: [] },
    { id: 'chain.next', children: [] },
    { id: 'chain.again', children: [] },
    { id: 'chain.last', children: [] },
  ],
  edges: [
    { relation: 'uses', from: 'chain.start', to: 'chain.next', count: 1, members: ['c1'], crosses: false },
    { relation: 'uses', from: 'chain.next', to: 'chain.again', count: 1, members: ['c2'], crosses: false },
    { relation: 'uses', from: 'chain.again', to: 'chain.last', count: 1, members: ['c3'], crosses: false },
  ],
  issues: [],
});

const canvas = (container: HTMLElement): Element => {
  const svg = container.querySelector('[data-scope-canvas]');
  if (svg === null) throw new Error('no canvas');
  return svg;
};

const shown = (container: HTMLElement): readonly number[] =>
  (canvas(container).getAttribute('viewBox') ?? '').split(' ').map(Number);

describe('ScopeCanvas', () => {
  it('draws one group per box and a frame around an opened node', () => {
    const { container } = render(<ScopeCanvas layout={layout} />);
    expect(container.querySelectorAll('[data-box]')).toHaveLength(3);
    expect(container.querySelectorAll('[data-frame]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-edge]')).toHaveLength(3);
  });

  // The canvas is not allowed to have an opinion about the picture: the ink it
  // writes is the ink `ink.ts` returned, or the two can drift apart silently.
  it('writes the path and the head that ink returns', () => {
    const { container } = render(<ScopeCanvas layout={layout} />);
    const first = layout.edges[0]!;
    const paths = container.querySelector('[data-edge]')?.querySelectorAll('path') ?? [];
    expect(paths[0]?.getAttribute('d')).toBe(drawnPath(first));
    expect(paths[1]?.getAttribute('d')).toBe(headPath(first));
  });

  it('labels an arrow with its relation, and counts only when something was lifted', () => {
    render(<ScopeCanvas layout={layout} />);
    expect(screen.getByText('uses ×2')).toBeTruthy();
    expect(screen.getByText('depends-on')).toBeTruthy();
  });

  // The window has a shape of its own, so a level that is taller than it is wide does
  // not resize the page under the reader. The picture is centred in it, and the room
  // left over is the same on both sides.
  it('gives the picture a window of its own, not a shrink-wrap', () => {
    const { container } = render(<ScopeCanvas layout={tall} />);
    const [x, y, w, h] = shown(container);
    expect(w / h).toBeCloseTo(1.6);
    expect(w).toBeGreaterThan(tall.width);
    expect(h).toBeCloseTo(tall.height);
    expect(2 * x + w).toBeCloseTo(tall.width);
    expect(2 * y + h).toBeCloseTo(tall.height);
  });

  it('lets the host name the shape of the window', () => {
    const ratio = tall.width / tall.height;
    const { container } = render(<ScopeCanvas layout={tall} shape={ratio} />);
    const [x, y, w, h] = shown(container);
    expect(w / h).toBeCloseTo(ratio);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(0);
    expect(w).toBeCloseTo(tall.width);
    expect(h).toBeCloseTo(tall.height);
  });

  it('opens a box that has something inside it, by click and by key', () => {
    const onOpen = vi.fn();
    render(<ScopeCanvas layout={layout} onOpen={onOpen} />);
    const box = screen.getByRole('button', { name: 'orders.web' });
    fireEvent.click(box);
    expect(onOpen).toHaveBeenCalledWith('orders.web');
    onOpen.mockClear();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('orders.web');
  });

  it('marks a box that has nothing to open instead of opening it', () => {
    const onOpen = vi.fn();
    const onSelect = vi.fn();
    render(<ScopeCanvas layout={layout} onOpen={onOpen} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: 'orders.store' }));
    expect(onOpen).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith('orders.store');
  });

  // Nothing to do means nothing to focus: a rectangle that takes a tab stop and
  // then ignores the keyboard is a lie told to a screen reader.
  it('is not interactive without callbacks', () => {
    render(<ScopeCanvas layout={layout} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('shortens a label that is wider than its box', () => {
    const wide = layoutScope({
      boxes: [{ id: 'orders.web.edge.cache.layer.very.long.name', children: [] }],
      edges: [],
      issues: [],
    });
    render(<ScopeCanvas layout={wide} />);
    expect(screen.getByText(/…$/)).toBeTruthy();
  });

  // The frame says "this is where the level ends" and nothing else, so it is
  // solid. Dashes are kept for the one thing they mean here: the arrow carries on
  // somewhere this level cannot show.
  it('keeps the frame solid and dashes only the crossing arrow', () => {
    const { container } = render(<ScopeCanvas layout={layout} />);
    expect(container.querySelector('[data-frame] rect')?.getAttribute('stroke-dasharray')).toBeNull();
    expect(container.querySelector('[data-kind="cross"] path')?.getAttribute('stroke-dasharray')).toBe('4 4');
    expect(container.querySelector('[data-kind="forward"] path')?.getAttribute('stroke-dasharray')).toBeNull();
  });

  it('lets a host mark a box without owning the drawing', () => {
    const { container } = render(<ScopeCanvas layout={layout} selected="orders.store" />);
    const marked = container.querySelectorAll('[data-marked]');
    expect(marked).toHaveLength(1);
    expect(marked[0]?.getAttribute('data-box')).toBe('orders.store');
  });
});

// The window onto the picture. Nothing here draws anything: a camera decides which
// part of the same layout is in the window, and how big.
//
// No box is ever measured in jsdom -- `getBoundingClientRect` is all zeros -- so a
// pointer pixel is one layout unit in these tests. That is the fallback the canvas
// itself takes when it has not been laid out yet.
describe('ScopeCanvas, moved', () => {
  const wheel = (container: HTMLElement, deltaY: number): void => {
    fireEvent.wheel(canvas(container), { deltaY });
  };

  const drag = (container: HTMLElement, from: readonly [number, number], to: readonly [number, number]): void => {
    const svg = canvas(container);
    fireEvent.pointerDown(svg, { pointerId: 1, button: 0, clientX: from[0], clientY: from[1] });
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: to[0], clientY: to[1] });
    fireEvent.pointerUp(svg, { pointerId: 1, clientX: to[0], clientY: to[1] });
  };

  it('starts on the whole picture', () => {
    const { container } = render(<ScopeCanvas layout={layout} />);
    const [x, y, w, h] = shown(container);
    expect(canvas(container).getAttribute('data-zoomed')).toBeNull();
    // Every edge of the picture is in the window, and none of them is in the middle.
    expect(w).toBeGreaterThanOrEqual(layout.width);
    expect(h).toBeGreaterThanOrEqual(layout.height);
    expect(2 * x + w).toBeCloseTo(layout.width);
    expect(2 * y + h).toBeCloseTo(layout.height);
  });

  it('closes the window on a wheel forward and keeps the proportions', () => {
    const { container } = render(<ScopeCanvas layout={layout} />);
    const before = shown(container);
    wheel(container, -120);
    const after = shown(container);
    expect(after[2]).toBeLessThan(before[2]);
    // Closing in must not stretch a single box: the window keeps its own shape.
    expect(after[2] / after[3]).toBeCloseTo(before[2] / before[3]);
    expect(canvas(container).getAttribute('data-zoomed')).toBe('');
  });

  it('opens the window again, and no further than the whole picture', () => {
    const { container } = render(<ScopeCanvas layout={layout} />);
    const whole = canvas(container).getAttribute('viewBox');
    wheel(container, -600);
    wheel(container, 5000);
    expect(canvas(container).getAttribute('viewBox')).toBe(whole);
    expect(canvas(container).getAttribute('data-zoomed')).toBeNull();
  });

  it('follows the pointer when a drag moves a window that was zoomed', () => {
    const { container } = render(<ScopeCanvas layout={layout} />);
    wheel(container, -600);
    const before = shown(container);
    drag(container, [200, 200], [150, 200]);
    const after = shown(container);
    // Left is towards the right of the picture: the picture follows the hand.
    expect(after[0]).toBeCloseTo(before[0] + 50);
    expect(after[2]).toBeCloseTo(before[2]);
  });

  it('stops the window at the edge of the picture', () => {
    const { container } = render(<ScopeCanvas layout={layout} />);
    wheel(container, -1600);
    drag(container, [300, 300], [0, 300]);
    const after = shown(container);
    expect(after[0] + after[2]).toBeCloseTo(layout.width);
  });

  // At fit there is nothing past the edge to go and look at, so a press is a click
  // on the box under it and nothing else.
  it('does not move a picture that is already whole', () => {
    const { container } = render(<ScopeCanvas layout={layout} />);
    const whole = canvas(container).getAttribute('viewBox');
    drag(container, [200, 200], [40, 40]);
    expect(canvas(container).getAttribute('viewBox')).toBe(whole);
  });

  it('does not take a pan for a click on the box it started on', () => {
    const onOpen = vi.fn();
    const { container } = render(<ScopeCanvas layout={layout} onOpen={onOpen} />);
    wheel(container, -600);
    const box = screen.getByRole('button', { name: 'orders.web' });
    fireEvent.pointerDown(box, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(canvas(container), { pointerId: 1, clientX: 60, clientY: 100 });
    fireEvent.pointerUp(canvas(container), { pointerId: 1, clientX: 60, clientY: 100 });
    fireEvent.click(box);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('still opens a box on a press that did not move', () => {
    const onOpen = vi.fn();
    const { container } = render(<ScopeCanvas layout={layout} onOpen={onOpen} />);
    wheel(container, -600);
    const box = screen.getByRole('button', { name: 'orders.web' });
    fireEvent.pointerDown(box, { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(box, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.click(box);
    expect(onOpen).toHaveBeenCalledWith('orders.web');
  });

  it('goes back to the whole picture on a double click', () => {
    const { container } = render(<ScopeCanvas layout={layout} />);
    const whole = canvas(container).getAttribute('viewBox');
    wheel(container, -600);
    expect(canvas(container).getAttribute('viewBox')).not.toBe(whole);
    fireEvent.doubleClick(canvas(container));
    expect(canvas(container).getAttribute('viewBox')).toBe(whole);
  });
});
