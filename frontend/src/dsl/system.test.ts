import { describe, expect, it } from 'vitest';
import { mapResolver, parse } from './index';

const orders = `title "Orders team"
direction right
gateway [AWS API Gateway]
api "Orders API" [REST API]
db [PostgreSQL]
gateway -> api
api -> db
traffic {
  "Place order" 500 rps
}
requirements {
  p99 "Place order" < 150ms
}
usecase "Place order" {
  gateway -> api : POST /orders
  api -> db : INSERT order
  api --> gateway : 201
}
usecase "Get order" {
  gateway -> api : GET /orders/1
  api -> db : SELECT order
}
`;

const org = `title "Drone startup"
web "Web app" [Browser]
db [Redis]
system orders "Order Processing" @Orders {
  from "teams/orders.proschi"
  expose api "Orders API" -> "Place order"
  expose read -> "Get order"
}
web -> orders.api : place order
web -> db
usecase "Buy drone" {
  web -> orders.api : POST /orders
  orders --> web : 201
}
`;

const parseOrg = (files: Record<string, string>, root = 'org.proschi') => parse(files[root], { path: root, resolve: mapResolver(files) });
const messages = (r: ReturnType<typeof parse>) => r.diagnostics.map((d) => `${d.severity}: ${d.message}`);

