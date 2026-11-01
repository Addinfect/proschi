import { describe, expect, it } from 'vitest';
import { mapResolver, parse, viewDiagram } from './index';
import { layoutGraph } from './autoLayout';

const warehouse = `title "Warehouse"
picker [REST API]
stock [PostgreSQL]
picker -> stock
usecase "Pick" {
  picker -> stock : UPDATE stock
}
`;

const orders = `title "Orders"
direction right
gateway [AWS API Gateway]
group core "Core" {
  api [REST API]
  db [PostgreSQL] pos 10,10
}
gateway -> api
api -> db
system wh "Warehouse" {
  from "warehouse.proschi"
  expose pick
}
api -> wh.pick
usecase "Place order" {
  gateway -> api : POST /orders
  api -> db : INSERT order
  api -> wh.pick : reserve
}
`;

const org = `title "Org"
web [Browser]
system orders "Orders" @Orders {
  from "teams/orders.proschi"
  expose api -> "Place order"
}
web -> orders.api
usecase "Buy" {
  web -> orders.api : buy
}
`;

const files = { 'org.proschi': org, 'teams/orders.proschi': orders, 'teams/warehouse.proschi': warehouse };
const diagram = () => {
  const r = parse(org, { path: 'org.proschi', resolve: mapResolver(files) });
  expect(r.diagnostics).toEqual([]);
  return r.diagram;
};

describe('viewDiagram', () => {
  it('leaves a collapsed diagram as it is: one box per system', () => {
    const d = diagram();
    expect(viewDiagram(d)).toBe(d);
    expect(d.nodes.map((n) => [n.id, n.kind])).toEqual([
      ['web', 'component'],
      ['orders', 'system'],
    ]);
    expect(d.edges).toMatchObject([{ source: 'web', target: 'orders', targetPort: 'api' }]);
  });

  it('expands a system into a frame with its namespaced design, rerouting entry edges', () => {
    const v = viewDiagram(diagram(), { expanded: new Set(['orders']) });
    expect(v.nodes.map((n) => [n.id, n.kind, n.parent ?? null, n.system ?? null])).toEqual([
      ['web', 'component', null, null],
      ['orders', 'group', null, 'orders'],
      ['orders.gateway', 'component', 'orders', 'orders'],
      ['orders.core', 'group', 'orders', 'orders'],
      ['orders.api', 'component', 'orders.core', 'orders'],
      ['orders.db', 'component', 'orders.core', 'orders'],
      ['orders.wh', 'system', 'orders', 'orders'],
    ]);
    // A team position belongs to the team's canvas.
    expect(v.nodes.find((n) => n.id === 'orders.db')!.position).toBeUndefined();
    expect(v.edges.map((e) => [e.source, e.target, e.targetPort ?? null])).toEqual([
      ['orders.gateway', 'orders.api', null],
      ['orders.api', 'orders.db', null],
      ['orders.api', 'orders.wh', 'pick'],
      ['web', 'orders.gateway', null],
    ]);
    // The org step enters the node that receives the team use case's first request.
    expect(v.useCases[0].steps[0]).toMatchObject({ fromServiceId: 'web', toServiceId: 'orders.gateway' });
    expect(v.useCases[0].steps[0].toPort).toBeUndefined();
    expect(v.useCases.map((u) => [u.id, u.name])).toEqual([
      ['buy', 'Buy'],
      ['orders.place-order', 'Orders: Place order'],
    ]);
    // The team's direction and title stay in its scope.
    expect(v.title).toBe('Org');
    expect(v.layout).toBeUndefined();
  });

  it('expands nested systems, following entry points through them', () => {
    const v = viewDiagram(diagram(), { expanded: new Set(['orders', 'orders.wh']) });
    expect(v.nodes.filter((n) => n.id.startsWith('orders.wh')).map((n) => [n.id, n.kind, n.parent])).toEqual([
      ['orders.wh', 'group', 'orders'],
      ['orders.wh.picker', 'component', 'orders.wh'],
      ['orders.wh.stock', 'component', 'orders.wh'],
    ]);
    expect(v.edges.find((e) => e.source === 'orders.api' && e.target.startsWith('orders.wh'))!.target).toBe('orders.wh.picker');
    // Expanding only the inner one does nothing while its parent is collapsed.
    expect(viewDiagram(diagram(), { expanded: new Set(['orders.wh']) }).nodes).toHaveLength(2);
  });

  it("enters past the team's own client stand-in", () => {
    const team = 'user [Browser]\nlb [Load Balancer]\nuser -> lb\nusecase "Go" {\n  user -> lb : GET /\n}\n';
    const src = 'web [Browser]\nsystem t {\n  from "t.proschi"\n  expose go\n}\nweb -> t.go';
    const d = parse(src, { path: 'o.proschi', resolve: mapResolver({ 't.proschi': team }) }).diagram;
    expect(viewDiagram(d, { expanded: new Set(['t']) }).edges.at(-1)).toMatchObject({ source: 'web', target: 't.lb' });
  });

  it('focuses on one system: its own design, ids and title', () => {
    const v = viewDiagram(diagram(), { focus: 'orders' });
    expect(v.title).toBe('Orders');
    expect(v.layout).toEqual({ direction: 'right' });
    expect(v.nodes.map((n) => n.id)).toEqual(['gateway', 'core', 'api', 'db', 'wh']);
    expect(viewDiagram(diagram(), { focus: 'orders.wh' }).title).toBe('Warehouse');
    const nested = viewDiagram(diagram(), { focus: 'orders', expanded: new Set(['orders.wh']) });
    expect(nested.nodes.map((n) => n.id)).toContain('wh.picker');
    expect(viewDiagram(diagram(), { focus: 'nope' }).title).toBe('Org');
  });

  it('lays out collapsed and expanded views', async () => {
    for (const expanded of [new Set<string>(), new Set(['orders', 'orders.wh'])]) {
      const v = viewDiagram(diagram(), { expanded });
      const layout = await layoutGraph(v);
      for (const n of v.nodes) expect(layout.nodes.some((b) => b.id === n.id)).toBe(true);
    }
  });
});
