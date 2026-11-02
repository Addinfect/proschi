import type { OntologySpec } from '../engine';

/**
 * The architecture ontology: the vocabulary a structural view, a flow view and a
 * statechart all read from one graph.
 *
 * The engine knows nothing about architecture; this module supplies the words and
 * nothing else. A project that talks differently writes its own ontology beside
 * this one and keeps the same engine, the same checks and the same views.
 *
 * Three readings share the graph, which is why the types are cut this way:
 *
 * - Structure: `module` and `interface` nodes joined by `depends-on`, `uses`,
 *   `composes` and `realizes` -- boxes and arrows, in the usual sense.
 * - Flow: the same nodes followed along `uses`, read as a sequence of steps
 *   rather than as a dependency order.
 * - Behaviour: `machine` nodes own `state` nodes, `moves-to` edges are
 *   transitions, and a machine may `inherits` another to take over its behaviour
 *   and override parts of it (see expand.ts).
 *
 * `element` is the one abstract type: it exists so that `depends-on`, `uses` and
 * `composes` can name "any structural thing" once. A `state` is deliberately not
 * an element -- a state is not drawn in a structural view and may not depend on
 * anything -- so the type of a node decides which views show it.
 */

/** Where an element sits in the dependency direction: presentation leans on application, application on domain. */
export const LAYERS = ['presentation', 'application', 'domain', 'infrastructure'] as const;

/** Type name of a state machine, as expand.ts and the statechart view use it. */
export const MACHINE = 'machine';

/** Type name of one state of a machine. */
export const STATE = 'state';

/** Attribute a state carries to replace an inherited state: the id of the state it takes the place of. */
export const OVERRIDES = 'overrides';

/** The source needs the target to work; a cycle is a defect. */
export const DEPENDS_ON = 'depends-on';

/** The source calls or reads the target at run time; cycles are allowed here. */
export const USES = 'uses';

/** The target is part of the source: one parent, no cycles. */
export const COMPOSES = 'composes';

/** The module fulfils the contract. */
export const REALIZES = 'realizes';

/** The state belongs to the machine. */
export const OWNS = 'owns';

/** The state the machine is in before anything happens. */
export const STARTS_AT = 'starts-at';

/** A transition from one state to another; the edge's label is the trigger. */
export const MOVES_TO = 'moves-to';

/** The machine takes over the behaviour of another one. */
export const INHERITS = 'inherits';

/**
 * The ontology itself. Everything subject-matter-specific about architecture is
 * written here, once, as data -- no code, so that a reader can check it against
 * the design document it came from.
 */
export const ARCHITECTURE: OntologySpec = {
  types: [
    {
      name: 'element',
      instantiable: false,
      doc: 'Something a structural view draws. Absent from a model; only its subtypes appear.',
      attributes: {
        layer: {
          kind: 'string',
          values: LAYERS,
          doc: 'Where the element sits in the dependency direction.',
        },
        owner: { kind: 'string', doc: 'Who answers for it, as a name a reader can act on.' },
        note: { kind: 'string', doc: 'One sentence a view shows next to the element.' },
      },
    },
    {
      name: 'module',
      extends: ['element'],
      doc: 'A unit of code with a boundary: the thing a dependency points at.',
    },
    {
      name: 'interface',
      extends: ['element'],
      doc: 'A contract a module depends on without knowing which module fulfils it.',
    },
    {
      name: 'machine',
      extends: ['element'],
      doc: 'The states one module moves through. Drawn as a statechart, not as a box.',
    },
    {
      name: 'state',
      doc: 'One state a machine may be in. It has exactly one owning machine or it is not part of any statechart.',
      attributes: {
        final: { kind: 'boolean', doc: 'True when the machine may stop here.' },
        overrides: {
          kind: 'string',
          doc: 'Id of the inherited state this one replaces. Read by expand.ts, and only meaningful in a machine that inherits another.',
        },
      },
    },
  ],
  relations: [
    {
      name: DEPENDS_ON,
      source: ['element'],
      target: ['element'],
      acyclic: true,
      doc: 'The source needs the target to work. A cycle among these is a defect, and is reported as one.',
    },
    {
      name: USES,
      source: ['element'],
      target: ['element'],
      doc: 'The source calls or reads the target at run time. A cycle here is allowed: a flow may come back to where it started.',
    },
    {
      name: COMPOSES,
      source: ['element'],
      target: ['element'],
      maxIn: 1,
      acyclic: true,
      doc: 'The target is part of the source. One parent per element, and nothing contains itself.',
    },
    {
      name: REALIZES,
      source: ['module'],
      target: ['interface'],
      doc: 'The module fulfils the contract; a view may draw the pair as one thing with two names.',
    },
    {
      name: OWNS,
      source: [MACHINE],
      target: [STATE],
      maxIn: 1,
      doc: 'The state belongs to the machine. Two owners is a modelling mistake, not two readings of the same state.',
    },
    {
      name: STARTS_AT,
      source: [MACHINE],
      target: [STATE],
      maxOut: 1,
      doc: 'The state the machine is in before anything happens.',
    },
    {
      name: MOVES_TO,
      source: [STATE],
      target: [STATE],
      allowSelfLoops: true,
      doc: "A transition. The edge's label holds the trigger, which is all a statechart needs to draw; a state may move to itself.",
    },
    {
      name: INHERITS,
      source: [MACHINE],
      target: [MACHINE],
      maxOut: 1,
      acyclic: true,
      doc: 'The machine takes over the states and transitions of another, overriding what it redeclares. One parent only, so what a machine inherits is never in doubt.',
    },
  ],
};
