import { describe, expect, it } from 'vitest';
import { localDate, suggestTag, tagProblem, versionReference } from './versions';

describe('version tags', () => {
  it('suggests today, then .2, .3 … when taken', () => {
    expect(suggestTag([], '2026-11-01')).toBe('2026-11-01');
    expect(suggestTag(['2026-11-01'], '2026-11-01')).toBe('2026-11-01.2');
    expect(suggestTag(['2026-11-01', '2026-11-01.2', 'v1'], '2026-11-01')).toBe('2026-11-01.3');
  });

  it('formats the local date', () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });

  it('checks tags with the backend rule', () => {
    expect(tagProblem('2026-11-01')).toBeNull();
    expect(tagProblem('v2_before-sharding')).toBeNull();
    expect(tagProblem('')).toMatch(/Give/);
    expect(tagProblem('Latest')).toMatch(/reserved/);
    expect(tagProblem('-v1')).toMatch(/starting with/);
    expect(tagProblem('a b')).toMatch(/letters/);
    expect(tagProblem('x'.repeat(65))).toMatch(/64/);
  });

  it('makes the cloud reference, or none for a name with a space', () => {
    expect(versionReference('orders.proschi', '2026-11-01')).toBe('cloud:orders:2026-11-01');
    expect(versionReference('teams/orders.proschi', 'v1')).toBe('cloud:teams/orders:v1');
    expect(versionReference('my orders.proschi', 'v1')).toBeNull();
    expect(versionReference('orders:v2.proschi', 'v1')).toBeNull();
    expect(versionReference('teams//orders.proschi', 'v1')).toBeNull();
    expect(versionReference('../orders.proschi', 'v1')).toBeNull();
    // It would name orders.proschi, another diagram.
    expect(versionReference('orders.proschi.proschi', 'v1')).toBeNull();
  });
});
