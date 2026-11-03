import { describe, expect, it } from 'vitest';
import { buildOntology, validateGraph, type Graph } from '../engine';
import {
  ACTIVITY,
  ARCHITECTURE,
  COMPOSES,
  DEPENDS_ON,
  ENTRY,
  EXIT,
  OUTPUTS,
  INHERITS,
  MACHINE,
  MOVES_TO,
  OWNS,
  REALIZES,
  STARTS_AT,
  GUARD,
  STATE,
  TRIGGER,
  USES,
} from './architecture';
import { expandMachine, machinesIn } from './expand';

/**
 * Two fixtures, one per reading. The first is a sketch of this frontend's own
 * layers -- not a generated fact, just close enough that a mistake in the ontology
 * shows up as a mistake in something recognisable. The second is a statechart that
 * inherits another one, which is the case the expansion helper exists for.
 */

const { ontology, issues: ontologyIssues } = buildOntology(ARCHITECTURE);

const structure: Graph = {
  nodes: [
    {
      id: 'engine',
      type: 'module',
      name: 'engine',
      attributes: {
        layer: 'application',
        note: 'Typed graph, ontology registry and checks. Knows no subject matter.',
      },
    },
    { id: 'ontology', type: 'module', name: 'ontology', attributes: { layer: 'application' } },
    { id: 'dsl', type: 'module', name: 'dsl', attributes: { layer: 'application' } },
    {
      id: 'kinds',
      type: 'module',
      name: 'kinds',
      attributes: { layer: 'domain', note: 'The simulation kinds the parser infers.' },
    },
    { id: 'view', type: 'module', name: 'view', attributes: { layer: 'presentation' } },
    { id: 'graph-view', type: 'interface', name: 'graph view', attributes: { layer: 'presentation' } },
  ],
  edges: [
    { id: 'ontology-depends-engine', relation: DEPENDS_ON, source: 'ontology', target: 'engine' },
    { id: 'ontology-uses-engine', relation: USES, source: 'ontology', target: 'engine' },
    { id: 'dsl-depends-kinds', relation: DEPENDS_ON, source: 'dsl', target: 'kinds' },
    { id: 'view-depends-dsl', relation: DEPENDS_ON, source: 'view', target: 'dsl' },
    { id: 'dsl-composes-view', relation: COMPOSES, source: 'dsl', target: 'view' },
    { id: 'view-realizes-graph-view', relation: REALIZES, source: 'view', target: 'graph-view' },
  ],
};

const machines: Graph = {
  nodes: [
    { id: 'editor', type: MACHINE, attributes: { layer: 'presentation' } },
    { id: 'idle', type: STATE },
    { id: 'parsing', type: STATE },
    { id: 'rendering', type: STATE },
    { id: 'failing', type: STATE, attributes: { final: true } },
    { id: 'editor-with-undo', type: MACHINE, attributes: { layer: 'presentation' } },
    { id: 'undoing', type: STATE, attributes: { overrides: 'rendering' } },
    { id: 'silent', type: MACHINE },
  ],
  edges: [
    { id: 'editor-owns-idle', relation: OWNS, source: 'editor', target: 'idle' },
    { id: 'editor-owns-parsing', relation: OWNS, source: 'editor', target: 'parsing' },
    { id: 'editor-owns-rendering', relation: OWNS, source: 'editor', target: 'rendering' },
    { id: 'editor-owns-failing', relation: OWNS, source: 'editor', target: 'failing' },
    { id: 'editor-starts', relation: STARTS_AT, source: 'editor', target: 'idle' },
    {
      id: 'idle-to-parsing',
      relation: MOVES_TO,
      source: 'idle',
      target: 'parsing',
      attributes: { [TRIGGER]: 'input' },
    },
    { id: 'parsing-to-rendering', relation: MOVES_TO, source: 'parsing', target: 'rendering' },
    { id: 'rendering-to-idle', relation: MOVES_TO, source: 'rendering', target: 'idle' },
    { id: 'parsing-to-failing', relation: MOVES_TO, source: 'parsing', target: 'failing', label: 'error' },
    { id: 'undo-inherits-editor', relation: INHERITS, source: 'editor-with-undo', target: 'editor' },
    { id: 'undo-owns-undoing', relation: OWNS, source: 'editor-with-undo', target: 'undoing' },
  ],
};

