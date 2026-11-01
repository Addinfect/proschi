import { describe, expect, it } from 'vitest';
import { parse } from './index';
import { diffDiagrams, summarizeDiff, type DiagramDiff } from './diff';

const base = `title "Shop"
web [React]
api "Orders API" [REST API]
db [PostgreSQL]
web -> api : orders
api -> db

usecase "Place order" {
  web -> api : POST /orders
  api -> db : INSERT order
  api --> web : 201
}

traffic {
  "Place order" 100 rps
}

requirements {
  p99 "Place order" < 300ms
  availability >= 99.9%
}
`;

const diagramOf = (source: string) => {
  const { diagram, diagnostics } = parse(source);
  expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  return diagram;
};

const diff = (before: string, after: string) => diffDiagrams(diagramOf(before), diagramOf(after));

/** The diff with items reduced to their keys, for readable expectations. */
function keys(d: DiagramDiff) {
  return {
    nodes: { added: d.nodes.added.map((n) => n.id), removed: d.nodes.removed.map((n) => n.id), changed: d.nodes.changed.map((c) => c.key) },
    edges: { added: d.edges.added.map((e) => e.id), removed: d.edges.removed.map((e) => e.id), changed: d.edges.changed.map((c) => c.key) },
    useCases: { added: d.useCases.added.map((u) => u.id), removed: d.useCases.removed.map((u) => u.id), changed: d.useCases.changed.map((c) => c.key) },
  };
}

