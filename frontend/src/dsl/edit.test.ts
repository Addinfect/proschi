import { describe, expect, it } from 'vitest';
import {
  addConnection,
  addNode,
  clearPositions,
  removeConnections,
  removeNode,
  renameNode,
  setCapacity,
  setDescription,
  setEdgeLabel,
  setNodePosition,
  setOwner,
  setReplicas,
  setSize,
  setTech,
  uniqueId,
} from './edit';
import { parse } from './parser';

describe('setNodePosition', () => {
  it('adds pos to a node, keeping a trailing comment', () => {
    expect(setNodePosition('api "API" [REST API] # entry\ndb', 'api', { x: 10.4, y: -20.6 })).toBe(
      'api "API" [REST API] pos 10,-21 # entry\ndb'
    );
  });

  it('replaces an existing pos', () => {
    expect(setNodePosition('api pos 1,2 @team', 'api', { x: 30, y: 40 })).toBe('api pos 30,40 @team');
  });

  it('puts group positions before the brace', () => {
    const src = 'group vpc "VPC" {\n  a\n}';
    const moved = setNodePosition(src, 'vpc', { x: 5, y: 6 });
    expect(moved).toBe('group vpc "VPC" pos 5,6 {\n  a\n}');
    expect(setNodePosition(moved, 'vpc', { x: 7, y: 8 })).toBe('group vpc "VPC" pos 7,8 {\n  a\n}');
    expect(parse(moved).diagram.nodes[0].position).toEqual({ x: 5, y: 6 });
  });

  it('puts system positions before the brace', () => {
    const src = 'system orders "Orders" @Orders {\n  expose api\n}';
    const moved = setNodePosition(src, 'orders', { x: 5, y: 6 });
    expect(moved).toBe('system orders "Orders" @Orders pos 5,6 {\n  expose api\n}');
    expect(parse(moved).diagram.nodes[0].position).toEqual({ x: 5, y: 6 });
  });

  it('edits indented nodes inside groups', () => {
    expect(setNodePosition('group g {\n  svc [Redis]\n}', 'svc', { x: 1, y: 2 })).toBe('group g {\n  svc [Redis] pos 1,2\n}');
  });

  it('declares implicit nodes before the first use case', () => {
    const src = 'a -> b\n\nusecase U {\n  a -> b\n}\n';
    const result = setNodePosition(src, 'b', { x: 3, y: 4 });
    expect(result).toBe('a -> b\nb pos 3,4\n\nusecase U {\n  a -> b\n}\n');
    expect(parse(result).diagnostics).toEqual([]);
  });

  it('appends implicit nodes when there is no use case', () => {
    expect(setNodePosition('a -> b', 'b', { x: 0, y: 0 })).toBe('a -> b\nb pos 0,0\n');
  });
});

describe('renameNode', () => {
  it('replaces the display name', () => {
    expect(renameNode('api "Old" [REST API]', 'api', 'New name')).toBe('api "New name" [REST API]');
  });

  it('adds a name when there is none', () => {
    expect(renameNode('api [REST API]', 'api', 'Gateway')).toBe('api "Gateway" [REST API]');
    expect(renameNode('group g {\n}', 'g', 'Zone')).toBe('group g "Zone" {\n}');
  });

  it('escapes quotes and ignores empty names', () => {
    const renamed = renameNode('api', 'api', 'Say "hi"');
    expect(renamed).toBe('api "Say \\"hi\\""');
    expect(parse(renamed).diagram.nodes[0].name).toBe('Say "hi"');
    expect(renameNode('api', 'api', '   ')).toBe('api');
  });

  it('declares implicit nodes', () => {
    expect(renameNode('a -> b', 'b', 'Bee')).toBe('a -> b\nb "Bee"\n');
  });
});

describe('addConnection', () => {
  it('adds a connection once', () => {
    const once = addConnection('a\nb\n', 'a', 'b');
    expect(once).toBe('a\nb\na -> b\n');
    expect(addConnection(once, 'a', 'b')).toBe(once);
    expect(addConnection(once, 'a', 'a')).toBe(once);
  });

  it('keeps use cases last', () => {
    expect(addConnection('a\nusecase U {\n}', 'a', 'b')).toBe('a\na -> b\nusecase U {\n}');
  });
});

describe('clearPositions', () => {
  it('removes every pos and nothing else', () => {
    const src = 'group g "G" pos 1,2 {\n  a [Redis] pos 3,4 @t # c\n}\nb pos 5,6\nb -> a : pos 9,9';
    const cleared = clearPositions(src);
    expect(cleared).toBe('group g "G" {\n  a [Redis] @t # c\n}\nb\nb -> a : pos 9,9');
    expect(parse(cleared).diagram.nodes.every((n) => !n.position)).toBe(true);
  });
});

