import { describe, expect, it } from 'vitest';
import { ecommerceExample, parse, parseStepLabel, toCanvas } from './index';

const errors = (src: string) => parse(src).diagnostics.filter((d) => d.severity === 'error');
const warnings = (src: string) => parse(src).diagnostics.filter((d) => d.severity === 'warning');

describe('example document', () => {
  const { diagram, diagnostics } = parse(ecommerceExample);

  it('parses without diagnostics', () => {
    expect(diagnostics).toEqual([]);
  });

  it('reads title, nodes, groups and edges', () => {
    expect(diagram.title).toBe('E-Commerce Platform');
    expect(diagram.nodes.map((n) => n.id)).toEqual(['vpc', 'gateway', 'orders', 'users', 'ordersDb', 'usersDb', 'events']);
    expect(diagram.edges).toHaveLength(6);

    const orders = diagram.nodes.find((n) => n.id === 'orders')!;
    expect(orders).toMatchObject({
      name: 'Order Service',
      type: 'service',
      techStack: 'REST API',
      ownerTeam: 'Orders',
      description: 'Handles order processing',
      parent: 'vpc',
    });
    expect(diagram.nodes.find((n) => n.id === 'vpc')).toMatchObject({ kind: 'group', techStack: 'Logical Group' });
    expect(diagram.nodes.find((n) => n.id === 'events')).toMatchObject({ type: 'broker', parent: undefined });
  });

  it('builds use case steps with responses and parallel groups', () => {
    const [useCase] = diagram.useCases;
    expect(useCase).toMatchObject({ id: 'create-order', name: 'Create order', entryServiceId: 'gateway' });
    expect(useCase.steps.map((s) => s.stepName)).toEqual(['POST /api/orders', 'GET /api/users/user123', 'INSERT order', 'OrderCreated']);

    const [create, getUser, insert, publish] = useCase.steps;
    expect(create).toMatchObject({ httpMethod: 'POST', endpoint: '/api/orders', protocol: 'REST', statusCode: 201, requestFormat: 'JSON' });
    expect(JSON.parse(create.requestBody!)).toEqual({ userId: 'user123', items: [{ productId: 'prod-1', quantity: 2 }] });
    expect(JSON.parse(create.responseBody!)).toEqual({ orderId: 'order-789', status: 'pending' });

    expect(getUser).toMatchObject({ protocol: 'GRAPHQL', statusCode: 200, responseBody: '{"verified": true}' });
    expect(insert).toMatchObject({ protocol: 'OTHER', isParallel: true, parallelGroup: 1, executionType: 'SYNC_REQUEST_RESPONSE' });
    expect(publish).toMatchObject({ protocol: 'MESSAGING', isParallel: true, parallelGroup: 1, executionType: 'ASYNC_FIRE_AND_FORGET' });
    expect(useCase.steps.map((s) => s.stepOrder)).toEqual([0, 1, 2, 3]);
  });

  it('converts to canvas nodes', () => {
    const { nodes, edges } = toCanvas(diagram);
    expect(nodes.find((n) => n.id === 'vpc')?.type).toBe('groupNode');
    expect(nodes.find((n) => n.id === 'gateway')).toMatchObject({ type: 'componentNode', data: { name: 'API Gateway' } });
    expect(new Set(nodes.map((n) => `${n.position.x},${n.position.y}`)).size).toBe(nodes.length);
    expect(edges[0]).toEqual({ id: 'gateway->orders', source: 'gateway', target: 'orders', label: 'HTTP' });
  });
});