describe('diffDiagrams', () => {
  it('is empty for the same diagram, whatever the formatting and comments', () => {
    const reformatted = `# a comment\n${base.replace('web -> api : orders', 'web   ->   api   :   orders').replace(/\n\n/g, '\n\n\n')}`;
    const d = diff(base, reformatted);
    expect(summarizeDiff(d).total).toEqual({ added: 0, removed: 0, changed: 0 });
    expect(d.diagram).toEqual([]);
    expect(d.nodes).toEqual({ added: [], removed: [], changed: [] });
  });

  it('reports added and removed nodes and edges, sorted by key', () => {
    const after = base.replace('db [PostgreSQL]', 'db [PostgreSQL]\ncache [Redis]\naudit [Kafka]').replace('api -> db\n', 'api -> db\napi -> cache\napi -> audit\n').replace('web -> api : orders\n', '');
    const d = diff(base, after);
    expect(keys(d).nodes).toEqual({ added: ['audit', 'cache'], removed: [], changed: [] });
    expect(keys(d).edges).toEqual({ added: ['api->audit', 'api->cache'], removed: ['web->api'], changed: [] });
  });

  it('lists which node attributes changed, old to new', () => {
    const after = base.replace('api "Orders API" [REST API]', 'api "Order Service" [gRPC API] @Orders x3').replace('db [PostgreSQL]', 'db [MySQL]');
    const d = diff(base, after);
    expect(d.nodes.changed.map((c) => c.key)).toEqual(['api', 'db']);
    const api = d.nodes.changed[0].changes;
    expect(api.find((c) => c.field === 'name')).toEqual({ field: 'name', before: 'Orders API', after: 'Order Service' });
    expect(api.find((c) => c.field === 'ownerTeam')).toEqual({ field: 'ownerTeam', before: undefined, after: 'Orders' });
    expect(api.find((c) => c.field === 'replicas')).toEqual({ field: 'replicas', before: undefined, after: 3 });
    expect(d.nodes.changed[1].changes).toContainEqual({ field: 'techStack', before: 'PostgreSQL', after: 'MySQL' });
    // The order of fields is fixed: name before techStack before ownerTeam.
    const fields = api.map((c) => c.field);
    expect(fields.indexOf('name')).toBeLessThan(fields.indexOf('techStack'));
    expect(fields.indexOf('techStack')).toBeLessThan(fields.indexOf('ownerTeam'));
  });

  it('treats a renamed id as a removal and an addition, a renamed name as a change', () => {
    const renamedId = base.replace(/\bdb\b/g, 'store');
    const byId = diff(base, renamedId);
    expect(keys(byId).nodes).toEqual({ added: ['store'], removed: ['db'], changed: [] });
    expect(keys(byId).edges).toEqual({ added: ['api->store'], removed: ['api->db'], changed: [] });
    expect(keys(byId).useCases.changed).toEqual(['place-order']);

    const renamedName = diff(base, base.replace('"Orders API"', '"Orders"'));
    expect(keys(renamedName).nodes).toEqual({ added: [], removed: [], changed: ['api'] });
  });

  it('matches edges by from→to, and by label where a pair has several', () => {
    const relabelled = diff(base, base.replace('web -> api : orders', 'web -> api : place orders'));
    expect(relabelled.edges.changed).toHaveLength(1);
    expect(relabelled.edges.changed[0]).toMatchObject({ key: 'web->api', changes: [{ field: 'label', before: 'orders', after: 'place orders' }] });

    const twice = base.replace('web -> api : orders', 'web -> api : orders\nweb -> api : refunds');
    const added = diff(base, twice);
    expect(added.edges.added.map((e) => e.label)).toEqual(['orders', 'refunds']);
    expect(added.edges.removed.map((e) => e.label)).toEqual(['orders']);
    const swapped = diff(twice, twice.replace('web -> api : orders\nweb -> api : refunds', 'web -> api : refunds\nweb -> api : orders'));
    expect(summarizeDiff(swapped).edges).toEqual({ added: 0, removed: 0, changed: 0 });
  });

  it('compares use case steps as lines', () => {
    const after = base.replace('  api --> web : 201', '  api ->> db : x2 log it\n  api --> web : 202');
    const d = diff(base, after);
    expect(d.useCases.changed).toHaveLength(1);
    expect(d.useCases.changed[0].changes).toEqual([
      {
        field: 'steps',
        before: ['web -> api : POST /orders --> 201', 'api -> db : INSERT order'],
        after: ['web -> api : POST /orders --> 202', 'api -> db : INSERT order', 'api ->> db : x2 log it'],
      },
    ]);
  });

  it('reports renamed use cases as removed and added, and their scenarios', () => {
    const withScenario = base.replace(
      '  api -> db : INSERT order\n  api --> web : 201\n',
      '  alt "In stock" {\n    api -> db : INSERT order\n    api --> web : 201\n  } alt "Out of stock" {\n    api --> web : 409\n  }\n',
    );
    const d = diff(base, withScenario);
    expect(d.scenarios.added.map((s) => `${s.useCase}/${s.scenario.id}`)).toEqual(['place-order/in-stock', 'place-order/out-of-stock']);

    const changed = diff(withScenario, withScenario.replace('409', '410'));
    expect(changed.scenarios.changed.map((c) => c.key)).toEqual(['place-order/out-of-stock']);
    expect(changed.scenarios.changed[0].changes[0]).toMatchObject({ field: 'steps' });

    const renamed = diff(base, base.replace(/Place order/g, 'Checkout'));
    expect(keys(renamed).useCases).toEqual({ added: ['checkout'], removed: ['place-order'], changed: [] });
    expect(renamed.traffic.added.map((t) => t.useCase)).toEqual(['Checkout']);
    expect(renamed.traffic.removed.map((t) => t.useCase)).toEqual(['Place order']);
  });

  it('sees a new limit as a changed requirement, a new constraint as an added one', () => {
    const after = base.replace('< 300ms', '< 200ms').replace('availability >= 99.9%', 'availability >= 99.9%\n  cost <= 500 usd/month');
    const d = diff(base, after);
    expect(d.requirements.changed).toHaveLength(1);
    expect(d.requirements.changed[0]).toMatchObject({ key: 'latency p99 Place order', changes: [{ field: 'maxMs', before: 300, after: 200 }] });
    expect(d.requirements.added).toMatchObject([{ kind: 'cost', maxUsdPerMonth: 500 }]);
    expect(d.requirements.removed).toEqual([]);
  });

  it('reports traffic and capacity changes', () => {
    const after = base.replace('100 rps', '250 rps').replace('requirements {', 'capacity {\n  db 2k rps\n}\n\nrequirements {');
    const d = diff(base, after);
    expect(d.traffic.changed[0]).toMatchObject({ key: 'Place order', changes: [{ field: 'rps', before: 100, after: 250 }] });
    expect(d.capacity.added.map((c) => c.node)).toEqual(['db']);
    const raised = diff(after, after.replace('db 2k rps', 'db 3k rps'));
    expect(raised.capacity.changed[0].changes).toEqual([{ field: 'rps', before: 2000, after: 3000 }]);
  });

  it('reports systems by id, with their source, entry points and stub', () => {
    const org = 'web [React]\nsystem pay "Payments" {\n  expose charge\n  capacity { 1k rps p99 100ms availability 99.9% }\n}\nweb -> pay.charge\n';
    const after = org.replace('1k rps', '2k rps').replace('expose charge', 'expose charge\n  expose refund');
    const d = diff(org, after);
    expect(d.systems.changed.map((c) => c.key)).toEqual(['pay']);
    const changes = d.systems.changed[0].changes;
    expect(changes.map((c) => c.field)).toEqual(['entries', 'stub']);
    expect(changes[0]).toEqual({ field: 'entries', before: ['charge'], after: ['charge', 'refund'] });
    expect(changes[1].before).toMatchObject({ rps: 1000 });
    expect(changes[1].after).toMatchObject({ rps: 2000 });
  });

  it('reports the title and summary', () => {
    const d = diff(base, base.replace('title "Shop"', 'title "Store" "Sells things"'));
    expect(d.diagram).toEqual([
      { field: 'title', before: 'Shop', after: 'Store' },
      { field: 'summary', before: undefined, after: 'Sells things' },
    ]);
  });

  it('is deterministic and symmetric', () => {
    const after = base.replace('db [PostgreSQL]', 'db [MySQL]\nz [Redis]\na [Redis]').replace('100 rps', '5 rps');
    expect(diff(base, after)).toEqual(diff(base, after));
    const forward = summarizeDiff(diff(base, after));
    const back = summarizeDiff(diff(after, base));
    expect(back.total).toEqual({ added: forward.total.removed, removed: forward.total.added, changed: forward.total.changed });
    expect(diff(base, after).nodes.added.map((n) => n.id)).toEqual(['a', 'z']);
  });
});

describe('summarizeDiff', () => {
  it('counts each section and the totals', () => {
    const after = base.replace('db [PostgreSQL]', 'db [MySQL]\ncache [Redis]').replace('web -> api : orders\n', '').replace('title "Shop"', 'title "Store"');
    const counts = summarizeDiff(diff(base, after));
    expect(counts.nodes).toEqual({ added: 1, removed: 0, changed: 1 });
    expect(counts.edges).toEqual({ added: 0, removed: 1, changed: 0 });
    expect(counts.requirements).toEqual({ added: 0, removed: 0, changed: 0 });
    expect(counts.total).toEqual({ added: 1, removed: 1, changed: 2 });
  });
});
