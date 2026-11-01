import { describe, expect, it } from 'vitest';
import { mapResolver, parse } from '../dsl';
import type { Diagram } from '../dsl/types';
import { analyze, contractOf, formatRps, runTests } from './index';
import { usageText } from './analyze';

/**
 * A team design of about `fill + 6` nodes: an entry gateway, an API, a
 * database, and `fill` services with caches that the entry use case does not
 * touch (they only make the file big, like a real team design).
 */
function teamFile(title: string, useCase: string, own: number, opts: { fill: number; p99?: number; apiReplicas?: number; reads?: boolean; extra?: string }): string {
  const lines = [`title "${title}"`, 'direction right', 'gateway [AWS API Gateway] x2', `api [REST API] x${opts.apiReplicas ?? 3}`, `db [PostgreSQL] x${opts.reads ? 6 : 2}`, 'gateway -> api', 'api -> db'];
  for (let i = 1; i <= opts.fill / 2; i++) lines.push(`svc${i} [Service] x2`, `cache${i} [Redis]`, `api -> svc${i}`, `svc${i} -> cache${i}`);
  lines.push(`usecase "${useCase}" {`, `  gateway -> api : POST /${slugOf(useCase)}`, opts.reads ? '  api -> db : SELECT row' : '  api -> db : INSERT row', '  api --> gateway : 201', '}');
  lines.push('usecase "Background" {', '  api -> svc1 : refresh', '  svc1 -> cache1 : GET key', '}');
  lines.push('traffic {', `  "${useCase}" ${own} rps`, '  "Background" 100 rps', '}');
  if (opts.p99) lines.push('requirements {', `  p99 "${useCase}" < ${opts.p99}ms`, '}');
  if (opts.extra) lines.push(opts.extra);
  return lines.join('\n') + '\n';
}

const slugOf = (s: string) => s.toLowerCase().replace(/\s+/g, '-');

/** The drone startup: four teams of about 75 nodes each, and an org diagram of one box per team. */
function droneFiles(buyRps: number): Record<string, string> {
  return {
    'teams/frontend.proschi': teamFile('Frontend', 'Open shop', 2000, { fill: 72, p99: 300, apiReplicas: 10, reads: true }),
    'teams/orders.proschi': teamFile('Orders', 'Place order', 300, { fill: 72, p99: 150 }),
    'teams/warehouse.proschi': teamFile('Warehouse', 'Reserve stock', 200, { fill: 72, p99: 200 }),
    'teams/feed.proschi': teamFile('Feed', 'Publish event', 500, { fill: 72 }),
    'org.proschi': `title "Drone startup"
shopper [Browser]
system frontend "Frontend" @Frontend {
  from "teams/frontend.proschi"
  expose web -> "Open shop"
}
system orders "Order Processing" @Orders {
  from "teams/orders.proschi"
  expose api "Orders API" -> "Place order"
}
system warehouse "Warehouse" @Warehouse {
  from "teams/warehouse.proschi"
  expose stock -> "Reserve stock"
}
system feed "Feed" @Feed {
  from "teams/feed.proschi"
  expose events -> "Publish event"
}
shopper -> frontend.web
frontend -> orders.api
orders -> warehouse.stock
orders -> feed.events
usecase "Buy drone" {
  shopper -> frontend.web : open shop
  frontend -> orders.api : place order
  orders -> warehouse.stock : reserve
  orders ->> feed.events : order placed
  orders --> frontend : 201
  frontend --> shopper : 200
}
traffic {
  "Buy drone" ${buyRps} rps
}
requirements {
  p99 "Buy drone" < 800ms
}
`,
  };
}

const parseDrone = (buyRps: number) => {
  const files = droneFiles(buyRps);
  const r = parse(files['org.proschi'], { path: 'org.proschi', resolve: mapResolver(files) });
  expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return r.diagram;
};

const countNodes = (d: Diagram): number => d.nodes.length + (d.systems ?? []).reduce((sum, s) => sum + (s.diagram ? countNodes(s.diagram) : 0), 0);