describe('nodes', () => {
  it('matches tech stacks case-insensitively', () => {
    const [node] = parse('db [postgresql]').diagram.nodes;
    expect(node.techStack).toBe('PostgreSQL');
    expect(node.type).toBe('database');
  });

  it.each([
    ['S3', 'AWS S3', 'storage'],
    ['amazon s3', 'AWS S3', 'storage'],
    ['Postgres', 'PostgreSQL', 'database'],
    ['PostgreSQL 16', 'PostgreSQL', 'database'],
    ['redis 7.2', 'Redis', 'database'],
    ['Route 53', 'AWS Route53', 'cdn'],
    ['pubsub', 'GCP Pub/Sub', 'broker'],
    ['NodeJS', 'Node.js', 'service'],
    ['ALB', 'AWS Load Balancer', 'cdn'],
    ['k8s', 'Kubernetes', 'container'],
    ['Golang', 'Go', 'service'],
  ])('resolves the alias [%s] to %s', (written, tech, type) => {
    const { diagram, diagnostics } = parse(`n [${written}]`);
    expect(diagnostics).toEqual([]);
    expect(diagram.nodes[0]).toMatchObject({ techStack: tech, type });
    expect(diagram.nodes[0].inferredKind).toBeUndefined();
  });

  it('keeps an unknown tech as written, simulated as the kind its name suggests, with a warning', () => {
    const { diagram, diagnostics } = parse('x [Cobol Mainframe]\nl [TigerBeetle DB]\nq [Acme Queue]');
    expect(diagram.nodes.map((n) => [n.techStack, n.type, n.inferredKind])).toEqual([
      ['Cobol Mainframe', 'service', 'service'],
      ['TigerBeetle DB', 'database', 'database'],
      ['Acme Queue', 'queue', 'queue'],
    ]);
    expect(diagnostics).toEqual([
      expect.objectContaining({ severity: 'warning', line: 1, col: 3, message: "Unknown tech stack 'Cobol Mainframe'; simulated as a generic service, like [Service]" }),
      expect.objectContaining({ severity: 'warning', line: 2, message: "Unknown tech stack 'TigerBeetle DB'; simulated as a generic database, like [Database]" }),
      expect.objectContaining({ severity: 'warning', line: 3, message: "Unknown tech stack 'Acme Queue'. Did you mean 'Message Queue'? Until then it is simulated as a generic queue" }),
    ]);
  });

  it('suggests the closest catalog tech for a typo', () => {
    const { diagram, diagnostics } = parse('db [Postgress]\nq [Kafak]');
    expect(diagram.nodes[0]).toMatchObject({ techStack: 'Postgress', inferredKind: 'database' });
    expect(diagnostics.map((d) => d.message)).toEqual([
      "Unknown tech stack 'Postgress'. Did you mean 'PostgreSQL'? Until then it is simulated as a generic database, like [Database]",
      "Unknown tech stack 'Kafak'. Did you mean 'Kafka'? Until then it is simulated as a generic broker, like [Message Broker]",
    ]);
  });

  it('reads explicit positions, including negative ones', () => {
    expect(parse('a pos 10,-20').diagram.nodes[0].position).toEqual({ x: 10, y: -20 });
    expect(errors('a pos 10')).toHaveLength(1);
  });

  it('makes text nodes from annotation tech stacks', () => {
    const { diagram } = parse('note "Heads up" [Sticky Note] "Rate limited to 100 rps"');
    expect(diagram.nodes[0].kind).toBe('text');
    expect(toCanvas(diagram).nodes[0]).toMatchObject({ type: 'textNode', data: { textContent: 'Rate limited to 100 rps' } });
  });

  it('reports duplicate ids with the original line', () => {
    expect(errors('a\nb\na')).toEqual([expect.objectContaining({ line: 3, message: expect.stringContaining('line 1') })]);
  });

  it('treats keywords at the start of a line as statements', () => {
    expect(errors('title')[0].message).toMatch(/Expected a title/);
    expect(errors('par')[0].message).toMatch(/only allowed inside a usecase/);
  });

  it('creates implicit nodes for undeclared references', () => {
    const { diagram, diagnostics } = parse('a -> b\nb "Bee"');
    expect(diagnostics).toEqual([]);
    expect(diagram.nodes.map((n) => [n.id, n.name, n.implicit])).toEqual([
      ['b', 'Bee', undefined],
      ['a', 'a', true],
    ]);
  });

  it('nests groups', () => {
    const { diagram } = parse('group outer {\n  group inner [Security Zone] {\n    svc\n  }\n}');
    expect(diagram.nodes.map((n) => [n.id, n.parent])).toEqual([
      ['outer', undefined],
      ['inner', 'outer'],
      ['svc', 'inner'],
    ]);
    expect(diagram.nodes[1].techStack).toBe('Security Zone');
  });

  it('warns when a group uses a non-group style', () => {
    const { diagram, diagnostics } = parse('group g [Kafka] {\n}');
    expect(diagram.nodes[0].techStack).toBe('Logical Group');
    expect(diagnostics[0].severity).toBe('warning');
  });
});

