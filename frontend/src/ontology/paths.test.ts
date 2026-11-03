import { describe, expect, it } from 'vitest';
import { buildOntology, validateGraph, type Graph } from '../engine';
import {
  ARCHITECTURE,
  ENTRY,
  EXIT,
  MACHINE,
  MOVES_TO,
  OUTPUTS,
  OWNS,
  SETS,
  STARTS_AT,
  STATE,
  TRIGGER,
} from './architecture';
import { expandMachine } from './expand';
import { readPaths, type PathsView, type Possibility } from './paths';

/**
 * What a machine's outputs hold, read along its paths.
 *
 * The fixtures are deliberately small and hand-written: a motor that can be told to
 * drive or not, a pair of states that differ only in what their `exit` says, and the
 * degenerate cases. If a fixture here needed a generator to be readable, the reading
 * would be too complicated to check by eye, which is the whole point of writing it
 * down this way.
 */

const { ontology } = buildOntology(ARCHITECTURE);

/** A motor with one output, told to drive by one state and to stop by another. */
const motor: Graph = {
  nodes: [
    { id: 'motor', type: MACHINE, attributes: { [OUTPUTS]: 'drive' } },
    { id: 'wait', type: STATE },
    { id: 'on', type: STATE, attributes: { [ENTRY]: 'drive = 1' } },
    { id: 'off', type: STATE, attributes: { [ENTRY]: 'drive = 0' } },
  ],
  edges: [
    { id: 'motor-owns-wait', relation: OWNS, source: 'motor', target: 'wait' },
    { id: 'motor-owns-on', relation: OWNS, source: 'motor', target: 'on' },
    { id: 'motor-owns-off', relation: OWNS, source: 'motor', target: 'off' },
    { id: 'motor-starts', relation: STARTS_AT, source: 'motor', target: 'wait' },
    {
      id: 'wait-on',
      relation: MOVES_TO,
      source: 'wait',
      target: 'on',
      attributes: { [TRIGGER]: 'press' },
    },
    {
      id: 'on-wait',
      relation: MOVES_TO,
      source: 'on',
      target: 'wait',
      attributes: { [TRIGGER]: 'release' },
    },
    {
      id: 'wait-off',
      relation: MOVES_TO,
      source: 'wait',
      target: 'off',
      attributes: { [TRIGGER]: 'halt' },
    },
    {
      id: 'off-wait',
      relation: MOVES_TO,
      source: 'off',
      target: 'wait',
      attributes: { [TRIGGER]: 'clear' },
    },
  ],
};

/**
 * Two states that write nothing and one that does, so that an `exit` is the only
 * thing that can decide what the second state sees. `island` has no way in at all.
 */
const exits: Graph = {
  nodes: [
    { id: 'm', type: MACHINE, attributes: { [OUTPUTS]: 'drive, dir' } },
    { id: 'a', type: STATE, attributes: { [ENTRY]: 'drive = 1', [EXIT]: 'dir = 7' } },
    { id: 'b', type: STATE },
    { id: 'c', type: STATE, attributes: { [ENTRY]: 'dir = 0' } },
    { id: 'island', type: STATE },
  ],
  edges: [
    { id: 'm-owns-a', relation: OWNS, source: 'm', target: 'a' },
    { id: 'm-owns-b', relation: OWNS, source: 'm', target: 'b' },
    { id: 'm-owns-c', relation: OWNS, source: 'm', target: 'c' },
    { id: 'm-owns-island', relation: OWNS, source: 'm', target: 'island' },
    { id: 'm-starts', relation: STARTS_AT, source: 'm', target: 'a' },
    {
      id: 'a-b',
      relation: MOVES_TO,
      source: 'a',
      target: 'b',
      attributes: { [TRIGGER]: 'go' },
    },
    {
      id: 'a-c',
      relation: MOVES_TO,
      source: 'a',
      target: 'c',
      attributes: { [TRIGGER]: 'turn' },
    },
    {
      id: 'island-a',
      relation: MOVES_TO,
      source: 'island',
      target: 'a',
      attributes: { [TRIGGER]: 'unlock' },
    },
  ],
};

/** The motor, plus a state that only waits: the path into it decides everything. */
const carrying: Graph = {
  nodes: [...motor.nodes, { id: 'hold', type: STATE }],
  edges: [
    ...motor.edges,
    { id: 'motor-owns-hold', relation: OWNS, source: 'motor', target: 'hold' },
    {
      id: 'wait-hold',
      relation: MOVES_TO,
      source: 'wait',
      target: 'hold',
      attributes: { [TRIGGER]: 'keep' },
    },
  ],
};

