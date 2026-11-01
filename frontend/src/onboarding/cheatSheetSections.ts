/**
 * The syntax cheat-sheet in the Help menu. Read top to bottom, its snippets
 * form one valid document: cheatSheetSections.test.ts parses them together with the
 * real parser (no errors, no warnings) and checks the arrows and the links
 * against the docs pages, so the sheet cannot drift from the language.
 */

export interface CheatSection {
  id: string;
  title: string;
  /** One line under the title; `backticks` render as code. */
  note: string;
  code: string;
  /** The docs page (and anchor) that explains it, relative to /docs/: `use-cases/`, `tests/#tests`. */
  ref: string;
}

/** Use case arrows, as in docs/GRAMMAR.md (`arrow = …`). */
export const ARROWS: { arrow: string; meaning: string }[] = [
  { arrow: '->', meaning: 'request' },
  { arrow: '-->', meaning: 'response' },
  { arrow: '->>', meaning: 'fire and forget' },
  { arrow: '-x', meaning: 'failed call' },
];

export const CHEAT_SECTIONS: CheatSection[] = [
  {
    id: 'nodes',
    title: 'Nodes',
    note: '`id "Name" [Tech] @team x<replicas>`, parts in any order. `[Tech]` is one of about 210 catalog techs, aliases too (`[S3]`, `[Postgres]`). Undeclared ids become plain nodes.',
    ref: 'nodes/#declare-a-node',
    code: `title "Shop" "Sells things online"

user "User"       [Actor]
api  "Orders API" [REST API]   @orders x2
db   "Orders DB"  [PostgreSQL]`,
  },
  {
    id: 'groups',
    title: 'Groups',
    note: 'A box around nodes: a VPC, a team, a zone.',
    ref: 'nodes/#frame-nodes-with-a-group',
    code: `group vpc "VPC" {
  cache "Cache" [Redis]
}`,
  },
  {
    id: 'connections',
    title: 'Connections',
    note: '`from -> to : label`. Use case steps follow these edges.',
    ref: 'nodes/#connect-two-nodes',
    code: `user -> api   : HTTPS
api  -> cache : GET
api  -> db    : SQL`,
  },
  {
    id: 'usecases',
    title: 'Use cases',
    note: 'Steps play in order. `METHOD /path`, then a JSON body; a response starts with its status. `par { … }` runs steps in parallel.',
    ref: 'use-cases/',
    code: `usecase "Place order" {
  user -> api : POST /orders json {"sku": "A1"}
  par {
    api -> db     : INSERT order
    api ->> cache : SET order
  }
  api --> user : 201 {"id": 42}
}`,
  },
  {
    id: 'scenarios',
    title: 'Scenarios',
    note: 'Each `alt` branch is a scenario tab: the happy path and the failures side by side.',
    ref: 'scenarios/',
    code: `usecase "Get order" {
  user -> api : GET /orders/{id}
  alt "Cache hit" when "seen recently" {
    api -> cache : GET order
    api --> user : 200
  } alt "Cache miss" {
    api -> cache : GET order
    api -> db    : SELECT order
    api --> user : 200
  } alt "DB down" {
    api -> cache : GET order
    api -x db    : SELECT order
    api --> user : 503
  }
}`,
  },
  {
    id: 'hld',
    title: 'Traffic and requirements',
    note: 'The simulation loads the design with this traffic and checks every requirement (the Results tab). `capacity` overrides a node\'s numbers, e.g. how long a failed call to it takes.',
    ref: 'hld/',
    code: `traffic {
  "Get order"   2k rps mix "Cache hit" 90%, "Cache miss" 10%
  "Place order" 50 rps
}

requirements {
  p99 "Get order" < 100ms
  availability >= 99.9%
  durable "Place order"
  cost <= 2000 usd/month
}

capacity {
  db timeout 250ms
}`,
  },
  {
    id: 'tests',
    title: 'Tests',
    note: 'Assertions about how the flows work.',
    ref: 'tests/#tests',
    code: `test "Reads try the cache first" {
  "Get order" calls any cache before any database
  "Place order" writes any database before responding
  no path from user to any database
}`,
  },
];

/** The whole sheet as one document (what the test parses). */
export function cheatSheetDocument(): string {
  return CHEAT_SECTIONS.map((s) => s.code).join('\n\n') + '\n';
}