describe('edges', () => {
  it('unquotes labels and de-duplicates ids', () => {
    const { diagram } = parse('a -> b : "routes /orders"\na -> b\na --> b');
    expect(diagram.edges.map((e) => [e.id, e.label])).toEqual([
      ['a->b', 'routes /orders'],
      ['a->b#2', undefined],
      ['a->b#3', undefined],
    ]);
  });

  it('needs a target', () => {
    expect(errors('a ->')[0].message).toMatch(/target/);
  });

  it('needs a colon before the label', () => {
    expect(errors('a -> b "label"')[0].message).toMatch(/:/);
  });
});

describe('comments', () => {
  it('ignores full-line and trailing comments', () => {
    const { diagram, diagnostics } = parse('# header\na [Redis] # cache\na -> b : Publish # async');
    expect(diagnostics).toEqual([]);
    expect(diagram.edges[0].label).toBe('Publish');
  });

  it('keeps # inside payloads and quoted labels', () => {
    const src = 'usecase U {\n  a -> b : POST /tags {"tag": "#1"}\n}\na -> b : "issue #42"';
    const { diagram } = parse(src);
    expect(diagram.useCases[0].steps[0].requestBody).toBe('{"tag": "#1"}');
    expect(diagram.edges[0].label).toBe('issue #42');
  });
});

describe('use cases', () => {
  it('upgrades async calls that get a response', () => {
    const { diagram } = parse('usecase U {\n  a ->> q : Job\n  q --> a : done\n}');
    expect(diagram.useCases[0].steps[0]).toMatchObject({ executionType: 'ASYNC_REQUEST_RESPONSE', responseBody: 'done', responseFormat: 'FREE_TEXT' });
  });

  it('matches a response to the latest unanswered request', () => {
    const { diagram } = parse('usecase U {\n  a -> b : GET /1\n  a -> b : GET /2\n  b --> a : 200\n  b --> a : 404\n}');
    expect(diagram.useCases[0].steps.map((s) => s.statusCode)).toEqual([404, 200]);
  });

  it('warns on a response without a request', () => {
    expect(warnings('usecase U {\n  b --> a : 200\n}')[0].message).toMatch(/no matching request/);
  });

  it('infers messaging for queue targets', () => {
    const { diagram } = parse('q [SQS]\nusecase U {\n  a -> q : Enqueue\n}');
    expect(diagram.useCases[0].steps[0].protocol).toBe('MESSAGING');
  });

  it('gives use cases unique slug ids', () => {
    const { diagram } = parse('usecase "Place Order!" {\n}\nusecase "place order" {\n}');
    expect(diagram.useCases.map((u) => u.id)).toEqual(['place-order', 'place-order-2']);
  });

  it('numbers par blocks separately', () => {
    const { diagram } = parse('usecase U {\n  par {\n    a -> b\n  }\n  par {\n    a -> c\n  }\n  a -> d\n}');
    expect(diagram.useCases[0].steps.map((s) => s.parallelGroup)).toEqual([1, 2, undefined]);
  });

  it('locates each step at its request line and the response that answered it', () => {
    const [step, other] = parse('usecase "U" {\n  a -> b : POST /x {\n    "id": 1\n  }\n  a ->> c : Event\n  b --> a : 201\n}').diagram.useCases[0].steps;
    expect(step).toMatchObject({ loc: { line: 2, col: 3 }, responseLoc: { line: 6, col: 3, length: 13 } });
    expect(other.loc.line).toBe(5);
    expect(other.responseLoc).toBeUndefined();
  });

  it('rejects declarations that do not belong in a use case', () => {
    expect(errors('usecase U {\n  svc [REST API]\n}')[0]).toMatchObject({ line: 2, message: expect.stringMatching(/outside usecase/) });
    expect(errors('usecase U {\n  group g {\n  }\n}')[0].message).toMatch(/Groups cannot/);
    expect(errors('usecase U {\n  par {\n    par {\n    }\n  }\n}')[0].message).toMatch(/nested/);
    expect(errors('par {\n}')[0].message).toMatch(/only allowed inside a usecase/);
    expect(errors('group g {\n  usecase U {\n  }\n}')[0].message).toMatch(/top level/);
  });

  it('reports an unclosed multi-line payload', () => {
    expect(errors('usecase U {\n  a -> b : POST /x {\n    "a": 1\n')).toContainEqual(expect.objectContaining({ line: 2, message: 'Unclosed { or [ in payload' }));
  });
});