describe('removeConnections', () => {
  it('removes the chosen connections, including duplicates by id', () => {
    const src = 'a\nb\na -> b : one\na -> b : two\nb -> a';
    expect(removeConnections(src, ['a->b#2', 'b->a'])).toBe('a\nb\na -> b : one');
  });

  it('removes a connection whose payload spans lines', () => {
    expect(removeConnections('a -> b : {\n  "x": 1\n}\nc', ['a->b'])).toBe('c');
  });
});

describe('removeNode', () => {
  it('leaves a system block to the text', () => {
    expect(removeNode('system orders "Orders" {\n  expose api\n}', 'orders')).toEqual({ error: '"Orders" is a system; delete its block in the text.' });
  });

  it('removes the declaration and its connections', () => {
    const result = removeNode('a [Redis] # cache\nb\na -> b\nb -> c', 'a');
    expect(result).toEqual({ source: 'b\nb -> c' });
  });

  it('removes an implicit node by removing its connections', () => {
    expect(removeNode('a\na -> ghost', 'ghost')).toEqual({ source: 'a' });
  });

  it('refuses groups and nodes used in use cases', () => {
    expect(removeNode('group g {\n  a\n}', 'g').error).toMatch(/group/);
    expect(removeNode('a\nb\nusecase "Flow" {\n  a -> b\n}', 'b').error).toMatch(/"Flow"/);
  });
});

describe('addNode', () => {
  it('declares a node with a name, tech and position before the use cases', () => {
    const src = 'api [REST API]\n\nusecase U {\n  api -> api\n}\n';
    const { source, id } = addNode(src, { name: 'Session cache', tech: 'Redis', position: { x: 10.2, y: 20.7 } });
    expect(id).toBe('session_cache');
    expect(source).toBe('api [REST API]\nsession_cache "Session cache" [Redis] pos 10,21\n\nusecase U {\n  api -> api\n}\n');
    expect(parse(source).diagnostics).toEqual([]);
  });

  it('picks free ids that are not keywords', () => {
    expect(uniqueId('redis\nredis2', 'Redis')).toBe('redis3');
    expect(uniqueId('', 'Capacity')).toBe('capacity2');
    expect(uniqueId('', '3 Nodes!')).toBe('n3_nodes');
    expect(uniqueId('', '')).toBe('node');
    expect(addNode('', { name: 'db', tech: 'PostgreSQL' }).source).toBe('db [PostgreSQL]\n');
  });
});

describe('node properties', () => {
  it('sets, replaces and clears the tech', () => {
    expect(setTech('api "API" x2 # c', 'api', 'Node.js')).toBe('api "API" [Node.js] x2 # c');
    expect(setTech('api [Go] x2', 'api', 'Rust')).toBe('api [Rust] x2');
    expect(setTech('api [Go] x2', 'api', null)).toBe('api x2');
  });

  it('sets replicas, and removes them at 1', () => {
    expect(setReplicas('api "API" [Go] pos 1,2', 'api', 3)).toBe('api "API" [Go] x3 pos 1,2');
    expect(setReplicas('api [Go] x3 @core', 'api', 5)).toBe('api [Go] x5 @core');
    expect(setReplicas('api [Go] x3 @core', 'api', 1)).toBe('api [Go] @core');
    expect(parse(setReplicas('a -> b', 'b', 2)).diagram.nodes.find((n) => n.id === 'b')?.replicas).toBe(2);
    expect(setReplicas('a -> b', 'b', 1)).toBe('a -> b');
  });

  it('sets and clears the owner', () => {
    expect(setOwner('api [Go]', 'api', '@Core Team')).toBe('api [Go] @Core-Team');
    expect(setOwner('api [Go] @old', 'api', null)).toBe('api [Go]');
  });

  it('sets and clears the description', () => {
    expect(setDescription('api "API" [Go]', 'api', 'Handles requests')).toBe('api "API" "Handles requests" [Go]');
    expect(setDescription('api "API" "Old" [Go]', 'api', null)).toBe('api "API" [Go]');
    const added = setDescription('api [Go]', 'api', 'Edge');
    expect(added).toBe('api "api" "Edge" [Go]');
    expect(parse(added).diagram.nodes[0]).toMatchObject({ name: 'api', description: 'Edge' });
  });
});