/** The codes a graph produces, for a short assertion. */
function codesOf(graphed: Graph): string[] {
  return validateGraph(ontology, graphed).map((issue) => issue.code);
}

/** One added edge, without touching the fixtures above. */
function withEdge(graphed: Graph, edge: Graph['edges'][number]): Graph {
  return { nodes: graphed.nodes, edges: [...graphed.edges, edge] };
}

describe('the architecture ontology', () => {
  it('declares itself without complaint', () => {
    expect(ontologyIssues).toEqual([]);
  });

  it('orders the types by what they extend', () => {
    expect(ontology.order).toEqual(['element', 'module', 'interface', 'machine', 'state']);
    expect(ontology.roots).toEqual(['element', 'state']);
  });

  it('keeps the abstract element out of a model', () => {
    const graphed: Graph = {
      nodes: [{ id: 'loose', type: 'element' }],
      edges: [],
    };
    expect(codesOf(graphed)).toEqual(['abstract-type']);
  });

  it('lets a machine stand where an element is expected', () => {
    const graphed: Graph = {
      nodes: [
        { id: 'editor', type: MACHINE },
        { id: 'dsl', type: 'module' },
      ],
      edges: [{ id: 'e', relation: COMPOSES, source: 'dsl', target: 'editor' }],
    };
    expect(codesOf(graphed)).toEqual([]);
  });

  it('does not let a state depend on anything', () => {
    const graphed: Graph = {
      nodes: [
        { id: 'idle', type: STATE },
        { id: 'dsl', type: 'module' },
      ],
      edges: [{ id: 'e', relation: DEPENDS_ON, source: 'idle', target: 'dsl' }],
    };
    expect(codesOf(graphed)).toEqual(['relation-source']);
  });
});

describe('a sketch of this codebase', () => {
  it('validates clean', () => {
    expect(validateGraph(ontology, structure)).toEqual([]);
  });

  it('reports a dependency cycle, and only where it is one', () => {
    const cyclic = withEdge(structure, {
      id: 'kinds-depends-view',
      relation: DEPENDS_ON,
      source: 'kinds',
      target: 'view',
    });
    expect(codesOf(cyclic)).toEqual(['cycle']);
    // `cycles` sorts each group, so the subject is the alphabetically first node
    // of the cycle, not the node the edge was added to.
    expect(validateGraph(ontology, cyclic)[0]?.subject).toBe('dsl');
  });

  it('allows the same cycle along uses, where a flow may come back', () => {
    const flowing = withEdge(structure, {
      id: 'engine-uses-view',
      relation: USES,
      source: 'engine',
      target: 'view',
    });
    expect(codesOf(flowing)).toEqual([]);
  });

  it('gives an element one parent at most', () => {
    const graphed = withEdge(structure, {
      id: 'kinds-composes-view',
      relation: COMPOSES,
      source: 'kinds',
      target: 'view',
    });
    expect(codesOf(graphed)).toEqual(['too-many-in']);
  });
});

