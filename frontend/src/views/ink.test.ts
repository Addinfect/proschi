import { describe, expect, it } from 'vitest';
import type { EdgeKind, LayoutEdge, Point } from './layout';
import { drawnPath, edgeText, fitLabel, headPath, membersText, pathData } from './ink';

/**
 * Where the ink goes.
 *
 * These are strings, because that is what a `<svg>` gets and what a reader of
 * this file can check by eye: no rendering, no snapshot of a DOM.
 */

function edge(path: Point[], kind: EdgeKind = 'forward', count = 1): LayoutEdge {
  return {
    relation: 'uses',
    from: 'a',
    to: 'b',
    kind,
    count,
    members: ['a'],
    crosses: false,
    path,
    label: path[0] ?? { x: 0, y: 0 },
  };
}

describe('path data', () => {
  it('is a move and a line for every point after the first', () => {
    expect(
      pathData([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 5 },
      ]),
    ).toBe('M 0 0 L 10 0 L 10 5');
  });

  it('is nothing at all for a point, a lone move still painting a cap', () => {
    expect(pathData([])).toBe('');
    expect(pathData([{ x: 3, y: 4 }])).toBe('');
  });
});

describe('an arrow', () => {
  it('stops its line where the head starts, so the stroke does not run out of the point', () => {
    // Down 50 pixels; the head takes the last 8.
    expect(drawnPath(edge([{ x: 100, y: 100 }, { x: 100, y: 150 }]))).toBe('M 100 100 L 100 142');
  });

  it('turns its head into the direction of the last leg', () => {
    // Heading down, so the base is 8 above the point and the sides at x +- 4.
    expect(headPath(edge([{ x: 100, y: 100 }, { x: 100, y: 150 }]))).toBe(
      'M 100 150 L 96 142 L 104 142 Z',
    );
    // Heading left into the box, so the sides sit above and below the base.
    expect(headPath(edge([{ x: 148, y: 36 }, { x: 128, y: 36 }], 'self'))).toBe(
      'M 128 36 L 136 32 L 136 40 Z',
    );
  });

  it('keeps a loop whole and only eats into its last leg', () => {
    const loop = edge(
      [
        { x: 128, y: 20 },
        { x: 148, y: 20 },
        { x: 148, y: 36 },
        { x: 128, y: 36 },
      ],
      'self',
    );
    expect(drawnPath(loop)).toBe('M 128 20 L 148 20 L 148 36 L 136 36');
  });

  it('leaves a leg shorter than the head where it is', () => {
    // 4 pixels of line: pulling back by 8 would put the base behind its corner.
    const stub = edge([{ x: 0, y: 0 }, { x: 4, y: 0 }], 'cross');
    expect(drawnPath(stub)).toBe('');
    expect(headPath(stub)).toBe('M 4 0 L 0 4 L 0 -4 Z');
  });

  it('has no head when there is no line to put one on', () => {
    expect(headPath(edge([{ x: 1, y: 2 }]))).toBe('');
    expect(headPath(edge([]))).toBe('');
  });
});

describe('an arrow label', () => {
  it('is the relation, and the count only when it stands for several edges', () => {
    expect(edgeText(edge([{ x: 0, y: 0 }, { x: 0, y: 10 }]))).toBe('uses');
    expect(edgeText(edge([{ x: 0, y: 0 }, { x: 0, y: 10 }], 'forward', 3))).toBe('uses \u00d73');
  });

  it('names the members of a lifted arrow, and nothing for a single one', () => {
    expect(membersText({ ...edge([{ x: 0, y: 0 }]), members: ['a', 'b'] })).toBe('a, b');
    expect(membersText(edge([{ x: 0, y: 0 }]))).toBe('');
  });
});

describe('a box label', () => {
  it('fits a box the layout sized for it, unchanged', () => {
    // 15 characters at 7 pixels plus the padding is 125: the box the layout gives
    // it, rounded up to an even width.
    expect(fitLabel('orders.web.edge', 126)).toBe('orders.web.edge');
  });

  it('is shortened with an ellipsis when the box is narrower than its text', () => {
    // Room for 14 characters, so 13 and the ellipsis; the missing 12 pixels are a box
    // that is one character too narrow.
    expect(fitLabel('orders.web.edge', 120)).toBe('orders.web.ed\u2026');
  });

  it('is absent from a box with no room for anything', () => {
    expect(fitLabel('orders', 24)).toBe('');
  });
});
