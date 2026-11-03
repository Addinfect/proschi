import type { Id, Issue } from '../engine';
import type { Constant, MachineView, TransitionView } from './expand';

export type { Constant } from './expand';

/**
 * What a machine's outputs hold in each of its states.
 *
 * A machine records two things about its outputs: a state writes constants on the
 * way in (`entry`) or on the way out (`exit`), and a transition may assert what
 * holds after crossing it (`sets`). Nothing here runs, and there is no time in the
 * model, so "what holds in a state" means "what the path into that state last
 * wrote". Three rules, and they are all of it:
 *
 * - A state that writes an output on entry holds that constant, whatever the
 *   previous state held. Entering overrides what the path carried.
 * - A state that says nothing about an output keeps what it was given, which is
 *   why a state that waits does not put its machine's outputs anywhere.
 * - Leaving writes `exit` values into the edge, so a successor that does not write
 *   an output sees what its predecessor left rather than what the predecessor held
 *   while it was running. That is what `exit` is for, and it is a default only: an
 *   `entry` in the successor wins.
 *
 * That makes the answer path-dependent: an output may hold one of several values in
 * the same state, depending on how the machine got there. This module reports all of
 * them, each with the transition that first brought it, instead of picking one --
 * picking is what the model has to do, either by writing the output somewhere on
 * every path or by asserting it with `sets`.
 *
 * A state may sit inside another one (see expand.ts). The machine is then only ever
 * in a state at the bottom of the tree, so only those states get a row here: a
 * container is a level of the statechart, not a configuration. A crossing leaves and
 * enters a chain of states rather than one, and the three rules above still apply,
 * read along that chain -- the `exit` pieces run from the state left outwards, the
 * `entry` pieces run from the outermost container inwards, and the two chains meet
 * at the innermost state both ends are inside. Crossing between two states of the
 * same container therefore writes nothing but their own pieces, while crossing out
 * of a container writes its `exit`, which is how an output can be guaranteed `0` by
 * leaving a whole mode rather than by repeating the assignment in every state.
 *
 * `sets` never writes. It is an assertion by the model about its own behaviour, and
 * the only thing this module does with it is check it: agrees, undecided, or
 * contradicted.
 *
 * The set of values an output can hold is finite -- what the states write -- so the
 * analysis is a fixed point over that set and terminates on cycles and self-loops.
 * Values are only ever added, never removed, so a transition to a state that already
 * holds a value changes nothing.
 */

/** One value an output may hold in a state, and the transition that first brought it. */
export interface Possibility {
  /** The constant the output holds; absent means nothing has written it yet. */
  value: Constant | undefined;
  /**
   * Id of the transition the value arrived by; absent in the initial state, which
   * nothing crossed into, and absent when the value is still unwritten, because
   * "nothing has written this" is not delivered by any transition.
   */
  via?: Id;
}

/** What one output may hold in one state. */
export interface HoldsView {
  /** State id. */
  state: Id;
  /** Output name, as the machine declared it. */
  output: string;
  /** Every value the output may hold here, in the order they were found; empty when the state is unreachable. */
  possibilities: readonly Possibility[];
  /** False when no path from the initial state arrives here. */
  reachable: boolean;
}

/** What one crossing writes on the way out and on the way in, each merged last-wins. */
interface Crossing {
  /** Outputs written by the states left, innermost first. */
  leaving: Map<string, Constant>;
  /** Outputs written by the states entered, outermost first. */
  entering: Map<string, Constant>;
}

/** The outputs of one machine, read along every path through it. */
export interface PathsView {
  /** Id of the machine the paths were read for. */
  machine: Id;
  /**
   * One entry per state the machine can be in and output, in state order then output
   * order. A container has no row: only the states at the bottom hold anything.
   */
  holds: readonly HoldsView[];
  /** Assertions that do not hold, and outputs no state writes. Never thrown. */
  issues: Issue[];
}

/**
 * Reads what each output of an expanded machine may hold in each of its states.
 *
 * The input is a `MachineView`, not a graph: inheritance and overrides are already
 * resolved there, so this only has to walk `transitions` and read `entry`/`exit`.
 */