/** A machine whose outputs no state writes: only an assertion talks about them. */
const silent: Graph = {
  nodes: [
    { id: 'm', type: MACHINE, attributes: { [OUTPUTS]: 'drive, dir' } },
    { id: 'start', type: STATE },
    { id: 'next', type: STATE },
  ],
  edges: [
    { id: 'm-owns-start', relation: OWNS, source: 'm', target: 'start' },
    { id: 'm-owns-next', relation: OWNS, source: 'm', target: 'next' },
    { id: 'm-starts', relation: STARTS_AT, source: 'm', target: 'start' },
    {
      id: 'step',
      relation: MOVES_TO,
      source: 'start',
      target: 'next',
      attributes: { [SETS]: 'drive = 1' },
    },
  ],
};

/** What one machine's paths say, through the expansion a view would use. */
function pathsOf(graph: Graph, machine = 'motor'): PathsView {
  return readPaths(expandMachine(graph, machine));
}

/** The values one output may hold in one state; empty when the state is unreachable. */
function holdsOf(view: PathsView, state: string, output: string): readonly Possibility[] {
  return (
    view.holds.find((held) => held.state === state && held.output === output)?.possibilities ?? []
  );
}

/** Whether any path from the initial state arrives at a state. */
function reached(view: PathsView, state: string): boolean {
  return view.holds.find((held) => held.state === state)?.reachable ?? false;
}

/**
 * The same, written as `value via transition`, with the initial state marked `start`.
 * Sorted, so a test states what holds rather than the order the walk happened to find
 * it in.
 */
function witnessed(view: PathsView, state: string, output: string): string[] {
  return holdsOf(view, state, output)
    .map(
      (held) =>
        `${held.value === undefined ? 'nothing' : String(held.value)} via ${held.via ?? 'start'}`,
    )
    .sort();
}

/** The codes a view reports, for a short assertion. */
function codesOf(view: PathsView): string[] {
  return view.issues.map((issue) => issue.code);
}

/** The same graph with one edge asserting what holds after crossing it. */
function asserting(graph: Graph, edgeId: string, sets: string): Graph {
  return {
    nodes: graph.nodes,
    edges: graph.edges.map((edge) =>
      edge.id === edgeId ? { ...edge, attributes: { ...edge.attributes, [SETS]: sets } } : edge,
    ),
  };
}