describe('setCapacity', () => {
  it('adds a capacity block when there is none', () => {
    const result = setCapacity('db [PostgreSQL]', 'db', 'latency', 4);
    expect(result).toBe('db [PostgreSQL]\ncapacity {\n  db latency 4ms\n}\n');
    expect(parse(result).diagram.capacity?.[0]).toMatchObject({ node: 'db', latencyMs: 4 });
  });

  it('adds a line to the existing block, keeping its indentation', () => {
    const src = 'db\ncache [Redis]\ncapacity {\n    db 20k rps\n}\n';
    expect(setCapacity(src, 'cache', 'rate', 50000)).toBe('db\ncache [Redis]\ncapacity {\n    db 20k rps\n    cache 50000 rps\n}\n');
  });

  it('replaces, adds and removes parts of a line', () => {
    const src = 'db\ncapacity {\n  db 20k rps latency 4ms # tuned\n}';
    expect(setCapacity(src, 'db', 'latency', 9)).toBe('db\ncapacity {\n  db 20k rps latency 9ms # tuned\n}');
    expect(setCapacity(src, 'db', 'shards', 4)).toBe('db\ncapacity {\n  db 20k rps latency 4ms shards 4 # tuned\n}');
    expect(setCapacity(src, 'db', 'rate', null)).toBe('db\ncapacity {\n  db latency 4ms # tuned\n}');
  });

  it('swaps a rate for reads and removes an emptied line', () => {
    const src = 'db\ncapacity {\n  db 20k rps\n}';
    const reads = setCapacity(src, 'db', 'reads', 30000);
    expect(reads).toBe('db\ncapacity {\n  db reads 30000 rps\n}');
    expect(parse(reads).diagnostics).toEqual([]);
    expect(setCapacity(reads, 'db', 'reads', null)).toBe('db\ncapacity {\n}');
  });
});

describe('setEdgeLabel', () => {
  it('sets, replaces and clears a label', () => {
    expect(setEdgeLabel('a -> b', 'a->b', 'reads')).toBe('a -> b : reads');
    expect(setEdgeLabel('a -> b : old # c', 'a->b', 'new')).toBe('a -> b : new');
    expect(setEdgeLabel('a -> b : old', 'a->b', null)).toBe('a -> b');
  });

  it('leaves multi-line payloads alone', () => {
    const src = 'a -> b : {\n  "x": 1\n}';
    expect(setEdgeLabel(src, 'a->b', 'y')).toBe(src);
  });
});

describe('every edit', () => {
  const base = [
    '# Shop',
    'title "Shop"',
    'lb "LB" [Load Balancer] # entry',
    'group vpc "VPC" {',
    '  api "API" [REST API] x2 @core',
    '  db [PostgreSQL]',
    '}',
    'lb -> api : https',
    'api -> db',
    'capacity {',
    '  db 20k rps',
    '}',
    '',
    'usecase "Buy" {',
    '  lb -> api : POST /buy',
    '  api -> db : insert',
    '}',
    '',
  ].join('\n');

  const edits: [string, (s: string) => string, number[]][] = [
    ['tech', (s) => setTech(s, 'db', 'MySQL'), [6]],
    ['replicas', (s) => setReplicas(s, 'api', 4), [5]],
    ['owner', (s) => setOwner(s, 'db', 'data'), [6]],
    ['description', (s) => setDescription(s, 'lb', 'Public entry'), [3]],
    ['capacity', (s) => setCapacity(s, 'db', 'latency', 3), [11]],
    ['edge label', (s) => setEdgeLabel(s, 'api->db', 'SQL'), [9]],
  ];

  it.each(edits)('%s keeps the document valid and touches one line', (_, edit, changed) => {
    const result = edit(base);
    expect(parse(result).diagnostics).toEqual([]);
    const before = base.split('\n');
    const after = result.split('\n');
    expect(after).toHaveLength(before.length);
    const diff = before.flatMap((line, i) => (line === after[i] ? [] : [i + 1]));
    expect(diff).toEqual(changed);
  });

  it('adding a node keeps every existing line', () => {
    const { source } = addNode(base, { name: 'Cache', tech: 'Redis' });
    expect(parse(source).diagnostics).toEqual([]);
    expect(source.split('\n').filter((l) => l !== 'cache "Cache" [Redis]')).toEqual(base.split('\n'));
  });
});

describe('setSize', () => {
  it('sets, replaces and clears the instance size', () => {
    const big = setSize('db [PostgreSQL]', 'db', 'L');
    expect(big).toBe('db [PostgreSQL]\ncapacity {\n  db size L\n}\n');
    expect(parse(big).diagram.capacity?.[0].size).toBe('L');
    expect(setSize(big, 'db', 'M')).toContain('  db size M\n');
    expect(setSize(big, 'db', null)).toBe('db [PostgreSQL]\ncapacity {\n}\n');
  });
});