export function readPaths(view: MachineView): PathsView {
  const issues: Issue[] = [];
  const outputs = view.outputs;

  // What each state writes, as a map from output to constant. A state that writes
  // the same output twice in one piece list keeps the last one; that is a mistake
  // expand.ts reports as `duplicate-effect`, and the last piece winning is what a
  // reader of `a = 1; a = 0` would expect.
  const entry = new Map<Id, Map<string, Constant>>();
  const exit = new Map<Id, Map<string, Constant>>();
  for (const state of view.states) {
    entry.set(state.id, writesOf(state.entry));
    exit.set(state.id, writesOf(state.exit));
  }

  // Which states sit inside which, outermost first, so a crossing can name what it
  // leaves and what it enters without walking the graph again.
  const ancestorsOf = new Map<Id, readonly Id[]>();
  for (const state of view.states) ancestorsOf.set(state.id, state.ancestors);

  /** One state with everything around it, outermost first, the state itself last. */
  const pathOf = (id: Id): Id[] => [...(ancestorsOf.get(id) ?? []), id];

  /**
   * The states one crossing leaves and the states it enters. Both are given the way
   * the pieces would run, so merging them last-wins is the order a statechart runs.
   *
   * A machine is never in a container, so a crossing only has to leave the states
   * around the state it was in and enter the states around the state it arrives at.
   * The two chains meet at the innermost state both ends are inside: nothing above
   * that point is left or entered, which is why a crossing between siblings is the
   * flat case this module had before states could hold states, and why `from === to`
   * leaves and enters exactly one state.
   */
  const crossingOf = (from: Id, to: Id): { leaving: Id[]; entering: Id[] } => {
    const shared = sharedPrefix(ancestorsOf.get(from) ?? [], ancestorsOf.get(to) ?? []);
    return { leaving: pathOf(from).slice(shared).reverse(), entering: pathOf(to).slice(shared) };
  };

  /** The pieces the given states write, merged with the last one winning. */
  const writesAlong = (ids: readonly Id[], table: Map<Id, Map<string, Constant>>): Map<string, Constant> => {
    const writes = new Map<string, Constant>();
    for (const id of ids) {
      const written = table.get(id);
      if (!written) continue;
      for (const [output, value] of written) writes.set(output, value);
    }
    return writes;
  };

  // What each crossing writes, computed once per transition object. Keyed by the
  // object and never by the id: a transition written on a container becomes one
  // crossing from each state at the bottom of it, and those crossings leave
  // different states. The id belongs to the edge, the crossing does not.
  const crossings = new Map<TransitionView, Crossing>();
  for (const transition of view.transitions) {
    const { leaving, entering } = crossingOf(transition.from, transition.to);
    crossings.set(transition, {
      leaving: writesAlong(leaving, exit),
      entering: writesAlong(entering, entry),
    });
  }
  const noWrites: Crossing = { leaving: new Map(), entering: new Map() };
  /** What one transition writes. Every transition was crossed above. */
  const crossing = (transition: TransitionView): Crossing => crossings.get(transition) ?? noWrites;

  // Which states a path can arrive at at all. Kept apart from the values, because a
  // machine with no declared outputs still has reachable states.
  const reachable = new Set<Id>();
  if (view.initial !== undefined) {
    reachable.add(view.initial);
    const walk: Id[] = [view.initial];
    for (let at = 0; at < walk.length; at += 1) {
      for (const transition of view.transitions) {
        if (transition.from !== walk[at]) continue;
        if (reachable.has(transition.to)) continue;
        reachable.add(transition.to);
        walk.push(transition.to);
      }
    }
  }

  // Holds[state][output] is the set of values the output may hold there, each with
  // the transition that first delivered it. A missing value means "nothing has
  // written this output yet", which is a value in its own right -- `undefined` is a
  // key like any other.
  const holds = new Map<Id, Map<string, Map<Constant | undefined, Id | undefined>>>();
  for (const state of view.states) {
    const perOutput = new Map<string, Map<Constant | undefined, Id | undefined>>();
    for (const output of outputs) perOutput.set(output, new Map());
    holds.set(state.id, perOutput);
  }

  // The initial state holds what it writes on the way in and nothing else: whatever
  // the states around it write, then its own `entry`. Nothing crossed into it, so
  // these values carry no witness.
  const initial = view.initial;
  if (initial !== undefined) {
    const seed = holds.get(initial);
    const written = writesAlong(pathOf(initial), entry);
    if (seed) {
      for (const output of outputs) {
        const values = seed.get(output);
        if (values) values.set(written.get(output), undefined);
      }
    }
  }

  // Cross every transition from the states that have something new to say, until no
  // state gains a value. The value set is finite, so this ends even with cycles.
  const queue: Id[] = initial === undefined ? [] : [initial];
  const queued = new Set<Id>(queue);
  for (let at = 0; at < queue.length; at += 1) {
    const from = queue[at];
    queued.delete(from);
    for (const transition of view.transitions) {
      if (transition.from !== from) continue;
      const source = holds.get(from);
      const target = holds.get(transition.to);
      if (!source || !target) continue;
      const { leaving, entering } = crossing(transition);
      let changed = false;
      for (const output of outputs) {
        const inValues = source.get(output);
        if (!inValues || inValues.size === 0) continue;
        let outValues = target.get(output);
        if (!outValues) {
          outValues = new Map();
          target.set(output, outValues);
        }
        // What the crossing writes on the way in wins, then what it wrote on the way
        // out, then whatever the path carried in. Whichever it is, the value arrived
        // here by this transition, which is what a witness names.
        const onEntry = entering.get(output);
        const onExit = leaving.get(output);
        for (const [value] of inValues) {
          const next = onEntry !== undefined ? onEntry : onExit !== undefined ? onExit : value;
          if (outValues.has(next)) continue;
          outValues.set(next, next === undefined ? undefined : transition.id);
          changed = true;
        }
      }
      if (changed && !queued.has(transition.to)) {
        queue.push(transition.to);
        queued.add(transition.to);
      }
    }
  }

  const transitionById = new Map<Id, TransitionView>();
  for (const transition of view.transitions) transitionById.set(transition.id, transition);

  /** How the model names the event that takes a transition, for messages. */
  const fireOf = (id: Id): string => {
    const transition = transitionById.get(id);
    return transition?.trigger ?? id;
  };

  /**
   * How a message names one crossing. A transition written on a container stands
   * for several crossings, so the message has to say which one it means, or a reader
   * would look for an edge leaving a state that has no transition of its own.
   */
  const nameOf = (transition: TransitionView): string =>
    transition.declaredFrom === undefined
      ? `"${transition.id}"`
      : `"${transition.id}" from "${transition.from}"`;

  /**
   * The set of values one crossing delivers to one output, each with the transition it
   * came from.
   *
   * A value the crossing decides by itself -- the successor's `entry`, or the `exit`
   * the predecessor left behind -- is the same on every path into this transition, so
   * it carries no witness: naming a transition would add nothing to what the assertion
   * already says. A *carried* value is the interesting one, because it is what makes
   * the assertion depend on how the machine got here, and its witness is where it came
   * from rather than this transition, which the reader is already looking at.
   */
  const delivered = (transition: TransitionView, output: string): Map<Constant | undefined, Id | undefined> => {
    const result = new Map<Constant | undefined, Id | undefined>();
    const source = holds.get(transition.from);
    if (!source || !reachable.has(transition.from)) return result;
    const inValues = source.get(output);
    if (!inValues) return result;
    const { leaving, entering } = crossing(transition);
    const onEntry = entering.get(output);
    const onExit = leaving.get(output);
    const decided = onEntry !== undefined || onExit !== undefined;
    for (const [value, via] of inValues) {
      const next = onEntry !== undefined ? onEntry : onExit !== undefined ? onExit : value;
      if (!result.has(next)) result.set(next, decided ? undefined : via);
    }
    return result;
  };

  // An assertion is a claim about the model, so it is checked against every path the
  // model allows: one value that agrees is a claim that holds, one value that
  // disagrees is a claim the model contradicts, and several values are a claim the
  // model leaves open. That difference is the point of writing the assertion down.
  for (const transition of view.transitions) {
    for (const assertion of transition.sets) {
      const values = delivered(transition, assertion.output);
      if (values.size === 0) {
        issues.push({
          severity: 'warning',
          code: 'sets-undecided',
          subject: transition.id,
          message: `${nameOf(transition)} says it sets "${assertion.output}" to ${show(assertion.value)}, but the machine cannot reach "${transition.from}", so the assertion is unchecked.`,
        });
        continue;
      }
      if (values.size === 1 && values.has(assertion.value)) continue;
      // The values the assertion does not allow, each named with where it came from
      // when where it came from is the answer to "why is this not determined?".
      const others = [...values]
        .filter(([value]) => value !== assertion.value)
        .map(([value, via]) => (via === undefined ? show(value) : `${show(value)} (via "${fireOf(via)}")`))
        .join(' or ');
      if (values.has(assertion.value)) {
        issues.push({
          severity: 'warning',
          code: 'sets-undecided',
          subject: transition.id,
          message: `${nameOf(transition)} says it sets "${assertion.output}" to ${show(assertion.value)}, but crossing it can also leave ${others}, so the assertion holds on some paths only.`,
        });
        continue;
      }
      if (values.has(undefined)) {
        issues.push({
          severity: 'warning',
          code: 'sets-undecided',
          subject: transition.id,
          message: `${nameOf(transition)} says it sets "${assertion.output}" to ${show(assertion.value)}, but nothing writes "${assertion.output}" before this transition, so it may hold nothing at all.`,
        });
        continue;
      }
      issues.push({
        severity: 'error',
        code: 'sets-contradicted',
        subject: transition.id,
        message: `${nameOf(transition)} says it sets "${assertion.output}" to ${show(assertion.value)}, but crossing it leaves ${others}.`,
      });
    }
  }

  // An output nobody writes is a name in the model and nothing else: it is never
  // driven, which for a hardware model is exactly the kind of silence that hides a
  // missing state rather than a missing line of code.
  const touched = new Set<string>();
  for (const state of view.states) {
    for (const assignment of state.entry) touched.add(assignment.output);
    for (const assignment of state.exit) touched.add(assignment.output);
  }
  for (const output of outputs) {
    if (touched.has(output)) continue;
    issues.push({
      severity: 'warning',
      code: 'output-never-set',
      subject: view.machine,
      message: `"${view.machine}" declares the output "${output}" but no state writes it, so it keeps whatever it held before the machine started.`,
    });
  }

  const result: HoldsView[] = [];
  for (const state of view.states) {
    // A container is a level of the statechart, not a state the machine is in, so
    // it has no row of its own: what it writes is read at the crossings in and out.
    if (state.children.length > 0) continue;
    const perOutput = holds.get(state.id);
    for (const output of outputs) {
      const values = perOutput?.get(output);
      const possibilities: Possibility[] = [];
      if (values) {
        for (const [value, via] of values) possibilities.push(via === undefined ? { value } : { value, via });
      }
      result.push({
        state: state.id,
        output,
        possibilities,
        reachable: reachable.has(state.id),
      });
    }
  }

  return { machine: view.machine, holds: result, issues };
}

/** How many leading ids two chains share, which is the innermost state they have in common. */
function sharedPrefix(a: readonly Id[], b: readonly Id[]): number {
  const end = Math.min(a.length, b.length);
  let at = 0;
  while (at < end && a[at] === b[at]) at += 1;
  return at;
}

/** What a state writes, as a map from output to constant; the last piece wins. */
function writesOf(assignments: readonly { output: string; value: Constant }[]): Map<string, Constant> {
  const writes = new Map<string, Constant>();
  for (const assignment of assignments) writes.set(assignment.output, assignment.value);
  return writes;
}

/** A constant as the model wrote it, so a message quotes strings and nothing else. */
function show(value: Constant | undefined): string {
  if (value === undefined) return 'nothing';
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
}