describe('step labels', () => {
  it.each([
    ['POST /orders', { name: 'POST /orders', method: 'POST', endpoint: '/orders' }],
    ['POST /orders json {"a":1}', { method: 'POST', format: 'JSON', body: '{"a":1}' }],
    ['PUT /doc xml <doc/>', { method: 'PUT', format: 'XML', body: '<doc/>' }],
    ['GET /health checks liveness', { name: 'GET /health', description: 'checks liveness' }],
    ['text hello world', { name: '', format: 'FREE_TEXT', body: 'hello world' }],
    ['Send text message', { name: 'Send text message', body: undefined }],
    ['OrderPlaced {"id": 1}', { name: 'OrderPlaced', format: 'JSON', body: '{"id": 1}' }],
    ['"Quoted name"', { name: 'Quoted name' }],
    ['GET /orders/{id}', { name: 'GET /orders/{id}', endpoint: '/orders/{id}', body: undefined }],
    ['PUT /orders/{id}/items/{itemId} json {"qty": 2}', { endpoint: '/orders/{id}/items/{itemId}', format: 'JSON', body: '{"qty": 2}' }],
  ])('%s', (label, expected) => {
    expect(parseStepLabel(label)).toMatchObject(expected);
  });

  it('keeps a path template in the step, not in the payload', () => {
    const { diagram, diagnostics } = parse('usecase "U" {\n  web -> api : GET /orders/{id}\n  api --> web : 200 {"id": 1}\n}');
    expect(diagnostics).toEqual([]);
    expect(diagram.useCases[0]).toMatchObject({ endpoint: 'GET /orders/{id}', endpointGroup: 'GET /orders/{id}' });
    expect(diagram.useCases[0].steps[0]).toMatchObject({ endpoint: '/orders/{id}', requestBody: undefined, responseBody: '{"id": 1}' });
  });

  it('only treats known HTTP verbs as methods', () => {
    expect(parseStepLabel('FETCH /x')).toEqual({ name: 'FETCH /x', format: undefined, body: undefined });
  });
});

describe('error recovery', () => {
  it('keeps parsing after a bad line', () => {
    const { diagram, diagnostics } = parse('a [REST API]\n%%% oops\nb [Redis]\na -> b');
    expect(diagnostics.map((d) => d.line)).toEqual([2, 2, 2]);
    expect(diagram.nodes.map((n) => n.id)).not.toContain('oops');
    expect(diagram.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(diagram.edges).toHaveLength(1);
  });

  it('reports unterminated strings and tech stacks', () => {
    expect(errors('a "API')[0].message).toMatch(/Unterminated string/);
    expect(errors('a [REST')[0].message).toMatch(/Missing \]/);
  });

  it('reports unmatched and missing braces', () => {
    expect(errors('}')[0].message).toBe('Unmatched }');
    expect(errors('group g {\n  a')[0]).toMatchObject({ line: 1, message: "Missing } to close group 'g'" });
  });

  it('sorts diagnostics by position', () => {
    const lines = parse('x [Nope]\n}\na "b').diagnostics.map((d) => d.line);
    expect(lines).toEqual([...lines].sort());
  });

  it('handles empty input', () => {
    expect(parse('')).toEqual({ diagram: { title: undefined, nodes: [], edges: [], useCases: [] }, diagnostics: [] });
  });
});

