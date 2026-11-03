import { describe, expect, it } from 'vitest';
import { buildOntology, validateGraph, type Graph } from '../engine';
import {
  ARCHITECTURE,
  CONTAINS,
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
import { expandMachine, type MachineView } from './expand';
import { readPaths, type PathsView, type Possibility } from './paths';

/**
 * States inside states.
 *
 * A machine is in one state at a time, and a container is not one of them: the
 * container is a level of the statechart, and the states at the bottom of it are what
 * the machine is actually in. Everything here follows from that one sentence --
 * which transitions exist, which states get a row, and which `entry` and `exit`
 * pieces a crossing runs.
 *
 * The fixture is a drive that can be running or stopped, where running has two ways
 * of running and a way out that has to leave the outputs in a known place. That is
 * the case the hierarchy is for: stopping clears `drive` and `dir` once, on the
 * container, instead of in every state inside it.
 */

const { ontology } = buildOntology(ARCHITECTURE);

const hierarchy: Graph = {
  nodes: [
    { id: 'machine', type: MACHINE, attributes: { [OUTPUTS]: 'armed, drive, dir, speed' } },
    {
      id: 'running',
      type: STATE,
      attributes: { [ENTRY]: 'armed = true', [EXIT]: 'drive = 0; dir = 0' },
    },
    { id: 'spinning', type: STATE, attributes: { [ENTRY]: 'speed = 1' } },
    { id: 'braking', type: STATE, attributes: { [ENTRY]: 'speed = 2' } },
    { id: 'stopped', type: STATE, attributes: { [ENTRY]: 'drive = 0' } },
  ],
  edges: [
    { id: 'm-owns-running', relation: OWNS, source: 'machine', target: 'running' },
    { id: 'm-owns-spinning', relation: OWNS, source: 'machine', target: 'spinning' },
    { id: 'm-owns-braking', relation: OWNS, source: 'machine', target: 'braking' },
    { id: 'm-owns-stopped', relation: OWNS, source: 'machine', target: 'stopped' },
    { id: 'running-contains-spinning', relation: CONTAINS, source: 'running', target: 'spinning' },
    { id: 'running-contains-braking', relation: CONTAINS, source: 'running', target: 'braking' },
    { id: 'm-starts', relation: STARTS_AT, source: 'machine', target: 'running' },
    { id: 'running-starts', relation: STARTS_AT, source: 'running', target: 'spinning' },
    {
      id: 'estop',
      relation: MOVES_TO,
      source: 'running',
      target: 'stopped',
      attributes: { [TRIGGER]: 'estop', [SETS]: 'drive = 0; dir = 0' },
    },
    {
      id: 'go',
      relation: MOVES_TO,
      source: 'stopped',
      target: 'running',
      attributes: { [TRIGGER]: 'go' },
    },
    {
      id: 'slow',
      relation: MOVES_TO,
      source: 'spinning',
      target: 'braking',
      attributes: { [TRIGGER]: 'slow' },
    },
  ],
};

/** The same machine, one edge added or removed without touching the fixture above. */
function withEdges(added: Graph['edges'], removed: string[] = []): Graph {
  return {
    nodes: hierarchy.nodes,
    edges: [...hierarchy.edges.filter((edge) => !removed.includes(edge.id)), ...added],
  };
}

/** The same machine with one state's `exit` written differently. */
function withExit(stateId: string, written: string): Graph {
  return {
    nodes: hierarchy.nodes.map((node) =>
      node.id === stateId ? { ...node, attributes: { ...node.attributes, [EXIT]: written } } : node,
    ),
    edges: hierarchy.edges,
  };
}

/** The same machine with one edge asserting what holds after crossing it. */
function asserting(graph: Graph, edgeId: string, sets: string): Graph {
  return {
    nodes: graph.nodes,
    edges: graph.edges.map((edge) =>
      edge.id === edgeId ? { ...edge, attributes: { ...edge.attributes, [SETS]: sets } } : edge,
    ),
  };
}

/** What one machine's paths say, through the expansion a view would use. */
function pathsOf(graph: Graph, machine = 'machine'): PathsView {
  return readPaths(expandMachine(graph, machine));
}

/** The codes an expansion or a reading reports, with the subject each one names. */
function issuesOf(graph: Graph): string[] {
  return expandMachine(graph, 'machine').issues.map(
    (issue) => `${issue.code}@${issue.subject ?? ''}`,
  );
}

/** The values one output may hold in one state; empty when the state is unreachable. */
function holdsOf(view: PathsView, state: string, output: string): readonly Possibility[] {
  return (
    view.holds.find((held) => held.state === state && held.output === output)?.possibilities ?? []
  );
}

/** The same, written as `value via transition`, with the initial state marked `start`. */
function witnessed(view: PathsView, state: string, output: string): string[] {
  return holdsOf(view, state, output)
    .map(
      (held) =>
        `${held.value === undefined ? 'nothing' : String(held.value)} via ${held.via ?? 'start'}`,
    )
    .sort();
}

/** The states that have a row at all, in the order the reading found them. */
function statesRead(view: PathsView): string[] {
  return [...new Set(view.holds.map((held) => held.state))];
}

/** One transition as `from -> to`. */
function crossingsOf(view: MachineView, id: string): string[] {
  return view.transitions
    .filter((transition) => transition.id === id)
    .map((transition) => `${transition.from} -> ${transition.to}`);
}

describe('expanding a machine whose states sit inside another', () => {
  it('accepts the fixture as written', () => {
    expect(validateGraph(ontology, hierarchy)).toEqual([]);
  });

  it('reads the tree into parents, children and ancestors', () => {
    const view = expandMachine(hierarchy, 'machine');
    expect(view.issues).toEqual([]);
    const running = view.states.find((state) => state.id === 'running');
    expect(running?.parent).toBeUndefined();
    expect(running?.children).toEqual(['spinning', 'braking']);
    const spinning = view.states.find((state) => state.id === 'spinning');
    expect(spinning?.parent).toBe('running');
    expect(spinning?.children).toEqual([]);
    expect(spinning?.ancestors).toEqual(['running']);
    // A contained state is still owned by the machine: `contains` says where it sits.
    expect(spinning?.declaredBy).toBe('machine');
  });

  it('starts the machine in the state its container starts in', () => {
    expect(expandMachine(hierarchy, 'machine').initial).toBe('spinning');
  });

  it('turns a transition written on a container into one crossing from each state inside it', () => {
    const view = expandMachine(hierarchy, 'machine');
    expect(crossingsOf(view, 'estop')).toEqual(['spinning -> stopped', 'braking -> stopped']);
    const copies = view.transitions.filter((transition) => transition.id === 'estop');
    // One edge was written, so the id stays the edge's; the crossings are named apart
    // by the state the edge was declared on.
    expect(copies.map((transition) => transition.declaredFrom)).toEqual(['running', 'running']);
    expect(copies.map((transition) => transition.declaredTo)).toEqual([undefined, undefined]);
    expect(copies.map((transition) => transition.retargeted)).toEqual([false, false]);
  });

  it('enters a container by entering the state it starts in', () => {
    const view = expandMachine(hierarchy, 'machine');
    expect(crossingsOf(view, 'go')).toEqual(['stopped -> spinning']);
    const go = view.transitions.find((transition) => transition.id === 'go');
    expect(go?.declaredTo).toBe('running');
  });

  it('does not report one event as a mistake because a container spread it over two states', () => {
    // The two copies leave different states, so `duplicate-trigger` would be wrong.
    expect(issuesOf(hierarchy)).toEqual([]);
  });

  it('says so when a container is entered and does not say where it starts', () => {
    const graphed = withEdges([], ['running-starts']);
    expect(issuesOf(graphed)).toContain('no-entry@running');
    // The state entered is undecided, so the transition into the container is dropped
    // rather than pointed at a guess.
    expect(crossingsOf(expandMachine(graphed, 'machine'), 'go')).toEqual([]);
  });

  it('cuts a tree of states that closes on itself', () => {
    const looped: Graph = {
      nodes: [
        { id: 'machine', type: MACHINE },
        { id: 'a', type: STATE },
        { id: 'b', type: STATE },
      ],
      edges: [
        { id: 'm-owns-a', relation: OWNS, source: 'machine', target: 'a' },
        { id: 'm-owns-b', relation: OWNS, source: 'machine', target: 'b' },
        { id: 'a-contains-b', relation: CONTAINS, source: 'a', target: 'b' },
        { id: 'b-contains-a', relation: CONTAINS, source: 'b', target: 'a' },
        { id: 'm-starts', relation: STARTS_AT, source: 'machine', target: 'a' },
      ],
    };
    // The registry refuses the cycle, and the expansion is walked anyway: a reading
    // says what it found instead of stopping, which is what makes it usable on a model
    // that is still being written.
    expect(validateGraph(ontology, looped).map((issue) => issue.code)).toEqual(['cycle']);
    expect(issuesOf(looped)).toContain('contains-cycle@a');
  });
});

describe('reading a path through states inside states', () => {
  it('reads the fixture without complaint', () => {
    const view = pathsOf(hierarchy);
    expect(view.issues).toEqual([]);
  });

  it('gives a container no row, because the machine is never in one', () => {
    expect(statesRead(pathsOf(hierarchy))).toEqual(['spinning', 'braking', 'stopped']);
  });

  it('writes what the states around the initial state write, outermost first', () => {
    // `running` arms the drive, `spinning` sets the speed: both are written on the way
    // in, and nothing crossed into the machine to do it.
    const view = pathsOf(hierarchy);
    expect(witnessed(view, 'spinning', 'armed')).toEqual(['true via start']);
    expect(witnessed(view, 'spinning', 'speed')).toEqual(['1 via start']);
  });

  it('writes the exit of the container a crossing leaves', () => {
    // Neither the edge nor `stopped` writes `dir`: the value comes from `running`, and
    // writing it once on the container covers every state inside it.
    const view = pathsOf(hierarchy);
    expect(witnessed(view, 'stopped', 'dir')).toEqual(['0 via estop']);
    expect(witnessed(view, 'stopped', 'drive')).toEqual(['0 via estop']);
  });

  it('leaves and enters nothing but the states themselves between siblings', () => {
    const view = pathsOf(hierarchy);
    expect(witnessed(view, 'braking', 'speed')).toEqual(['2 via slow']);
    // `armed` was written by the container on the way in and is neither rewritten nor
    // reset by a crossing inside it, so it travels along.
    expect(witnessed(view, 'braking', 'armed')).toEqual(['true via slow']);
    // Two paths arrive, so `drive` has two possible values: nothing wrote it on the way in
    // from the machine, and `stopped` wrote 0 on the way in from the road. Nothing between
    // the machine and `braking` overwrites or clears it, so the value travels through the
    // container untouched -- a crossing inside a container changes the state, not the
    // outputs. The value no write carries is named after the start, because there is no
    // crossing to point at.
    expect(witnessed(view, 'braking', 'drive')).toEqual(['0 via slow', 'nothing via start']);
  });

  it('holds an assertion the crossing decides, on every crossing the edge stands for', () => {
    // `sets` is written once on the container and checked against both crossings.
    const view = pathsOf(hierarchy);
    expect(view.issues).toEqual([]);
    expect(holdsOf(view, 'stopped', 'dir')).toEqual([{ value: 0, via: 'estop' }]);
  });

  it('names the crossing in a message when the transition was written on a container', () => {
    const view = pathsOf(asserting(hierarchy, 'estop', 'dir = 1'));
    const contradicted = view.issues.filter((issue) => issue.code === 'sets-contradicted');
    expect(contradicted.map((issue) => issue.severity)).toEqual(['error', 'error']);
    // Without the state it crossed from, a reader would look for a state `running` that
    // has no transition of its own in the expansion.
    expect(contradicted.map((issue) => issue.message)).toEqual([
      '"estop" from "spinning" says it sets "dir" to 1, but crossing it leaves 0.',
      '"estop" from "braking" says it sets "dir" to 1, but crossing it leaves 0.',
    ]);
  });

  it('reports what a container forgets to clear, instead of letting it pass', () => {
    // The point of writing `dir = 0` on `running` rather than in each state: leave it
    // out, and the assertion that the drive direction is cleared stops being provable.
    const view = pathsOf(asserting(withExit('running', 'drive = 0'), 'estop', 'dir = 0'));
    const undecided = view.issues.filter((issue) => issue.code === 'sets-undecided');
    expect(undecided).toHaveLength(2);
    expect(undecided[0]?.message).toContain('may hold nothing at all');
    expect(view.issues.map((issue) => issue.code)).not.toContain('sets-contradicted');
  });
});