describe('expanding a machine', () => {
  it('finds every machine, in graph order', () => {
    expect(machinesIn(machines)).toEqual(['editor', 'editor-with-undo', 'silent']);
  });

  it('accepts a statechart that inherits and overrides', () => {
    expect(validateGraph(ontology, machines)).toEqual([]);
  });

  it('reads a machine as written', () => {
    const view = expandMachine(machines, 'editor');
    expect(view.issues).toEqual([]);
    expect(view.states.map((state) => state.id)).toEqual(['idle', 'parsing', 'rendering', 'failing']);
    expect(view.initial).toBe('idle');
    expect(view.transitions.map((transition) => `${transition.from} -> ${transition.to}`)).toEqual([
      'idle -> parsing',
      'parsing -> rendering',
      'rendering -> idle',
      'parsing -> failing',
    ]);
    expect(view.transitions[0]?.trigger).toBe('input');
    expect(view.states[3]?.final).toBe(true);
  });

  it('hands the inherited states down and keeps the order of the parent', () => {
    const view = expandMachine(machines, 'editor-with-undo');
    expect(view.issues).toEqual([]);
    expect(view.states.map((state) => state.id)).toEqual(['idle', 'parsing', 'undoing', 'failing']);
    expect(view.states[2]?.declaredBy).toBe('editor-with-undo');
    expect(view.states[2]?.overrides).toBe('rendering');
    expect(view.states[0]?.declaredBy).toBe('editor');
    expect(view.initial).toBe('idle');
  });

  it('moves inherited transitions onto the replacing state', () => {
    const view = expandMachine(machines, 'editor-with-undo');
    expect(view.transitions.map((transition) => `${transition.from} -> ${transition.to}`)).toEqual([
      'idle -> parsing',
      'parsing -> undoing',
      'undoing -> idle',
      'parsing -> failing',
    ]);
    expect(view.transitions.map((transition) => transition.retargeted)).toEqual([false, true, true, false]);
  });

  it('says so when a machine never says where it starts', () => {
    const view = expandMachine(machines, 'silent');
    expect(view.issues.map((issue) => issue.code)).toEqual(['no-initial']);
    expect(view.issues[0]?.severity).toBe('warning');
  });

  it('says so when an override names nothing it inherits', () => {
    const graphed = withEdge(machines, {
      id: 'undo-owns-stray',
      relation: OWNS,
      source: 'editor-with-undo',
      target: 'stray',
    });
    const withStray: Graph = {
      nodes: [...graphed.nodes, { id: 'stray', type: STATE, attributes: { overrides: 'nowhere' } }],
      edges: graphed.edges,
    };
    const view = expandMachine(withStray, 'editor-with-undo');
    expect(view.issues.map((issue) => issue.code)).toEqual(['unknown-override']);
    expect(view.states.map((state) => state.id)).toContain('stray');
  });

  it('cuts an inheritance chain that closes on itself', () => {
    const graphed: Graph = {
      nodes: [
        { id: 'a', type: MACHINE },
        { id: 'b', type: MACHINE },
      ],
      edges: [
        { id: 'a-inherits-b', relation: INHERITS, source: 'a', target: 'b' },
        { id: 'b-inherits-a', relation: INHERITS, source: 'b', target: 'a' },
      ],
    };
    expect(codesOf(graphed)).toEqual(['cycle']);
    expect(expandMachine(graphed, 'a').issues.map((issue) => issue.code)).toEqual([
      'inherits-cycle',
      'no-initial',
    ]);
  });

  it('says so when the machine is not there', () => {
    expect(expandMachine(machines, 'nowhere').issues.map((issue) => issue.code)).toEqual([
      'unknown-machine',
    ]);
  });
});

describe('transition triggers', () => {
  /** Two transitions leaving one state: one named by attribute, one by a label only. */
  const triggered: Graph = {
    nodes: [
      { id: 'machine', type: MACHINE, attributes: { layer: 'presentation' } },
      { id: 'a', type: STATE },
      { id: 'b', type: STATE },
      { id: 'c', type: STATE },
    ],
    edges: [
      { id: 'machine-owns-a', relation: OWNS, source: 'machine', target: 'a' },
      { id: 'machine-owns-b', relation: OWNS, source: 'machine', target: 'b' },
      { id: 'machine-owns-c', relation: OWNS, source: 'machine', target: 'c' },
      { id: 'machine-starts', relation: STARTS_AT, source: 'machine', target: 'a' },
      {
        id: 'a-to-b',
        relation: MOVES_TO,
        source: 'a',
        target: 'b',
        attributes: { [TRIGGER]: 'go', [GUARD]: 'ready' },
      },
      { id: 'a-to-c', relation: MOVES_TO, source: 'a', target: 'c', label: 'stop' },
    ],
  };

  it('reads a trigger and a guard from the edge attributes', () => {
    const view = expandMachine(triggered, 'machine');
    expect(view.issues).toEqual([]);
    const named = view.transitions.find((transition) => transition.id === 'a-to-b');
    expect(named?.trigger).toBe('go');
    expect(named?.guard).toBe('ready');
  });

  it('still reads a label where no trigger attribute is set', () => {
    const view = expandMachine(triggered, 'machine');
    expect(view.transitions.find((transition) => transition.id === 'a-to-c')?.trigger).toBe('stop');
  });

  it('accepts both attributes under the ontology', () => {
    expect(validateGraph(ontology, triggered)).toEqual([]);
  });
});