describe('alt scenarios', () => {
  const source = `gateway [AWS API Gateway]
orders  [REST API]
db      [PostgreSQL]

usecase "Create order" {
  gateway -> orders : POST /orders json {"sku": "A1"}
  alt "Created" {
    orders -> db : INSERT order
    db --> orders : ok
    orders --> gateway : 201 {"id": 1}
  } alt "Invalid payload" {
    orders --> gateway : 400 {"error": "sku required"}
  }
  alt "DB down" {
    orders -x db : INSERT order
    orders --> gateway : 503
  }
}`;

  it('turns each alt branch into a scenario that shares the steps before it', () => {
    const { diagram, diagnostics } = parse(source);
    expect(diagnostics).toEqual([]);
    const [useCase] = diagram.useCases;
    expect(useCase.endpoint).toBe('POST /orders');
    expect(useCase.scenarios.map((s) => [s.id, s.name, s.outcome])).toEqual([
      ['created', 'Created', 'success'],
      ['invalid-payload', 'Invalid payload', 'error'],
      ['db-down', 'DB down', 'error'],
    ]);

    const [created, invalid, down] = useCase.scenarios;
    expect(created.steps.map((s) => s.stepName)).toEqual(['POST /orders', 'INSERT order']);
    expect(created.steps[0]).toMatchObject({ statusCode: 201, responseBody: '{"id": 1}' });
    expect(invalid.steps).toHaveLength(1);
    expect(invalid.steps[0]).toMatchObject({ statusCode: 400, responseBody: '{"error": "sku required"}' });
    expect(down.steps[1]).toMatchObject({ failed: true, fromServiceId: 'orders', toServiceId: 'db' });
    expect(down.steps[0].statusCode).toBe(503);
    expect(useCase.steps).toBe(created.steps);
    expect(useCase.scenarios.map((s) => s.loc.line)).toEqual([7, 11, 14]);
  });

  it('keeps step ids unique across scenarios', () => {
    const ids = parse(source).diagram.useCases[0].scenarios.flatMap((s) => s.steps.map((step) => step.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a use case without alt has one main scenario', () => {
    const [useCase] = parse('usecase "U" {\n  a -> b : GET /x\n  b --> a : 404\n}').diagram.useCases;
    expect(useCase.scenarios).toHaveLength(1);
    expect(useCase.scenarios[0]).toMatchObject({ id: 'main', name: 'U', outcome: 'error' });
  });

  it('shares steps after an alt set with every branch', () => {
    const [useCase] = parse('usecase "U" {\n  alt "A" {\n    a -> b\n  } alt "B" {\n    a -> c\n  }\n  a -> log : audit\n}').diagram.useCases;
    expect(useCase.scenarios.map((s) => s.steps.map((step) => step.toServiceId))).toEqual([
      ['b', 'log'],
      ['c', 'log'],
    ]);
  });

  it('multiplies nested and consecutive-but-separate alt sets', () => {
    const src = `usecase "U" {
  alt "A" {
    alt "A1" {
      a -> b
    } alt "A2" {
      a -> c
    }
  } alt "B" {
    a -> d
  }
  a -> e
  alt "X" {
    a -> f
  } alt "Y" {
    a -> g
  }
}`;
    const { diagram, diagnostics } = parse(src);
    expect(diagnostics).toEqual([]);
    expect(diagram.useCases[0].scenarios.map((s) => s.name)).toEqual([
      'A › A1 › X',
      'A › A1 › Y',
      'A › A2 › X',
      'A › A2 › Y',
      'B › X',
      'B › Y',
    ]);
  });

  it('matches a response inside a branch to a request before it', () => {
    const { diagram, diagnostics } = parse('usecase "U" {\n  a -> b : GET /x\n  alt "Ok" {\n    b --> a : 200\n  } alt "Missing" {\n    b --> a : 404\n  }\n}');
    expect(diagnostics).toEqual([]);
    expect(diagram.useCases[0].scenarios.map((s) => s.steps[0].statusCode)).toEqual([200, 404]);
  });

  it('allows par inside alt and keeps parallel groups', () => {
    const { diagram, diagnostics } = parse('usecase "U" {\n  alt "A" {\n    par {\n      a -> b\n      a -> c\n    }\n  }\n}');
    expect(diagnostics).toEqual([]);
    expect(diagram.useCases[0].steps.map((s) => s.parallelGroup)).toEqual([1, 1]);
  });

  it('reports each warning in shared steps once', () => {
    const w = warnings('usecase "U" {\n  b --> a : 200\n  alt "A" {\n    a -> b\n  } alt "B" {\n    a -> c\n  }\n}');
    expect(w).toHaveLength(1);
    expect(w[0].line).toBe(2);
  });

  it('a failed call cannot be answered', () => {
    const w = warnings('usecase "U" {\n  a -x b : GET /x\n  b --> a : 200\n}');
    expect(w[0].message).toMatch(/no matching request/);
  });

  it('rejects misplaced alt and -x', () => {
    expect(errors('alt "A" {\n}')[0].message).toBe('alt is only allowed inside a usecase');
    expect(errors('usecase "U" {\n  par {\n    alt "A" {\n    }\n  }\n}')[0].message).toBe('alt blocks cannot be inside a par block');
    expect(errors('usecase "U" {\n  alt {\n  }\n}')[0].message).toMatch(/Expected a scenario name/);
    expect(errors('a -x b')[0].message).toMatch(/only allowed in use case steps/);
    expect(errors('usecase "U" {\n  alt "A" {\n    a -> b\n}')[0].message).toBe("Missing } to close usecase 'U'");
    expect(errors('usecase "U" {\n  } junk')[0].message).toBe("Unexpected input after }");
  });

  it('does not read -x out of an id', () => {
    expect(parse('a -> xray').diagram.edges[0].target).toBe('xray');
    expect(errors('a -xray')).not.toEqual([]);
  });

  it('caps the number of scenarios', () => {
    const set = (n: number) => `  alt "${n}a" {\n    a -> b\n  } alt "${n}b" {\n    a -> c\n  }\n`;
    const src = `usecase "U" {\n${[1, 2, 3, 4, 5, 6].map((n) => `${set(n)}  a -> d\n`).join('')}}`;
    const { diagram, diagnostics } = parse(src);
    expect(diagram.useCases[0].scenarios).toHaveLength(32);
    expect(diagnostics[0].message).toMatch(/Too many scenarios/);
  });
});

describe('scenario conditions', () => {
  const scenarios = (src: string) => parse(src).diagram.useCases[0].scenarios.map((s) => [s.name, s.condition]);

  it('reads alt "Name" when "condition", also after }', () => {
    const src = 'usecase "U" {\n  a -> b : GET /x\n  alt "Found" when "the order exists" {\n    b --> a : 200\n  } alt "Missing" when "no such order" {\n    b --> a : 404\n  } alt "Other" {\n    b --> a : 500\n  }\n}';
    expect(parse(src).diagnostics).toEqual([]);
    expect(scenarios(src)).toEqual([
      ['Found', 'the order exists'],
      ['Missing', 'no such order'],
      ['Other', undefined],
    ]);
  });

  it('joins the non-empty conditions of nested branches', () => {
    const src = 'usecase "U" {\n  alt "A" when "cache miss" {\n    alt "A1" {\n      a -> b\n    } alt "A2" when "db down" {\n      a -x b\n    }\n  } alt "B" when "" {\n    a -> c\n  }\n}';
    expect(scenarios(src)).toEqual([
      ['A › A1', 'cache miss'],
      ['A › A2', 'cache miss · db down'],
      ['B', undefined],
    ]);
  });

  it('leaves the condition out of the output when there is none', () => {
    const [scenario] = parse('usecase "U" {\n  a -> b\n}').diagram.useCases[0].scenarios;
    expect('condition' in scenario).toBe(false);
  });

  it('treats when as a keyword only after the alt name', () => {
    const { diagram, diagnostics } = parse('when [REST API]\nusecase "U" {\n  alt when {\n    when -> b\n  }\n}');
    expect(diagnostics).toEqual([]);
    expect(diagram.nodes[0].id).toBe('when');
    expect(diagram.useCases[0].scenarios[0]).toMatchObject({ name: 'when' });
  });

  it('needs a quoted condition and a brace', () => {
    const err = (line: string) => errors(`usecase "U" {\n  ${line}\n    a -> b\n  }\n}`)[0];
    expect(err('alt "A" when {')).toMatchObject({ message: expect.stringMatching(/^Expected a condition after when/), line: 2, col: 16 });
    expect(err('alt "A" when')).toMatchObject({ message: expect.stringMatching(/^Expected a condition after when/), col: 11 });
    expect(err('alt "A" when cond {').message).toMatch(/^Expected a condition after when/);
    expect(err('alt "A" when "c"').message).toBe('Expected { after the alt condition');
    expect(err('alt "A" when "c" "d" {').message).toBe('Expected { after the alt condition');
    expect(err('alt "A" "c" {').message).toBe('Expected { after alt name');
    expect(errors('usecase "U" {\n  alt "A" {\n  } alt "B" when {\n  }\n}')[0].message).toMatch(/^Expected a condition after when/);
  });
});

describe('missing connection warning', () => {
  const missing = (src: string) => warnings(src).filter((w) => w.message.startsWith('No connection')).map((w) => [w.line, w.message]);

  it('warns on steps between nodes the architecture does not connect', () => {
    const src = 'web -> api\nusecase "U" {\n  web -> api : GET /x\n  api -> db : SELECT\n  api ->> events : Done\n  db --> api : rows\n  api -x cache : GET\n  api --> web : 200\n}';
    expect(missing(src)).toEqual([
      [4, "No connection between 'api' and 'db' in the architecture; add 'api -> db'"],
      [5, "No connection between 'api' and 'events' in the architecture; add 'api -> events'"],
      [6, "No connection between 'api' and 'db' in the architecture; add 'api -> db'"],
      [7, "No connection between 'api' and 'cache' in the architecture; add 'api -> cache'"],
    ]);
    expect(warnings(src)[0]).toMatchObject({ line: 4, col: 3, length: 'api -> db : SELECT'.length });
  });

  it('accepts a connection in either direction and self-calls', () => {
    expect(missing('db -> api\nusecase "U" {\n  api -> db : SELECT\n  api -> api : validate\n}')).toEqual([]);
  });

  it('stays quiet when the document has no connections', () => {
    expect(missing('api [REST API]\nusecase "U" {\n  web -> api : GET /x\n}')).toEqual([]);
  });

  it('reports a step shared by several scenarios once', () => {
    const src = 'a -> b\nusecase "U" {\n  a -> c : x\n  alt "A" {\n    a -> b\n  } alt "B" {\n    c -> d\n  }\n}';
    expect(missing(src)).toEqual([
      [3, "No connection between 'a' and 'c' in the architecture; add 'a -> c'"],
      [7, "No connection between 'c' and 'd' in the architecture; add 'c -> d'"],
    ]);
  });
});

describe('capacity size', () => {
  it('reads S, M and L, and refuses anything else', () => {
    const { diagram, diagnostics } = parse('db [PostgreSQL]\ncapacity {\n  db size L shards 2\n}');
    expect(diagnostics).toEqual([]);
    expect(diagram.capacity?.[0]).toMatchObject({ node: 'db', size: 'L', shards: 2 });
    expect(parse('db\ncapacity {\n  db size XL\n}').diagnostics[0].message).toMatch(/Expected S, M or L after size/);
  });
});

describe('resolver errors', () => {
  it("reports an ImportError's own message and falls back to Cannot find for others", () => {
    const importError = Object.assign(new Error("'../x.proschi' is outside the project root"), { name: 'ImportError' });
    const jailed = parse('import "../x.proschi"', {
      resolve: () => {
        throw importError;
      },
    });
    expect(jailed.diagnostics).toEqual([{ severity: 'error', message: "'../x.proschi' is outside the project root", line: 1, col: 8, length: 14 }]);
    const other = parse('import "x.proschi"', {
      resolve: () => {
        throw new TypeError('boom');
      },
    });
    expect(other.diagnostics[0].message).toBe("Cannot find 'x.proschi'");
  });
});
