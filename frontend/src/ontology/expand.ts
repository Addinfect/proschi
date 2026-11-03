import {
  indexGraph,
  successors,
  type Edge,
  type Graph,
  type Id,
  type Issue,
  type Node,
} from '../engine';
import {
  ACTIVITY,
  CONTAINS,
  ENTRY,
  EXIT,
  GUARD,
  INHERITS,
  MACHINE,
  MOVES_TO,
  OUTPUTS,
  OWNS,
  OVERRIDES,
  SETS,
  STARTS_AT,
  STATE,
  TRIGGER,
} from './architecture';

/**
 * Reads a machine through its chain of inheritance.
 *
 * A machine owns states (`owns`) and the transitions between them (`moves-to`).
 * A machine may `inherits` one other machine: it then has the inherited states
 * and transitions as well, and a state it declares with an `overrides` attribute
 * takes the place of the inherited state that attribute names.
 *
 * A state may hold states of its own (`contains`). Then the machine is never in the
 * container as such -- it is in one of the states inside it, and the container is a
 * level of the statechart rather than a state a view marks as current. Ownership
 * does not change: a contained state is still owned by the same machine, and
 * `contains` only says where inside it the state sits. Entering a container enters
 * the state it says it starts in, a transition written on a container stands for one
 * crossing from each state at the bottom of it, and the `entry` and `exit` of the
 * states around a state still apply around it (see paths.ts for how a crossing
 * reads).
 *
 * Overriding names an id rather than a name, because every node in a graph has a
 * unique id but need not have a unique name: a replacement is then something the
 * model says, not a side effect of two labels happening to match.
 *
 * Expanding is a reading, not a rewrite. Nothing here changes the graph, so a view
 * can show the inherited machine as it was written next to the child as it
 * behaves. Problems come back in `issues` and are never thrown, and the parts that
 * are sound still come back with them -- the rule the engine's registry follows.
 */

/** A constant a model may write: a number, a boolean, or the text between quotes. */
export type Constant = string | number | boolean;

/** One output a state sets to a constant on the way in or out, or an edge asserts. */
export interface AssignmentView {
  /** Output name, as the machine declared it. */
  output: string;
  /** The constant assigned: a number, a boolean, or the text between quotes. */
  value: Constant;
}

/** One state as an expanded machine sees it. */
export interface StateView {
  /** Node id of the state that is in force at this level of inheritance. */
  id: Id;
  /** The node itself, so a view does not have to look it up again. */
  node: Node;
  /** Name a view shows; absent means the id. */
  name?: string;
  /** True when the machine may stop here. */
  final: boolean;
  /** Id of the machine that declared the state in force: this one, or an ancestor it inherits. */
  declaredBy: Id;
  /** Id of the inherited state this one replaced, when it replaced one. */
  overrides?: Id;
  /** Id of the state this one sits inside; absent for a state the machine is in directly. */
  parent?: Id;
  /** Ids of the states directly inside this one, in declaration order; empty for a state the machine can be in. */
  children: readonly Id[];
  /** Ids of the states this one sits inside, outermost first; empty for a state at the top. */
  ancestors: readonly Id[];
  /** Outputs the state itself sets on entering, in the order written. The states around it write their own. */
  entry: readonly AssignmentView[];
  /** Outputs the state itself sets on leaving, in the order written. */
  exit: readonly AssignmentView[];
  /** The activity that runs while the machine is held here, when one is named. */
  activity?: string;
}

/** One transition as an expanded machine sees it. */
export interface TransitionView {
  /** Edge id. */
  id: Id;
  /** State the machine leaves, after overrides and after a container was read as the states at the bottom of it. */
  from: Id;
  /** State the machine enters, after overrides and after entering a container was read as entering the state it starts in. */
  to: Id;
  /**
   * The state the edge was written on, when that state is a container and the edge
   * therefore stands for one crossing from each state at the bottom of it; absent
   * when the edge starts where it was written. The id stays the edge's, because the
   * model wrote one edge.
   */
  declaredFrom?: Id;
  /** The state the edge was written towards, when entering it was read as entering a state inside it. */
  declaredTo?: Id;
  /** The event the transition waits for; absent on a transition that fires by itself. */
  trigger?: string;
  /** The condition that picks this transition among the ones leaving the same state. */
  guard?: string;
  /**
   * What the model asserts holds after crossing, as `name = value` pieces. An
   * assertion, not a write: it changes nothing, it is checked (see paths.ts).
   */
  sets: readonly AssignmentView[];
  /**
   * True when an override moved one end of the transition onto a replacing state. A
   * container that changed an end is not an override: it shows up in `declaredFrom`
   * and `declaredTo` instead.
   */
  retargeted: boolean;
}

