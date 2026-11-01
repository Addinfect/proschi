import { describe, expect, it } from 'vitest';
import { parse } from '../../dsl';
import { viewDiagram } from '../../dsl/view';
import { analyze, contractOf, formatRps, runTests } from '../../sim';
import { filesResolver } from '../../playground/imports';
import { DRONE_ORG_PATH, DRONE_TEAM_FILES, droneOrgSource } from '../../playground/droneStartup';
import { scopeAt, systemSummaries } from './systemSummary';

const drone = (rps: number) => {
  const files = { ...DRONE_TEAM_FILES };
  const r = parse(droneOrgSource(rps), { path: DRONE_ORG_PATH, resolve: filesResolver(files, DRONE_ORG_PATH) });
  expect(r.diagnostics).toEqual([]);
  const analysis = analyze(r.diagram);
  return { diagram: r.diagram, analysis, results: runTests(r.diagram, analysis) };
};

describe('system boxes', () => {
  it('shows each team promise and headroom, all ok at low traffic', () => {
    const { diagram, analysis, results } = drone(100);
    const s = systemSummaries(diagram, analysis, results, diagram, '');
    expect([...s.keys()]).toEqual(['frontend', 'orders', 'warehouse', 'feed', 'payments']);
    const orders = s.get('orders')!;
    expect(orders).toMatchObject({ status: 'ok', label: 'OK', linked: true, file: 'teams/orders.proschi', stub: false, promise: 'p99 < 150 ms · ≥ 99.9%' });
    expect(orders.ports).toMatchObject([{ id: 'api', name: 'Orders API', useCase: 'Place order', sentRps: 100 }]);
    expect(orders.headroom!.text).toMatch(/^100 \/ .* rps$/);
    expect(orders.headroom!.ratio).toBeLessThan(0.7);
    expect(s.get('payments')).toMatchObject({ status: 'ok', linked: false, stub: true, promise: 'p99 < 120 ms · ≥ 99.95%', headroom: { text: '100 / 5k rps' } });
    expect(analysis.warnings).toEqual([]);
  });

  it('turns Orders red with the hint when the frontend sends past its headroom', () => {
    const low = drone(100);
    const limit = contractOf(low.diagram.systems!.find((s) => s.id === 'orders')!).entries[0].saturatesAtRps;
    const { diagram, analysis, results } = drone(Math.ceil(limit * 1.5));
    const s = systemSummaries(diagram, analysis, results, diagram, '');
    const orders = s.get('orders')!;
    expect(orders.status).toBe('over');
    expect(orders.label).toBe('Saturated');
    expect(orders.hint).toBe('Send it less, or ask the Orders team to add capacity for it (their bottleneck is db)');
    expect(orders.warnings[0]).toMatch(/^'orders' cannot take what it is sent/);
    expect(orders.headroom!.ratio).toBeGreaterThan(1);
    // The tooltip, in short: a headline and one line per finding.
    expect(orders.tip.headline).toMatch(/^Saturated · db at \d+%$/);
    expect(orders.tip.lines).toEqual([`You send ${formatRps(Math.ceil(limit * 1.5))}`, `Takes at most ${formatRps(limit)} before db saturates`, 'p99 of "Place order" < 150 ms broken', 'availability of "Place order" ≥ 99.9% broken'].slice(0, orders.tip.lines.length));
    expect(orders.tip.lines.length).toBeGreaterThanOrEqual(3);
    // The other teams still hold.
    expect(s.get('frontend')!.status).toBe('ok');
  });

  it('runs hot between 70% and saturation', () => {
    const low = drone(100);
    const api = contractOf(low.diagram.systems!.find((s) => s.id === 'orders')!).entries[0];
    const { diagram, analysis, results } = drone(Math.ceil(api.hotAtRps * 1.05));
    expect(systemSummaries(diagram, analysis, results, diagram, '').get('orders')).toMatchObject({ status: 'hot', label: 'Runs hot', hint: 'Ask the Orders team before you send it more' });
  });

  it('summarises boxes inside an expanded or focused team design under the load it is sent', () => {
    const { diagram, analysis, results } = drone(100);
    const expanded = viewDiagram(diagram, { expanded: new Set(['orders']) });
    const s = systemSummaries(diagram, analysis, results, expanded, '');
    // The frame of an expanded system is summarised too, for its header.
    expect(s.get('orders')).toMatchObject({ path: 'orders', status: 'ok' });
    const scope = scopeAt(diagram, analysis, 'orders')!;
    expect(scope.diagram.title).toBe('Order Processing');
    // Its own 300 rps plus the 100 the org sends.
    expect(scope.analysis.useCases[0].rps).toBe(400);
    expect(scopeAt(diagram, analysis, 'payments')).toBeUndefined();
  });
});