describe('what a trigger rules out', () => {
  /** A machine with three states: a test adds only the transitions it is about. */
  function machineWith(...transitions: Graph['edges']): Graph {
    return {
      nodes: [
        { id: 'machine', type: MACHINE, attributes: { layer: 'presentation' } },
        { id: 'a', type: STATE },
        { id: 'b', type: STATE },
        { id: 'c', type: STATE },
      ],
      edges: [
        { id: 'machine-owns-a', relation: OWNS, source: 'machine', target: 'a' },
        { id: 'machine-owns-b', relation: OWNS, source: 'machine', target: 'b' },
        { id: 'machine-owns-c', relation: OWNS, source: 'machine', target: 'c' },
        { id: 'machine-starts', relation: STARTS_AT, source: 'machine', target: 'a' },
        ...transitions,
      ],
    };
  }

  /** Every code an expansion reports, with the subject it names. */
  function issuesOf(graphed: Graph): string[] {
    return expandMachine(graphed, 'machine').issues.map(
      (issue) => `${issue.code}@${issue.subject ?? ''}`,
    );
  }

  it('reports one event leading out of a state twice', () => {
    const graphed = machineWith(
      { id: 'a-to-b', relation: MOVES_TO, source: 'a', target: 'b', attributes: { [TRIGGER]: 'go' } },
      { id: 'a-to-c', relation: MOVES_TO, source: 'a', target: 'c', attributes: { [TRIGGER]: 'go' } },
    );
    expect(issuesOf(graphed)).toEqual(['duplicate-trigger@a']);
    expect(expandMachine(graphed, 'machine').issues[0]?.message).toBe(
      '"a" leaves on "go" more than once (a-to-b, a-to-c), so which state it enters is undecided.',
    );
  });

  it('allows one event with two guards, because guards are names not expressions', () => {
    const graphed = machineWith(
      {
        id: 'a-to-b',
        relation: MOVES_TO,
        source: 'a',
        target: 'b',
        attributes: { [TRIGGER]: 'go', [GUARD]: 'ready' },
      },
      {
        id: 'a-to-c',
        relation: MOVES_TO,
        source: 'a',
        target: 'c',
        attributes: { [TRIGGER]: 'go', [GUARD]: 'busy' },
      },
    );
    expect(issuesOf(graphed)).toEqual([]);
  });

  it('reports the same event and the same guard twice as one mistake', () => {
    const graphed = machineWith(
      {
        id: 'a-to-b',
        relation: MOVES_TO,
        source: 'a',
        target: 'b',
        attributes: { [TRIGGER]: 'go', [GUARD]: 'ready' },
      },
      {
        id: 'a-to-c',
        relation: MOVES_TO,
        source: 'a',
        target: 'c',
        attributes: { [TRIGGER]: 'go', [GUARD]: 'ready' },
      },
    );
    expect(issuesOf(graphed)).toEqual(['duplicate-trigger@a']);
  });

  it('accepts one untriggered transition next to named events', () => {
    const graphed = machineWith(
      { id: 'a-to-b', relation: MOVES_TO, source: 'a', target: 'b', attributes: { [TRIGGER]: 'go' } },
      { id: 'a-to-c', relation: MOVES_TO, source: 'a', target: 'c' },
    );
    expect(issuesOf(graphed)).toEqual([]);
  });

  it('reports two transitions that both fire by themselves with different guards', () => {
    const graphed = machineWith(
      {
        id: 'a-to-b',
        relation: MOVES_TO,
        source: 'a',
        target: 'b',
        attributes: { [GUARD]: 'ready' },
      },
      {
        id: 'a-to-c',
        relation: MOVES_TO,
        source: 'a',
        target: 'c',
        attributes: { [GUARD]: 'busy' },
      },
    );
    expect(issuesOf(graphed)).toEqual(['many-defaults@a']);
  });

  it('reports two bare defaults once, not as two different mistakes', () => {
    const graphed = machineWith(
      { id: 'a-to-b', relation: MOVES_TO, source: 'a', target: 'b' },
      { id: 'a-to-c', relation: MOVES_TO, source: 'a', target: 'c' },
    );
    expect(issuesOf(graphed)).toEqual(['duplicate-trigger@a']);
  });
});