describe('reading a path', () => {
  it('accepts the fixtures as written', () => {
    expect(validateGraph(ontology, motor)).toEqual([]);
    expect(validateGraph(ontology, exits)).toEqual([]);
    expect(validateGraph(ontology, carrying)).toEqual([]);
    expect(validateGraph(ontology, silent)).toEqual([]);
  });

  it('gives a state that writes an output exactly that constant', () => {
    const view = pathsOf(motor);
    expect(witnessed(view, 'on', 'drive')).toEqual(['1 via wait-on']);
    expect(witnessed(view, 'off', 'drive')).toEqual(['0 via wait-off']);
  });

  it('lets a state that writes nothing keep what the path gave it', () => {
    // `wait` writes nothing, so it holds whatever the state before it left: nothing
    // before the machine has done anything, 1 after driving, 0 after stopping.
    const view = pathsOf(motor);
    expect(witnessed(view, 'wait', 'drive')).toEqual([
      '0 via off-wait',
      '1 via on-wait',
      'nothing via start',
    ]);
  });

  it('says which transition brought each value, so the answer can be checked', () => {
    const view = pathsOf(motor);
    expect(holdsOf(view, 'wait', 'drive')[0]).toEqual({ value: undefined });
    expect(view.issues).toEqual([]);
  });

  it('reads one entry per state and output, in state order', () => {
    const view = pathsOf(motor);
    expect(view.holds.map((held) => `${held.state}/${held.output}`)).toEqual([
      'wait/drive',
      'on/drive',
      'off/drive',
    ]);
  });

  it('gives a state nothing for an output it does not write yet', () => {
    // `dir` is written on the way out of `a` and on the way into `c`; before that it
    // has no value at all, which is not the same as zero.
    const view = pathsOf(exits, 'm');
    expect(witnessed(view, 'a', 'dir')).toEqual(['nothing via start']);
  });

  it('lets an exit decide for a successor that writes nothing', () => {
    const view = pathsOf(exits, 'm');
    expect(witnessed(view, 'b', 'dir')).toEqual(['7 via a-b']);
    // and the value the predecessor held while it ran travels along untouched
    expect(witnessed(view, 'b', 'drive')).toEqual(['1 via a-b']);
  });

  it("lets a successor's entry win over the exit it crossed", () => {
    const view = pathsOf(exits, 'm');
    expect(witnessed(view, 'c', 'dir')).toEqual(['0 via a-c']);
  });

  it('reports a state no path arrives at, instead of inventing a value for it', () => {
    const view = pathsOf(exits, 'm');
    const unreached = view.holds.find((held) => held.state === 'island' && held.output === 'dir');
    const reached = view.holds.find((held) => held.state === 'a' && held.output === 'dir');
    expect(unreached?.possibilities).toEqual([]);
    expect(unreached?.reachable).toBe(false);
    expect(reached?.reachable).toBe(true);
  });

  it('says nothing about the values of a machine with no initial state', () => {
    // `wait` does write the output on entry, and still holds nothing here: with no
    // entry state there is no path, so the constant is one no state is ever in.
    const stray: Graph = {
      nodes: [
        { id: 'motor', type: MACHINE, attributes: { [OUTPUTS]: 'drive' } },
        { id: 'wait', type: STATE, attributes: { [ENTRY]: 'drive = 1' } },
      ],
      edges: [{ id: 'motor-owns-wait', relation: OWNS, source: 'motor', target: 'wait' }],
    };
    const view = pathsOf(stray);
    expect(holdsOf(view, 'wait', 'drive')).toEqual([]);
    expect(reached(view, 'wait')).toBe(false);
    expect(codesOf(view)).toEqual([]);
  });

  it('warns about an output no state writes', () => {
    const view = pathsOf(silent, 'm');
    const warnings = view.issues.filter((issue) => issue.code === 'output-never-set');
    expect(warnings.map((issue) => issue.severity)).toEqual(['warning', 'warning']);
    expect(warnings[0]?.message).toContain('"drive"');
    expect(warnings[1]?.message).toContain('"dir"');
  });
});

describe('checking what a transition asserts', () => {
  it('agrees with an assertion every path fulfils', () => {
    const view = pathsOf(asserting(motor, 'wait-on', 'drive = 1'));
    expect(codesOf(view)).toEqual([]);
  });

  it('reports an assertion the model contradicts', () => {
    const view = pathsOf(asserting(motor, 'wait-off', 'drive = 1'));
    expect(codesOf(view)).toEqual(['sets-contradicted']);
    expect(view.issues[0]?.severity).toBe('error');
    expect(view.issues[0]?.message).toContain('leaves 0');
  });

  it('reports an assertion that holds on some paths only, naming the others', () => {
    // `hold` writes nothing, so everything `wait` can hold arrives there: the
    // assertion is true after stopping and false after driving.
    const view = pathsOf(asserting(carrying, 'wait-hold', 'drive = 0'));
    expect(codesOf(view)).toEqual(['sets-undecided']);
    expect(view.issues[0]?.severity).toBe('warning');
    // The 1 was not made by this crossing, so the message names the transition it
    // came from instead of the edge the reader is already looking at.
    expect(view.issues[0]?.message).toContain('1 (via "release")');
    expect(view.issues[0]?.message).toContain('nothing');
  });

  it('reports an assertion about an output nothing has written yet', () => {
    const view = pathsOf(asserting(silent, 'step', 'drive = 1'), 'm');
    expect(codesOf(view)).toContain('sets-undecided');
    const message = view.issues.find((issue) => issue.code === 'sets-undecided')?.message ?? '';
    expect(message).toContain('may hold nothing at all');
  });

  it('never writes: an assertion leaves the successor holding what it held', () => {
    const view = pathsOf(asserting(silent, 'step', 'drive = 1'), 'm');
    expect(holdsOf(view, 'next', 'drive')).toEqual([{ value: undefined }]);
  });

  it('reports an assertion it cannot check because its source is unreachable', () => {
    const view = pathsOf(asserting(exits, 'island-a', 'drive = 0'), 'm');
    const undecided = view.issues.find((issue) => issue.code === 'sets-undecided');
    expect(undecided?.message).toContain('cannot reach "island"');
    expect(codesOf(view)).not.toContain('sets-contradicted');
  });
});