/** A machine read through its inheritance chain. */
export interface MachineView {
  /** Id of the machine the view was expanded for. */
  machine: Id;
  /**
   * States in force: the ancestors' first, in the order they declared them, then
   * this machine's own new ones. A replacing state keeps the place of the state it
   * replaces, so a statechart does not jump when a machine is refined.
   */
  states: readonly StateView[];
  /** Transitions between states in force, in graph order, with both ends resolved through overrides. */
  transitions: readonly TransitionView[];
  /** Outputs the states of this machine may set, own ones first, then the inherited ones. */
  outputs: readonly string[];
  /** The state the machine starts in, after overrides; absent when the model does not say. */
  initial?: Id;
  issues: Issue[];
}

/** Every machine in a graph, in graph order. */
export function machinesIn(graph: Graph): Id[] {
  const machines: Id[] = [];
  for (const node of graph.nodes) {
    if (node.type === MACHINE) machines.push(node.id);
  }
  return machines;
}

/**
 * Expands one machine: its states and transitions with everything inherited from
 * the machines it inherits, applied in order so that the most derived machine
 * wins. An id that appears nowhere is reported, never assumed.
 */
export function expandMachine(graph: Graph, machine: Id): MachineView {
  const index = indexGraph(graph);
  const nodes = index.nodes;
  const issues: Issue[] = [];
  const node = nodes.get(machine);

  if (!node || node.type !== MACHINE) {
    issues.push({
      severity: 'error',
      code: 'unknown-machine',
      subject: machine,
      message: `"${machine}" is not a machine in this graph.`,
    });
    return { machine, states: [], transitions: [], outputs: [], issues };
  }

  // The chain of machines: the expanded one first, its root ancestor last.
  const chain: Id[] = [machine];
  const walked = new Set<Id>([machine]);
  let current: Id = machine;
  for (;;) {
    const parents = successors(index, current, { relations: [INHERITS] });
    if (parents.length === 0) break;
    if (parents.length > 1) {
      issues.push({
        severity: 'error',
        code: 'many-parents',
        subject: current,
        message: `"${current}" inherits ${parents.length} machines (${parents.join(', ')}); only "${parents[0]}" is used.`,
      });
    }
    const parent: Id = parents[0];
    if (walked.has(parent)) {
      issues.push({
        severity: 'error',
        code: 'inherits-cycle',
        subject: parent,
        message: `"${current}" inherits "${parent}", which inherits it back. The chain is cut there.`,
      });
      break;
    }
    const parentNode = nodes.get(parent);
    if (!parentNode || parentNode.type !== MACHINE) {
      issues.push({
        severity: 'error',
        code: 'inherits-unknown',
        subject: current,
        message: `"${current}" inherits "${parent}", which is not a machine in this graph.`,
      });
      break;
    }
    walked.add(parent);
    chain.push(parent);
    current = parent;
  }

  // The outputs the machine declares, comma-separated on the machine itself, plus
  // whatever its ancestors declare: an inherited state may write a parent's output,
  // because a child that extends a machine still enters the inherited states. A name
  // declared twice by the same machine is a mistake; a child redeclaring a parent's
  // name is not, it is just the same output again.
  const outputs: string[] = [];
  const declaredOutput = new Set<string>();
  for (const owner of chain) {
    const ownerNode = nodes.get(owner);
    if (!ownerNode) continue;
    const here = new Set<string>();
    for (const name of listOf(ownerNode, OUTPUTS)) {
      if (here.has(name)) {
        issues.push({
          severity: 'error',
          code: 'duplicate-output',
          subject: owner,
          message: `"${owner}" declares the output "${name}" twice.`,
        });
        continue;
      }
      here.add(name);
      if (declaredOutput.has(name)) continue;
      declaredOutput.add(name);
      outputs.push(name);
    }
  }

  /** Id in force, after any number of replacements. */
  const replacedBy = new Map<Id, Id>();
  const resolve = (id: Id): Id => {
    const seen = new Set<Id>();
    let at = id;
    while (!seen.has(at)) {
      seen.add(at);
      const next = replacedBy.get(at);
      if (next === undefined) return at;
      at = next;
    }
    return at;
  };

  // States in force, in the order they were declared. Ancestors first, so a
  // machine's own states extend the picture instead of reshuffling it.
  const order: Id[] = [];
  const declaredBy = new Map<Id, Id>();
  const overrode = new Map<Id, Id>();

  for (const owner of [...chain].reverse()) {
    for (const stateId of successors(index, owner, { relations: [OWNS] })) {
      const state = nodes.get(stateId);
      if (!state || state.type !== STATE) {
        issues.push({
          severity: 'error',
          code: 'not-a-state',
          subject: stateId,
          message: `"${owner}" owns "${stateId}", which is not a state.`,
        });
        continue;
      }
      const named = state.attributes?.[OVERRIDES];
      if (typeof named !== 'string') {
        order.push(stateId);
        declaredBy.set(stateId, owner);
        continue;
      }
      const at = resolve(named);
      const slot = order.indexOf(at);
      if (slot < 0) {
        issues.push({
          severity: 'error',
          code: 'unknown-override',
          subject: stateId,
          message: `"${stateId}" overrides "${named}", which no machine it inherits from declares. It is added as a state of its own.`,
        });
        order.push(stateId);
        declaredBy.set(stateId, owner);
        continue;
      }
      if (declaredBy.get(at) === owner) {
        issues.push({
          severity: 'error',
          code: 'double-override',
          subject: stateId,
          message: `"${owner}" declares "${stateId}" as a replacement for "${named}", which it already replaced. The state is added as a new one.`,
        });
        order.push(stateId);
        declaredBy.set(stateId, owner);
        continue;
      }
      order[slot] = stateId;
      replacedBy.set(at, stateId);
      replacedBy.set(named, stateId);
      declaredBy.delete(at);
      declaredBy.set(stateId, owner);
      overrode.set(stateId, named);
    }
  }

  const inForce = new Set(order);

  // Which states hold which, read from `contains`. The relation allows one container
  // per state and no cycle (see architecture.ts), so this is a tree; a graph that
  // skipped that check is cut here rather than walked in circles.
  const containerOf = new Map<Id, Id>();
  const childrenOf = new Map<Id, Id[]>();
  for (const edge of index.edges) {
    if (edge.relation !== CONTAINS) continue;
    const holder = resolve(edge.source);
    const held = resolve(edge.target);
    if (!inForce.has(holder) || !inForce.has(held)) continue;
    const other = containerOf.get(held);
    if (other !== undefined) {
      issues.push({
        severity: 'error',
        code: 'many-parents',
        subject: held,
        message: `"${held}" is inside both "${other}" and "${holder}"; only "${other}" is used.`,
      });
      continue;
    }
    containerOf.set(held, holder);
    const inside = childrenOf.get(holder);
    if (inside) inside.push(held);
    else childrenOf.set(holder, [held]);
  }

  /** The states directly inside one, in declaration order. */
  const childrenIn = (id: Id): readonly Id[] => childrenOf.get(id) ?? [];

  /** The states containing one, outermost first, the state itself last. */
  const reportedCycle = new Set<Id>();
  const chainTo = (id: Id): Id[] => {
    const chain: Id[] = [id];
    const walked = new Set<Id>([id]);
    let at = containerOf.get(id);
    while (at !== undefined) {
      if (walked.has(at)) {
        if (!reportedCycle.has(at)) {
          reportedCycle.add(at);
          issues.push({
            severity: 'error',
            code: 'contains-cycle',
            subject: at,
            message: `"${at}" is inside "${id}", which is inside it again, so the states of this machine do not form a tree. The hierarchy is cut there.`,
          });
        }
        break;
      }
      walked.add(at);
      chain.push(at);
      at = containerOf.get(at);
    }
    return chain.reverse();
  };

  /** The states at the bottom of one: the only states the machine can be in. */
  const leavesIn = (id: Id): Id[] => {
    const leaves: Id[] = [];
    const walked = new Set<Id>();
    const open: Id[] = [id];
    for (let at = 0; at < open.length; at += 1) {
      const below = childrenIn(open[at]).filter((child) => !walked.has(child));
      if (below.length === 0) {
        leaves.push(open[at]);
        continue;
      }
      for (const child of below) walked.add(child);
      open.push(...below);
    }
    return leaves;
  };

  /**
   * The state the machine is in once it has entered one: what a container says it
   * starts in, followed down until a state holds nothing itself. A container that
   * does not say is undecided, and so is one whose start leads back into it.
   */
  const enteredIn = (id: Id): Id | undefined => {
    let at = id;
    const walked = new Set<Id>([at]);
    for (;;) {
      if (childrenIn(at).length === 0) return at;
      const named = successors(index, at, { relations: [STARTS_AT] })[0];
      if (named === undefined) {
        issues.push({
          severity: 'error',
          code: 'no-entry',
          subject: at,
          message: `"${at}" has states inside it and does not say which one it starts in, so which state the machine enters is undecided.`,
        });
        return undefined;
      }
      const next = resolve(named);
      if (!chainTo(next).includes(at)) {
        issues.push({
          severity: 'error',
          code: 'initial-unknown',
          subject: at,
          message: `"${at}" starts at "${next}", which is not one of the states inside it.`,
        });
        return undefined;
      }
      if (walked.has(next)) {
        issues.push({
          severity: 'error',
          code: 'contains-cycle',
          subject: at,
          message: `"${at}" starts at "${next}", which leads back to it, so the state entered is undecided.`,
        });
        return undefined;
      }
      walked.add(next);
      at = next;
    }
  };

  // What each state itself writes, read once: a mistake is then reported once, and
  // the pieces can be put in the order of a crossing afterwards (see paths.ts).
  const ownEntry = new Map<Id, readonly AssignmentView[]>();
  const ownExit = new Map<Id, readonly AssignmentView[]>();
  for (const id of order) {
    const state = nodes.get(id);
    if (!state) continue;
    ownEntry.set(id, parseEffects(textOf(state, ENTRY), 'entry', id, declaredOutput, issues));
    ownExit.set(id, parseEffects(textOf(state, EXIT), 'exit', id, declaredOutput, issues));
  }

  const states: StateView[] = [];
  for (const id of order) {
    const state = nodes.get(id);
    if (!state) continue;
    states.push({
      id,
      node: state,
      name: state.name,
      final: state.attributes?.final === true,
      declaredBy: declaredBy.get(id) ?? machine,
      overrides: overrode.get(id),
      parent: containerOf.get(id),
      children: childrenIn(id),
      ancestors: chainTo(id).slice(0, -1),
      entry: ownEntry.get(id) ?? [],
      exit: ownExit.get(id) ?? [],
      activity: textOf(state, ACTIVITY),
    });
  }

  const transitions: TransitionView[] = [];
  for (const edge of index.edges) {
    if (edge.relation !== MOVES_TO) continue;
    const source = resolve(edge.source);
    const target = resolve(edge.target);
    if (!inForce.has(source) || !inForce.has(target)) continue;
    // Read the assertion once per edge: a container turns one edge into several
    // crossings, and they all assert the same thing.
    const sets = parseEffects(textOf(edge, SETS), 'sets', edge.id, declaredOutput, issues);
    const to = enteredIn(target);
    if (to === undefined) continue;
    for (const from of leavesIn(source)) {
      transitions.push({
        id: edge.id,
        from,
        to,
        declaredFrom: from === source ? undefined : source,
        declaredTo: to === target ? undefined : target,
        trigger: textOf(edge, TRIGGER) ?? edge.label,
        guard: textOf(edge, GUARD),
        sets,
        retargeted: source !== edge.source || target !== edge.target,
      });
    }
  }

  // A trigger names an event, and a machine is in one state at a time: two
  // transitions that leave the same state on the same event and the same guard
  // leave the next state undecided. Guards are names, not expressions, so this
  // compares them as text and says nothing about whether two different guards
  // could both hold -- that needs the requirements, not the diagram.
  const byFire = new Map<string, { first: TransitionView; ids: Id[] }>();
  for (const transition of transitions) {
    const key = [transition.from, transition.trigger ?? '', transition.guard ?? ''].join('\u0000');
    const seen = byFire.get(key);
    if (seen) seen.ids.push(transition.id);
    else byFire.set(key, { first: transition, ids: [transition.id] });
  }
  for (const { first, ids } of byFire.values()) {
    if (ids.length < 2) continue;
    const when =
      first.trigger === undefined
        ? 'by itself'
        : `on "${first.trigger}"${first.guard === undefined ? '' : ` while "${first.guard}" holds`}`;
    issues.push({
      severity: 'error',
      code: 'duplicate-trigger',
      subject: first.from,
      message: `"${first.from}" leaves ${when} more than once (${ids.join(', ')}), so which state it enters is undecided.`,
    });
  }

  // One transition without a trigger per state is the default: what the machine
  // does when no named event arrives. Two of them are two answers to the same
  // question, and their guards are names -- so nothing can pick between them.
  const defaults = new Map<Id, { ids: Id[]; guards: Set<string> }>();
  for (const transition of transitions) {
    if (transition.trigger !== undefined) continue;
    const seen = defaults.get(transition.from);
    if (seen) {
      seen.ids.push(transition.id);
      seen.guards.add(transition.guard ?? '');
    } else {
      defaults.set(transition.from, { ids: [transition.id], guards: new Set([transition.guard ?? '']) });
    }
  }
  for (const [from, { ids, guards }] of defaults) {
    // Two defaults with the same guard are one mistake, already reported above.
    if (ids.length < 2 || guards.size < 2) continue;
    issues.push({
      severity: 'error',
      code: 'many-defaults',
      subject: from,
      message: `"${from}" leaves by itself ${ids.length} times (${ids.join(', ')}) and their guards are names, so which one fires cannot be decided.`,
    });
  }

  // The nearest machine in the chain that says where to start decides.
  let declaredStart: Id | undefined;
  for (const owner of chain) {
    const first = successors(index, owner, { relations: [STARTS_AT] })[0];
    if (first === undefined) continue;
    declaredStart = first;
    break;
  }

  let initial: Id | undefined;
  if (declaredStart === undefined) {
    issues.push({
      severity: 'warning',
      code: 'no-initial',
      subject: machine,
      message: `"${machine}" does not say which state it starts in, so a statechart cannot place the entry marker.`,
    });
  } else {
    const at = resolve(declaredStart);
    if (inForce.has(at)) {
      // The machine starts in a state, and a container is a level rather than a
      // state: the machine starts in what the container says it starts in.
      initial = enteredIn(at);
    } else {
      issues.push({
        severity: 'error',
        code: 'initial-unknown',
        subject: machine,
        message: `"${machine}" starts at "${declaredStart}", which no machine in its chain owns.`,
      });
    }
  }

  return { machine, states, transitions, outputs, initial, issues };
}

