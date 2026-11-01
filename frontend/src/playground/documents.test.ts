import { describe, expect, it } from 'vitest';
import { BLANK_SOURCE, addDoc, cloudImports, currentDoc, initialState, isBlank, removeDoc, selectDoc, storedImports, titleOf, updateCurrent } from './documents';

const clock = () => '2026-01-01T00:00:00.000Z';
const ids = () => {
  let n = 0;
  return () => `d${++n}`;
};

const base = { stored: null, legacySource: null, sharedSource: null, fallbackSource: 'title "Example"' };

describe('initialState', () => {
  it('starts from the example on first visit', () => {
    const state = initialState(base, clock, ids());
    expect(state.docs.map((d) => d.source)).toEqual(['title "Example"']);
    expect(state.currentId).toBe('d1');
  });

  it('migrates the pre-existing single editor source', () => {
    const state = initialState({ ...base, legacySource: 'a -> b' }, clock, ids());
    expect(currentDoc(state).source).toBe('a -> b');
  });

  it('opens a shared diagram as a new document', () => {
    const stored = { docs: [{ id: 'x', source: 'mine', updatedAt: clock() }], currentId: 'x' };
    const state = initialState({ ...base, stored, sharedSource: 'shared' }, clock, ids());
    expect(state.docs.map((d) => d.source)).toEqual(['shared', 'mine']);
    expect(currentDoc(state).source).toBe('shared');
  });

  it('reuses an identical saved diagram when a share link is reloaded', () => {
    const stored = {
      docs: [
        { id: 'x', source: 'same', updatedAt: clock() },
        { id: 'y', source: 'other', updatedAt: clock() },
      ],
      currentId: 'y',
    };
    const state = initialState({ ...base, stored, sharedSource: 'same' }, clock, ids());
    expect(state.docs).toHaveLength(2);
    expect(state.currentId).toBe('x');
  });

  it('never stores the cloud: files a share link bundles, and drops ones saved before', () => {
    const sharedImports = { 'db.proschi': 'db [PostgreSQL]', 'cloud:orders:latest': 'api', 'cloud:orders:latest//lib/db.proschi': 'db', 'CLOUD:x:v1': 'x' };
    const opened = initialState({ ...base, sharedSource: 'import "cloud:orders"', sharedImports }, clock, ids());
    expect(currentDoc(opened).imports).toEqual({ 'db.proschi': 'db [PostgreSQL]' });
    expect(cloudImports(sharedImports)).toEqual({ 'cloud:orders:latest': 'api', 'cloud:orders:latest//lib/db.proschi': 'db', 'CLOUD:x:v1': 'x' });
    // Reloading the link onto the saved copy adds none either.
    expect(currentDoc(initialState({ ...base, stored: opened, sharedSource: 'import "cloud:orders"', sharedImports }, clock, ids())).imports).toEqual({ 'db.proschi': 'db [PostgreSQL]' });
    // A diagram stored with them (before this rule) loses them on load.
    const stored = { docs: [{ id: 'x', source: 's', updatedAt: clock(), imports: { 'cloud:orders:latest': 'api' } }], currentId: 'x' };
    expect(currentDoc(initialState({ ...base, stored }, clock, ids()))).not.toHaveProperty('imports');
    expect(storedImports({ 'cloud:a:latest': 'a' })).toBeUndefined();
  });

  it('repairs a dangling current id', () => {
    const stored = { docs: [{ id: 'x', source: 's', updatedAt: clock() }], currentId: 'gone' };
    expect(initialState({ ...base, stored }, clock, ids()).currentId).toBe('x');
  });
});

describe('document operations', () => {
  const start = () => initialState(base, clock, ids());

  it('updates only the current document and keeps identity when unchanged', () => {
    let state = addDoc(start(), 'second', clock, () => 'd2');
    state = updateCurrent(state, 'second, edited', () => 'later');
    expect(state.docs.map((d) => [d.source, d.updatedAt])).toEqual([
      ['second, edited', 'later'],
      ['title "Example"', clock()],
    ]);
    expect(updateCurrent(state, 'second, edited')).toBe(state);
  });

  it('selects existing documents only', () => {
    const state = addDoc(start(), 'second', clock, () => 'd2');
    expect(selectDoc(state, 'd1').currentId).toBe('d1');
    expect(selectDoc(state, 'nope')).toBe(state);
  });

  it('moves to another document when deleting the current one', () => {
    const state = addDoc(start(), 'second', clock, () => 'd2');
    expect(removeDoc(state, 'd2').currentId).toBe('d1');
    expect(removeDoc(state, 'd1').currentId).toBe('d2');
  });

  it('leaves a blank document after deleting the last one', () => {
    const state = removeDoc(start(), 'd1', clock, () => 'fresh');
    expect(state).toEqual({ docs: [{ id: 'fresh', source: BLANK_SOURCE, updatedAt: clock(), fileName: 'untitled.proschi' }], currentId: 'fresh' });
  });
});

describe('titleOf', () => {
  it.each([
    ['title "Payments"\na -> b', 'Payments'],
    ['# comment\n  title Billing', 'Billing'],
    ['title "Say \\"hi\\""', 'Say "hi"'],
    ['a -> b', 'Untitled'],
    ['title ""', 'Untitled'],
    ['subtitle "x"', 'Untitled'],
  ])('%j → %s', (source, title) => {
    expect(titleOf(source)).toBe(title);
  });
});

describe('isBlank', () => {
  it('is true for a new diagram, comments and whitespace only', () => {
    expect(isBlank(BLANK_SOURCE)).toBe(true);
    expect(isBlank('')).toBe(true);
    expect(isBlank('  # notes\n\ntitle "X" "Summary"\n')).toBe(true);
  });

  it('is false as soon as anything else is written', () => {
    expect(isBlank('title "X"\napi\n')).toBe(false);
    expect(isBlank('api -> db')).toBe(false);
  });
});
