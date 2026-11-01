/**
 * The drone startup (docs/design/team-systems-and-imports.md): an org diagram
 * with one box per team, each a `system` wrapping that team's design. The
 * team files ride along as the imports of a share link, the way the browser
 * resolves `from` (playground/imports.ts). Used by the e2e tests and demos.
 */

export const DRONE_ORG_PATH = 'drone-startup.proschi';

const frontend = `title "Frontend" "The shop the customers use"
direction right

shopper "Customer" [Browser]
cdn "CDN" [CloudFront]
web "Web App" [Node.js] x6
bff "Shop BFF" [Node.js] x6
cache "Catalog Cache" [Redis] x2
catalog "Catalog" [Microservice] x4

shopper -> cdn
cdn -> web
web -> bff
bff -> cache
bff -> catalog

usecase "Open shop" {
  shopper -> cdn : GET /
  cdn -> web : render
  web -> bff : GET /catalog
  bff -> cache : GET catalog
  bff --> web : 200
  web --> cdn : HTML
  cdn --> shopper : 200
}

traffic {
  "Open shop" 1k rps
}

requirements {
  p99 "Open shop" < 400ms
}
`;

const orders = `title "Order Processing" "Takes and tracks orders"
direction right

caller "Callers" [Actor]
gateway "Orders API" [AWS API Gateway] x2
api "Order Service" [REST API] x3
db "Orders DB" [PostgreSQL] x2
events "Order Events" [Kafka] x3
worker "Fulfilment Worker" [Microservice] x2

caller -> gateway
gateway -> api
api -> db
api -> events
events -> worker

usecase "Place order" {
  caller -> gateway : POST /orders
  gateway -> api : place order
  api -> db : INSERT order
  api ->> events : order placed
  api --> gateway : 201
}

traffic {
  "Place order" 300 rps
}

capacity {
  db 1.5k rps
}

requirements {
  p99 "Place order" < 150ms
  availability "Place order" >= 99.9%
}
`;

const warehouse = `title "Warehouse" "Stock and picking"
direction right

caller "Callers" [Actor]
stock "Stock Service" [Go] x3
db "Stock DB" [PostgreSQL] x2
cache "Stock Cache" [Redis]

caller -> stock
stock -> cache
stock -> db

usecase "Reserve stock" {
  caller -> stock : POST /reservations
  stock -> cache : GET sku
  stock -> db : UPDATE stock
  stock --> caller : 200
}

traffic {
  "Reserve stock" 200 rps
}

requirements {
  p99 "Reserve stock" < 200ms
}
`;

const feed = `title "Feed" "Tells customers where their drone is"
direction right

caller "Callers" [Actor]
ingest "Event Ingest" [Microservice] x4
stream "Event Stream" [Kafka]
push "Push Sender" [Microservice] x2

caller -> ingest
ingest -> stream
stream -> push

usecase "Publish event" {
  caller -> ingest : POST /events
  ingest ->> stream : event
}

traffic {
  "Publish event" 500 rps
}
`;

/** The org diagram, sending `buyRps` through the frontend into the teams. */
export function droneOrgSource(buyRps = 100): string {
  return `title "Drone startup" "Teams and what they promise each other"

shopper "Customer" [Browser]

system frontend "Frontend" @Frontend {
  from "teams/frontend.proschi"
  expose web "Shop" -> "Open shop"
}

system orders "Order Processing" @Orders {
  from "teams/orders.proschi"
  expose api "Orders API" -> "Place order"
}

system warehouse "Warehouse" @Warehouse {
  from "teams/warehouse.proschi"
  expose stock "Stock API" -> "Reserve stock"
}

system feed "Feed" @Feed {
  from "teams/feed.proschi"
  expose events "Events" -> "Publish event"
}

system payments "Payments" @Payments {
  expose charge "Charge"
  capacity { 5k rps p99 120ms availability 99.95% }
}

shopper -> frontend.web : HTTPS
frontend -> orders.api : place order
orders -> warehouse.stock : reserve
orders -> payments.charge : charge
orders -> feed.events : order placed

usecase "Buy drone" {
  shopper -> frontend.web : open shop
  frontend -> orders.api : place order
  orders -> warehouse.stock : reserve
  orders -> payments.charge : charge
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
`;
}

/** The team files, by the path the org diagram's `from` names. */
export const DRONE_TEAM_FILES: Readonly<Record<string, string>> = {
  'teams/frontend.proschi': frontend,
  'teams/orders.proschi': orders,
  'teams/warehouse.proschi': warehouse,
  'teams/feed.proschi': feed,
};