/**
 * A text attribute of an edge or a node, when it is set. Attributes are scalars, so
 * this also refuses the case where an author wrote a number where a name belongs;
 * the check for that is the engine's `attribute-kind`, and this only declines to
 * read it.
 */
function textOf(holder: Edge | Node, key: string): string | undefined {
  const value = holder.attributes?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A comma-separated list of names, ignoring empty pieces. */
function listOf(node: Node, key: string): string[] {
  const written = textOf(node, key);
  if (written === undefined) return [];
  return written
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * What a state writes on entering or leaving, or what an edge asserts, read from
 * one string.
 *
 * The notation is deliberately two characters wide: `name = value` pieces separated
 * by `;`, and a value that is a number, `true`, `false` or a quoted string. Nothing
 * is evaluated, so a bare word is refused rather than quietly taken as text -- a
 * misspelling that becomes a signal is the failure this check exists to prevent.
 *
 * The subject is a state for `entry` and `exit` and an edge for `sets`, so the
 * messages name it without claiming which kind it is. A name written twice in the
 * same piece list is reported and the last piece kept: `a = 0; a = 1` reads as an
 * afterthought, not as a dependence on order, and a silent override is the kind of
 * thing a reader has to be told about.
 *
 * The cost of keeping this out of the engine is this function: the engine sees one
 * string attribute, and the subject matter -- that a state writes outputs -- is read
 * here. That is the same trade as the trigger, and it keeps `src/engine/` ignorant
 * of statecharts.
 */
function parseEffects(
  written: string | undefined,
  key: string,
  subject: Id,
  outputs: ReadonlySet<string>,
  issues: Issue[],
): AssignmentView[] {
  if (written === undefined) return [];
  const assignments: AssignmentView[] = [];
  const seen = new Set<string>();
  for (const piece of written.split(';')) {
    const text = piece.trim();
    if (text.length === 0) continue;
    const at = text.indexOf('=');
    const name = at < 0 ? '' : text.slice(0, at).trim();
    const value = at < 0 ? undefined : constantOf(text.slice(at + 1).trim());
    if (name.length === 0 || value === undefined) {
      issues.push({
        severity: 'error',
        code: 'bad-effect',
        subject,
        message: `"${subject}" writes "${text}" in its ${key}; a piece is \`name = value\` with a number, true, false or a quoted string.`,
      });
      continue;
    }
    if (!outputs.has(name)) {
      issues.push({
        severity: 'error',
        code: 'unknown-output',
        subject,
        message: `"${subject}" sets "${name}" in its ${key}, which no machine in the chain declares in \`outputs\`.`,
      });
      continue;
    }
    if (seen.has(name)) {
      issues.push({
        severity: 'error',
        code: 'duplicate-effect',
        subject,
        message: `"${subject}" writes "${name}" more than once in its ${key}; the last piece wins.`,
      });
    }
    seen.add(name);
    assignments.push({ output: name, value });
  }
  return assignments;
}

/**
 * The constant a value piece names, or nothing when it names no constant. Quoted
 * text is returned without its quotes, so a view can show it as written.
 */
function constantOf(text: string): Constant | undefined {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  const quote = text.charAt(0);
  if (text.length > 1 && (quote === '"' || quote === "'") && text.endsWith(quote)) {
    return text.slice(1, -1);
  }
  return undefined;
}