describe('what a state writes', () => {
  /** A machine declaring two outputs, with the states a test adds. `idle` must be one of them. */
  function withStates(states: Graph['nodes'], edges: Graph['edges'] = []): Graph {
    return {
      nodes: [{ id: 'machine', type: MACHINE, attributes: { [OUTPUTS]: 'armed, mode' } }, ...states],
      edges: [
        { id: 'machine-owns-idle', relation: OWNS, source: 'machine', target: 'idle' },
        { id: 'machine-starts', relation: STARTS_AT, source: 'machine', target: 'idle' },
        ...edges,
      ],
    };
  }

  /** Every code an expansion reports, with the subject it names. */
  function issuesOf(graphed: Graph): string[] {
    return expandMachine(graphed, 'machine').issues.map(
      (issue) => `${issue.code}@${issue.subject ?? ''}`,
    );
  }

  it('reads entry and exit into assignments and `do` into an activity', () => {
    const graphed = withStates([
      {
        id: 'idle',
        type: STATE,
        attributes: {
          [ENTRY]: 'armed = 1; mode = "auto"',
          [EXIT]: 'armed = 0',
          [ACTIVITY]: 'poll',
        },
      },
    ]);
    const view = expandMachine(graphed, 'machine');
    expect(view.issues).toEqual([]);
    expect(view.outputs).toEqual(['armed', 'mode']);
    const idle = view.states[0];
    expect(idle?.entry).toEqual([
      { output: 'armed', value: 1 },
      { output: 'mode', value: 'auto' },
    ]);
    expect(idle?.exit).toEqual([{ output: 'armed', value: 0 }]);
    expect(idle?.activity).toBe('poll');
  });

  it('refuses an output the machine does not declare', () => {
    const graphed = withStates([
      { id: 'idle', type: STATE, attributes: { [ENTRY]: 'armed = 1; aremd = 0' } },
    ]);
    expect(issuesOf(graphed)).toEqual(['unknown-output@idle']);
  });

  it('refuses a piece that is not an assignment, and a bare word as a value', () => {
    expect(
      issuesOf(withStates([{ id: 'idle', type: STATE, attributes: { [ENTRY]: 'armed 1' } }])),
    ).toEqual(['bad-effect@idle']);
    expect(
      issuesOf(withStates([{ id: 'idle', type: STATE, attributes: { [EXIT]: 'mode = auto' } }])),
    ).toEqual(['bad-effect@idle']);
  });

  it('reports an output a machine declares twice', () => {
    const graphed: Graph = {
      nodes: [
        { id: 'machine', type: MACHINE, attributes: { [OUTPUTS]: 'armed, armed' } },
        { id: 'idle', type: STATE },
      ],
      edges: [
        { id: 'machine-owns-idle', relation: OWNS, source: 'machine', target: 'idle' },
        { id: 'machine-starts', relation: STARTS_AT, source: 'machine', target: 'idle' },
      ],
    };
    expect(issuesOf(graphed)).toEqual(['duplicate-output@machine']);
  });

  it('lets a child machine add an output and an inherited state keep writing the parent one', () => {
    const graphed: Graph = {
      nodes: [
        { id: 'base', type: MACHINE, attributes: { [OUTPUTS]: 'armed' } },
        { id: 'child', type: MACHINE, attributes: { [OUTPUTS]: 'tripped' } },
        { id: 'idle', type: STATE },
        { id: 'running', type: STATE, attributes: { [ENTRY]: 'armed = 1; tripped = false' } },
      ],
      edges: [
        { id: 'base-owns-idle', relation: OWNS, source: 'base', target: 'idle' },
        { id: 'base-owns-running', relation: OWNS, source: 'base', target: 'running' },
        { id: 'base-starts', relation: STARTS_AT, source: 'base', target: 'idle' },
        { id: 'child-inherits', relation: INHERITS, source: 'child', target: 'base' },
      ],
    };
    const view = expandMachine(graphed, 'child');
    expect(view.issues).toEqual([]);
    expect(view.outputs).toEqual(['tripped', 'armed']);
    expect(view.states[1]?.entry).toEqual([
      { output: 'armed', value: 1 },
      { output: 'tripped', value: false },
    ]);
  });
});