describe('system', () => {
  it('parses a system whose team file has its own scope', () => {
    const r = parseOrg({ 'org.proschi': org, 'teams/orders.proschi': orders });
    expect(messages(r)).toEqual([]);
    const { diagram } = r;
    // The team's own db does not clash with the org's db, and its title, direction and traffic do not leak.
    expect(diagram.title).toBe('Drone startup');
    expect(diagram.layout).toBeUndefined();
    expect(diagram.traffic).toBeUndefined();
    expect(diagram.requirements).toBeUndefined();
    expect(diagram.nodes.map((n) => [n.id, n.kind])).toEqual([
      ['web', 'component'],
      ['db', 'component'],
      ['orders', 'system'],
    ]);
    expect(diagram.nodes[2]).toMatchObject({ name: 'Order Processing', ownerTeam: 'Orders' });
    const [system] = diagram.systems!;
    expect(system).toMatchObject({ id: 'orders', from: 'teams/orders.proschi', resolved: 'teams/orders.proschi' });
    expect(system.entries.map((e) => [e.id, e.name, e.useCaseId])).toEqual([
      ['api', 'Orders API', 'place-order'],
      ['read', 'read', 'get-order'],
    ]);
    expect(system.diagram!.title).toBe('Orders team');
    expect(system.diagram!.traffic?.[0].rps).toBe(500);
    expect(system.diagram!.nodes.map((n) => n.id)).toEqual(['gateway', 'api', 'db']);
    // Locations inside the team file carry its path.
    expect(system.diagram!.nodes[0].loc.file).toBe('teams/orders.proschi');
    expect(diagram.edges[0]).toMatchObject({ source: 'web', target: 'orders', targetPort: 'api' });
    const step = diagram.useCases[0].steps[0];
    expect(step).toMatchObject({ fromServiceId: 'web', toServiceId: 'orders', toPort: 'api', responseLoc: { line: 13 } });
  });

  it('errors on edges to internals that are not exposed, and on unknown entry points', () => {
    const src = org.replace('web -> db', 'web -> orders.db\nweb -> orders.nope');
    const r = parseOrg({ 'org.proschi': src, 'teams/orders.proschi': orders });
    expect(messages(r)).toEqual([
      `error: 'db' is inside system 'orders' but is not an entry point; only entry points are reachable from outside: add expose db -> "Use case"; connect to orders.api or orders.read`,
      "error: System 'orders' has no entry point 'nope'; connect to orders.api or orders.read",
    ]);
    // No implicit node is made for orders.db.
    expect(r.diagram.nodes.some((n) => n.id.includes('.'))).toBe(false);
  });

  it('keeps b.tag on a connection to a non-system as a tag', () => {
    const r = parse('legend {\n  planned "Planned" dashed\n}\na -> b.planned');
    expect(messages(r)).toEqual([]);
    expect(r.diagram.edges[0]).toMatchObject({ source: 'a', target: 'b', tag: 'planned' });
    expect(messages(parse('usecase "U" {\n  a -> b.x : go\n}'))).toEqual(["error: 'b' is not a system, so 'b.x' names nothing; write b, or declare system b { … }"]);
  });

  it('checks expose against the team use cases', () => {
    const src = org.replace('-> "Place order"', '-> "Place ordr"').replace('  expose read -> "Get order"\n', '  expose read\n');
    expect(messages(parseOrg({ 'org.proschi': src, 'teams/orders.proschi': orders }))).toEqual([
      'error: orders.proschi has no use case "Place ordr". Did you mean "Place order"?',
      `error: Say which use case 'read' enters, e.g. expose read -> "Place order"`,
    ]);
    // With a single use case the mapping may be left out.
    const single = orders.slice(0, orders.indexOf('usecase "Get order"'));
    const r = parseOrg({ 'org.proschi': src.replace('-> "Place ordr"', ''), 'teams/orders.proschi': single });
    expect(messages(r)).toEqual([]);
    expect(r.diagram.systems![0].entries.map((e) => e.useCaseId)).toEqual(['place-order', 'place-order']);
  });

  it('reads a capacity stub on one line or several, and warns when a file is given too', () => {
    const one = parse('system pay "Payments" {\n  expose charge\n  capacity { 2k rps p99 150ms availability 99.95% }\n}\nweb -> pay.charge');
    expect(messages(one)).toEqual([]);
    expect(one.diagram.systems![0].stub).toMatchObject({ rps: 2000, p99Ms: 150, availability: 99.95 });
    const many = parse('system pay {\n  expose charge\n  capacity {\n    500 rps\n    latency 20ms\n  }\n}');
    expect(messages(many)).toEqual([]);
    expect(many.diagram.systems![0].stub).toMatchObject({ rps: 500, latencyMs: 20 });
    expect(messages(parse('system pay {\n  capacity { fast }\n}'))[0]).toMatch(/Expected a rate, p99, latency or availability/);

    const both = org.replace('  expose read -> "Get order"\n', '  expose read -> "Get order"\n  capacity { 1k rps }\n');
    const r = parseOrg({ 'org.proschi': both, 'teams/orders.proschi': orders });
    expect(messages(r)).toEqual(["warning: System 'orders' has a from file, which sets its contract; this capacity is ignored"]);
    expect(r.diagram.systems![0].stub).toBeUndefined();
    expect(messages(parse('system pay {\n  expose charge\n}'))).toEqual([`warning: System 'pay' has no from "file" and no capacity { … }; it is drawn but not simulated`]);
  });

  it('reports problems of the team file with its path, and a missing file', () => {
    const broken = orders.replace('db [PostgreSQL]', 'db [PostgreSQL]\napi');
    const r = parseOrg({ 'org.proschi': org, 'teams/orders.proschi': broken });
    expect(r.diagnostics).toMatchObject([{ severity: 'error', file: 'teams/orders.proschi', line: 6 }]);
    const missing = parseOrg({ 'org.proschi': org });
    expect(messages(missing)).toEqual(["error: Cannot find 'teams/orders.proschi'"]);
    expect(messages(parse(org))[0]).toBe("warning: Files are not resolved in this context; 'teams/orders.proschi' was not loaded");
  });

  it('allows nested systems and finds cycles through from and import', () => {
    const warehouse = 'title "Warehouse"\nusecase "Pick" {\n  api -> db : pick\n}\n';
    const nested = `${orders}system wh {\n  from "warehouse.proschi"\n  expose pick\n}\napi -> wh.pick\n`;
    const r = parseOrg({ 'org.proschi': org, 'teams/orders.proschi': nested, 'teams/warehouse.proschi': warehouse });
    expect(messages(r)).toEqual([]);
    const inner = r.diagram.systems![0].diagram!.systems![0];
    expect(inner).toMatchObject({ id: 'wh', resolved: 'teams/warehouse.proschi' });

    const cyclic = `${orders}system again {\n  from "../org.proschi"\n  expose x\n}\n`;
    const c = parseOrg({ 'org.proschi': org, 'teams/orders.proschi': cyclic });
    expect(messages(c)).toContain('error: System cycle: org.proschi → orders.proschi → org.proschi');

    const self = `${orders}system me {\n  from "orders.proschi"\n}\n`;
    expect(messages(parseOrg({ 'org.proschi': org, 'teams/orders.proschi': self }))).toContain('error: System cycle: orders.proschi → orders.proschi');
  });

  it('parses a team file used by two systems once', () => {
    let reads = 0;
    const files: Record<string, string> = { 'org.proschi': `${org}system orders2 {\n  from "teams/orders.proschi"\n  expose api -> "Place order"\n}\n`, 'teams/orders.proschi': orders };
    const base = mapResolver(files);
    const r = parse(files['org.proschi'], {
      path: 'org.proschi',
      resolve: (p, from) => {
        reads++;
        return base(p, from);
      },
    });
    expect(messages(r)).toEqual([]);
    expect(reads).toBe(2);
    expect(r.diagram.systems![0].diagram).toBe(r.diagram.systems![1].diagram);
  });

  it('needs a named entry point for a step to a system with several', () => {
    const src = org.replace('web -> orders.api : POST /orders', 'web -> orders : POST /orders');
    expect(messages(parseOrg({ 'org.proschi': src, 'teams/orders.proschi': orders }))).toEqual([
      "error: Say which entry point of 'orders' this step enters: orders.api or orders.read",
    ]);
  });

  it('still reads system as a node id', () => {
    const r = parse('system [Service]\nsystem -> db');
    expect(messages(r)).toEqual([]);
    expect(r.diagram.nodes[0]).toMatchObject({ id: 'system', kind: 'component' });
  });

  it('reports a system left open and misplaced lines', () => {
    expect(messages(parse('system pay {\n  expose charge\n  capacity { 1k rps }'))).toEqual(["error: Missing } to close system 'pay'"]);
    expect(messages(parse('system pay {\n  a -> b\n  capacity { 1k rps }\n}'))[0]).toMatch(/^error: Inside a system, write from/);
  });
});