describe('systems in the simulation', () => {
  it('derives the contract from the team file: promise and headroom', () => {
    const diagram = parseDrone(100);
    const orders = diagram.systems!.find((s) => s.id === 'orders')!;
    const contract = contractOf(orders);
    expect(contract.source).toBe('design');
    const [api] = contract.entries;
    expect(api).toMatchObject({ entry: 'api', useCase: 'Place order', ownRps: 300, latency: [{ percentile: 99, maxMs: 150 }], bottleneck: 'db' });
    // Computed once per parsed system.
    expect(contractOf(orders)).toBe(contract);

    // The headroom is where the team design saturates when that much is added to its own traffic.
    const team = orders.diagram!;
    const at = (extra: number) => analyze({ ...team, traffic: team.traffic!.map((t) => (t.useCase === 'Place order' ? { ...t, rps: t.rps + extra } : t)) });
    const db = (a: ReturnType<typeof analyze>) => a.nodes.find((n) => n.id === 'db')!;
    expect(db(at(api.saturatesAtRps * 0.999)).saturated).toBe(false);
    expect(db(at(api.saturatesAtRps * 1.001)).saturated).toBe(true);
    expect(db(at(api.hotAtRps * 1.001)).utilization).toBeGreaterThan(0.7);
    expect(api.hotAtRps).toBeLessThan(api.saturatesAtRps);
  });

  it('keeps team scopes apart: same ids in every team file, no leaks into the org', () => {
    const diagram = parseDrone(100);
    expect(countNodes(diagram)).toBeGreaterThanOrEqual(300);
    expect(diagram.nodes.map((n) => n.id)).toEqual(['shopper', 'frontend', 'orders', 'warehouse', 'feed']);
    expect(diagram.title).toBe('Drone startup');
    expect(diagram.traffic).toHaveLength(1);
    const a = analyze(diagram);
    // Only org-level components are org nodes; each team's db is analysed in its own scope.
    expect(a.nodes.map((n) => n.id)).toEqual(['shopper']);
    expect(a.systems!.map((s) => s.analysis!.nodes.length)).toEqual([75, 75, 75, 75]);
  });

  it('reports nothing at low traffic and passes the system checks', () => {
    const diagram = parseDrone(100);
    const a = analyze(diagram);
    expect(a.warnings).toEqual([]);
    const orders = a.systems!.find((s) => s.id === 'orders')!;
    expect(orders.inbound).toEqual([{ entry: 'api', rps: 100 }]);
    expect(orders.saturated).toBe(false);
    const results = runTests(diagram, a);
    expect(results.filter((r) => r.id.startsWith('system:')).map((r) => [r.id, r.passed])).toEqual([
      ['system:frontend', true],
      ['system:orders', true],
      ['system:warehouse', true],
      ['system:feed', true],
    ]);
    // The org p99 includes each team's simulated latency.
    const buy = a.useCases[0];
    const teamP99 = (id: string) => a.systems!.find((s) => s.id === id)!.entries[0].p99Ms;
    expect(buy.percentiles.p99).toBeGreaterThan(Math.max(teamP99('frontend'), teamP99('orders')));
  });

  it('tells you when more traffic through the frontend makes Orders saturate and break its p99', () => {
    const low = parseDrone(100);
    const headroom = contractOf(low.systems!.find((s) => s.id === 'orders')!).entries[0].saturatesAtRps;
    const diagram = parseDrone(Math.ceil(headroom * 1.5));
    const a = analyze(diagram);
    const orders = a.systems!.find((s) => s.id === 'orders')!;
    expect(orders.saturated).toBe(true);
    expect(orders.busiest).toBe('db');
    expect(orders.breaches.map((b) => b.requirement)).toEqual(['p99 of "Place order" < 150 ms']);
    const mine = a.warnings.filter((w) => w.startsWith("'orders'"));
    expect(mine[0]).toMatch(/^'orders' cannot take what it is sent: you send .* rps into "Place order" \(orders\.api\); it takes at most .* rps before its db saturates\. Its db is at writes .* rps of .* rps, \d+%\.$/);
    expect(mine[1]).toMatch(/^'orders' breaks its SLA under what it is sent: p99 of "Place order": db is saturated/);
    const result = runTests(diagram, a).find((r) => r.id === 'system:orders')!;
    expect(result).toMatchObject({ passed: false, category: 'latency' });
    expect(result.hint).toBe('Send it less, or ask the Orders team to add capacity for it (their bottleneck is db)');
    // The frontend's own design still holds.
    expect(a.systems!.find((s) => s.id === 'frontend')!.saturated).toBe(false);
  });

  it('exposes the load on each node of a team design under the combined load', () => {
    const low = analyze(parseDrone(100)).systems!.find((s) => s.id === 'orders')!;
    const headroom = contractOf(parseDrone(100).systems!.find((s) => s.id === 'orders')!).entries[0].saturatesAtRps;
    const high = analyze(parseDrone(Math.ceil(headroom * 1.5))).systems!.find((s) => s.id === 'orders')!;
    // Same shape as the canvas overlay of any diagram, by the team's own ids.
    expect(Object.keys(high.overlay!.nodes)).toHaveLength(75);
    expect(high.overlay!.nodes.db).toMatchObject({ saturated: true });
    expect(high.overlay!.nodes.db.utilization).toBeCloseTo(high.analysis!.nodes.find((n) => n.id === 'db')!.utilization, 9);
    expect(low.overlay!.nodes.db).toMatchObject({ saturated: false });
    expect(low.overlay!.nodes.db.utilization!).toBeLessThan(high.overlay!.nodes.db.utilization!);
    // The flows include what the org sends in: 300 own + 100 sent on gateway -> api.
    expect(low.overlay!.flows.find((f) => f.from === 'gateway' && f.to === 'api')!.rps).toBeCloseTo(400, 6);
  });

  it('warns when a system runs hot', () => {
    const low = parseDrone(100);
    const api = contractOf(low.systems!.find((s) => s.id === 'orders')!).entries[0];
    const a = analyze(parseDrone(Math.ceil((api.hotAtRps + api.saturatesAtRps) / 2)));
    expect(a.warnings.filter((w) => w.startsWith("'orders'"))[0]).toMatch(/^'orders' runs hot under what it is sent: you send .* rps into "Place order" \(orders\.api\); it runs hot past .* rps\. Its db is at writes .* rps of .* rps, \d+%\.$/);
  });

  it('works when my team file calls theirs as a nested system', () => {
    const orders = teamFile('Orders', 'Place order', 300, { fill: 10, p99: 150 });
    const frontend = (rps: number) =>
      teamFile('Frontend', 'Open shop', rps, {
        fill: 10,
        extra: 'system orders @Orders {\n  from "orders.proschi"\n  expose api -> "Place order"\n}\napi -> orders.api\nusecase "Checkout" {\n  gateway -> api : POST /checkout\n  api -> orders.api : place order\n}\ntraffic {\n  "Checkout" ' + rps + ' rps\n}',
      });
    const run = (rps: number) => {
      const files = { 'teams/frontend.proschi': frontend(rps), 'teams/orders.proschi': orders };
      const r = parse(files['teams/frontend.proschi'], { path: 'teams/frontend.proschi', resolve: mapResolver(files) });
      expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      return analyze(r.diagram);
    };
    expect(run(100).warnings.filter((w) => w.startsWith("'orders'"))).toEqual([]);
    expect(run(20_000).warnings.filter((w) => w.startsWith("'orders'"))[0]).toMatch(/^'orders' cannot take what it is sent/);
  });

  it('adds up what every system using the same team file sends into it', () => {
    const headroom = contractOf(parseDrone(100).systems!.find((s) => s.id === 'orders')!).entries[0].saturatesAtRps;
    // The Frontend design calls Orders itself too, as a nested system of the same file.
    const checkout = (rps: number) =>
      'system orders @Orders {\n  from "orders.proschi"\n  expose api -> "Place order"\n}\napi -> orders.api\nusecase "Checkout" {\n  gateway -> api : POST /checkout\n  api -> orders.api : place order\n}\ntraffic {\n  "Checkout" ' + rps + ' rps\n}';
    const run = (org: number, frontend: number) => {
      const files: Record<string, string> = { ...droneFiles(org), 'teams/frontend.proschi': teamFile('Frontend', 'Open shop', 2000, { fill: 72, p99: 300, apiReplicas: 10, reads: true, extra: frontend > 0 ? checkout(frontend) : '' }) };
      const r = parse(files['org.proschi'], { path: 'org.proschi', resolve: mapResolver(files) });
      expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      const a = analyze(r.diagram);
      const top = a.systems!.find((s) => s.id === 'orders')!;
      const nested = a.systems!.find((s) => s.id === 'frontend')!.analysis!.systems?.find((s) => s.id === 'orders');
      return { a, top, nested };
    };
    const share = Math.round(headroom * 0.6);
    // Either caller alone fits.
    expect(run(share, 0).top.saturated).toBe(false);
    const alone = run(1, share).nested!;
    expect(alone.saturated).toBe(false);

    const { a, top, nested } = run(share, share);
    // One design under both callers' load, analysed once.
    expect(top.analysis).toBe(nested!.analysis);
    expect(top.saturated).toBe(true);
    expect(nested!.saturated).toBe(true);
    expect(top.totalInboundRps).toBeCloseTo(share, 6);
    expect(top.sharedInboundRps).toBeCloseTo(2 * share, 6);
    expect(top.callers).toEqual([
      { path: 'orders', from: 'Drone startup', rps: share },
      { path: 'frontend.orders', from: 'Frontend', rps: share },
    ]);
    expect(top.overlay!.nodes.db.saturated).toBe(true);
    const fmt = (x: number) => formatRps(x).replace(/ rps$/, '');
    expect(a.warnings.find((w) => w.startsWith("'orders' cannot"))).toBe(
      `'orders' cannot take what it is sent: you send ${fmt(share)} of the ${formatRps(2 * share)} it gets into "Place order" (orders.api); it takes at most ${formatRps(headroom)} before its db saturates. Its db is at ${usageText(top.analysis!.nodes.find((n) => n.id === 'db')!)}.`,
    );
    expect(nested!.warnings[0]).toMatch(new RegExp(`^'orders' cannot take what it is sent: you send ${fmt(share)} of the ${formatRps(2 * share)} it gets into "Place order"`));
  });

  it('uses the capacity stub of a system without a team file', () => {
    const src = (rps: number) => `user [Browser]
system pay "Payments" @Payments {
  expose charge
  capacity { 2k rps p99 120ms availability 99.9% }
}
user -> pay.charge
usecase "Pay" {
  user -> pay.charge : charge
}
traffic {
  "Pay" ${rps} rps
}`;
    const okDiagram = parse(src(1000)).diagram;
    const ok = analyze(okDiagram);
    expect(ok.warnings).toEqual([]);
    // The stub's rate is all it takes, not extra on top of anything.
    expect(runTests(okDiagram, ok).find((r) => r.id === 'system:pay')).toMatchObject({ passed: true, message: "'pay' takes 1k rps and holds its requirements; it takes at most 2k rps" });
    expect(ok.useCases[0].percentiles.p99).toBeCloseTo(120, 6);
    expect(ok.useCases[0].availability).toBeCloseTo(0.999, 9);
    expect(contractOf(parse(src(1)).diagram.systems![0]).entries[0]).toMatchObject({ saturatesAtRps: 2000, hotAtRps: 1400, latency: [{ maxMs: 120 }], availabilityPercent: 99.9 });
    expect(analyze(parse(src(1500)).diagram).warnings).toEqual(["'pay' runs hot under what it is sent: you send 1.5k rps into pay.charge; it runs hot past 1.4k rps and takes at most 2k rps."]);
    const over = parse(src(3000)).diagram;
    const a = analyze(over);
    expect(a.warnings).toEqual(["'pay' cannot take what it is sent: you send 3k rps into pay.charge; it takes at most 2k rps."]);
    expect(runTests(over, a).find((r) => r.id === 'system:pay')).toMatchObject({ passed: false, hint: 'Send it less, or ask the Payments team to add capacity for it' });
  });

  it('analyses the drone startup quickly', () => {
    const diagram = parseDrone(100);
    analyze(diagram); // warm up
    const runs = 10;
    const start = performance.now();
    for (let i = 0; i < runs; i++) {
      // A fresh parse each time, as the editor does, so the contract cache does not help.
      const fresh = { ...diagram, systems: diagram.systems!.map((s) => ({ ...s })) };
      analyze(fresh);
    }
    const ms = (performance.now() - start) / runs;
    console.log(`analyze() on the drone startup (${countNodes(diagram)} nodes): ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(200);
  });
});
