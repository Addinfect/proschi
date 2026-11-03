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

  it('leaves the canvas the size the layout asked for', () => {
    const { container } = render(<ScopeCanvas layout={layout} />);
    const svg = container.querySelector('[data-scope-canvas]');
    expect(svg?.getAttribute('viewBox')).toBe(`0 0 ${layout.width} ${layout.height}`);
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
