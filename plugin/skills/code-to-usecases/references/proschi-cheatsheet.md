# Proschi cheat-sheet

The core of the language; everything else is in <https://proschi.app/docs/language/>.
When in doubt, run `npx proschi@latest check <file>` and believe it.

## Nodes, groups, edges

```proschi
title "Shop" "One-line summary of the system"

user "Customer" [Actor]
group vpc "AWS VPC" [Network Boundary] {
  api "Order API" [Spring Boot] @orders x3
  db  "Orders DB" [PostgreSQL]  @orders "Owns orders and payments"
}
user -> api : HTTPS
api  -> db  : SQL
```

- Node: `id ["Name"] [Tech] [@team] ["Description"] [x<replicas>]`, parts in
  any order. Ids: letters, digits, `_` (`order_service`, never `order-service`).
  Names over ~18 characters are cut: put the rest in the description.
- Group styles: Logical Group (default), Network Boundary, Security Zone,
  Service Group. Nodes and groups nest; every other block is top level.
- One statement per line, `#` comments, `import "file.proschi"`. Declare
  each node with a tech (an undeclared id becomes a plain node).
- `a -> b : label` goes caller → callee; one edge per pair (no `b -> a`).
  An edge may end on a group: `gw -> services` reaches all members.

## Colors, legend, critical (all optional)

```proschi
legend {
  owned   "Owned by us"  green
  planned "Planned flow" blue dashed
  old     "Deprecated"   color #ef4444 dotted
}
group core "Core" .owned {
  api "Order API" [REST API] critical
}
erp "Legacy ERP" [SOAP API] .old
api -> erp .planned : sync orders
```

- Nodes are tinted by category without any of this. `color <name>|#hex`
  (gray, blue, teal, green, yellow, orange, red, purple, pink) beats a tag,
  which beats the category. A hex in a legend line needs `color #hex`.
- `.tag` (one per node, group or edge; before an edge's `:`) applies a
  legend style. Legend only for what the reader must tell apart (owner,
  lifecycle); no legend → no `color`. `critical` (a badge): only a few nodes.

## Layout

Top-down along the edges. **Edges decide the rows** (a callee sits below its
caller); **declaration order decides left to right** within a row wherever
it adds no crossings (fewer crossings win). So declare siblings in the
left-to-right (or top-to-bottom) order the diagram should be read, or the
source shows.

- Tier by tier: clients, edge, services, queues and workers, stores,
  externals, monitoring. A node one part uses goes next to it.
- Fan-out (every service → metrics): one edge from or to the group.
- Group by a real boundary (network, cluster, team, tier); nest ≤ 2 levels.

```proschi fragment
layout ordered # top level: declared first sits higher, whatever the arrows
group kafka "Kafka" rank 1 {
  direction right # this group reads as a row
  orders "Order Events" [Kafka]
  eta    "ETA updates"  [Kafka]
}
audit "Audit log" [Database] rank last
```

[Layout hints](https://proschi.app/docs/styling/#steering-the-layout), in this order:
1. Reading-order declarations + `layout ordered`: start every diagram so.
2. `rank N|first|last` on group tiers (lower sits higher, among siblings;
   connected nodes can't share a row).
3. `rank` on a top row of externals, only where alignment matters.
4. `direction right` in a group that reads as a row. Two joined zones side
   by side: wrap them in a `direction right` group, `direction down` in each.
5. Render after **each** hint; revert any that adds crossings. `pos x,y`
   pins one node: last resort.

**Render and review (mandatory after any architecture change):**
`npx proschi@latest render --out /tmp/proschi-review file.proschi`, look at
the whole `architecture.svg` (PNG for raster-only readers: `rsvg-convert -w
2000 architecture.svg -o review.png`). Fix and re-render until none is true:
edges cross or labels overlap; an edge points against the flow; a node is
stranded; sprawl; the order is not the one meant; legend colors are wrong.
Fix in order: edge direction, declaration order, group edges, regrouping,
hints, `pos`. Stop after ~5 rounds and say what still looks wrong.

## Tech (`[Tech]`): icon, kind, simulation defaults

Case, spaces and a version are ignored (`[postgres 16]`). Unknown tech warns: use
the generic tech of its kind, product in the name (`"TigerBeetle" [Database]`).

| Kind | Use these techs |
|---|---|
| client | `Actor` (aliases User, Client, Customer), `Browser`, `Mobile App` |
| edge / cdn / loadbalancer / gateway / dns | `CDN`, `AWS CloudFront`, `Cloudflare`, `Fastly`, `Load Balancer`, `AWS Load Balancer` (ALB/NLB), `nginx`, `Envoy`, `HAProxy`, `Traefik`, `Kubernetes Ingress`, `API Gateway`, `AWS API Gateway`, `Kong`, `Azure Application Gateway`, `DNS`, `AWS Route53`, `WAF`, `AWS WAF` |
| service | `Service`, `Worker`, `REST API`, `gRPC`, `GraphQL`, `WebSocket`, `Spring Boot`, `Kotlin`, `Java`, `Go`, `Node.js` (Express, NestJS), `Python`, `Django`, `FastAPI`, `Flask`, `Ruby on Rails`, `.NET`, `PHP`, `Rust`, `Elixir`, `Kubernetes`, `Docker`, `VM`, `AWS EC2`, `AWS ECS`, `AWS EKS`, `AWS Fargate`, `GCP GKE`, `Azure AKS`, `Azure App Service` |
| function | `Function`, `AWS Lambda`, `GCP Cloud Functions`, `GCP Cloud Run`, `Azure Functions`, `Cloudflare Workers` |
| cache | `Cache`, `Redis`, `Valkey`, `Memcached`, `AWS ElastiCache`, `GCP Memorystore`, `Azure Cache for Redis`, `Hazelcast` |
| database | `Database`, `NoSQL Database`, `PostgreSQL`, `MySQL`, `MariaDB`, `SQL Server`, `Oracle`, `SQLite`, `AWS RDS`, `AWS Aurora`, `GCP Cloud SQL`, `Azure SQL`, `CockroachDB`, `GCP Spanner`, `DynamoDB`, `Cassandra`, `ScyllaDB`, `MongoDB`, `Azure Cosmos DB`, `GCP Firestore`, `GCP Bigtable`, `Neo4j`, `etcd` |
| search | `Search Engine`, `Elasticsearch`, `OpenSearch`, `Solr`, `Algolia`, `Meilisearch` |
| analytics | `Data Warehouse`, `GCP BigQuery`, `Snowflake`, `AWS Redshift`, `ClickHouse`, `InfluxDB`, `TimescaleDB`, `Prometheus` |
| queue | `Message Queue`, `AWS SQS`, `Azure Queue Storage`, `Redis Queue` (`any queue` also selects brokers) |
| broker | `Message Broker`, `Kafka`, `AWS MSK`, `RabbitMQ`, `AWS SNS`, `AWS Kinesis`, `AWS EventBridge`, `GCP Pub/Sub`, `NATS`, `Azure Service Bus`, `Azure Event Hubs`, `Apache Pulsar`, `Redpanda` |
| storage | `Object Storage`, `AWS S3`, `GCP Cloud Storage`, `Azure Blob Storage`, `MinIO`, `Cloudflare R2`, `AWS EFS` |
| external | `Third Party API`, `Payment Gateway`, `Email Service`, `SMS Service`, `Push Service`, `Auth Service`, `Stripe`, `PayPal`, `Adyen`, `Twilio`, `SendGrid`, `Mailgun`, `Auth0`, `Okta`, `AWS Cognito`, `AWS SES`, `APNs`, `FCM`, `OpenAI`, `Google Maps` |
| other (text) | `Text Note`, `Sticky Note`, `Comment` |

## Use cases

```proschi fragment
usecase "Place order" "Checkout from the cart" {
  user -> api : POST /orders {"sku": "A1"}
  alt "Paid" {
    api ->> events : OrderPlaced {"id": "o-1"}
    api --> user   : 201 {"id": "o-1"}
  } alt "DB down" when "primary unreachable" {
    api  -x db   : INSERT order
    api --> user : 503
  }
}
```

`->` request, `->>` async (publish, enqueue), `-->` response to the latest open
request the other way, `-x` failed call, `par { … }` parallel steps. Each step
needs a connection; the entry request gets a status in every branch.

## Other blocks (top level)

`traffic`, `requirements`, `capacity` (see `proschi-capacity-plan`),
`entity Order in db { id uuid key }`, `decision "…" { because "…" }`, and
`test "…" { … }`: `"U" never waits for X`, `"U" writes X before responding`,
`"U" calls X before Y`, `"U" has scenario "S"`, `no path from X to Y`,
`X has replicas >= 2` (X = `id`, `[Tech]` or `any <kind>`).

## CLI (`import`, `share-link`: 0.9+; on `Unknown command` use `@latest`)

```sh
npx proschi@latest check file.proschi       # errors + warnings (--strict fails on warnings)
npx proschi@latest test file.proschi        # requirements and test blocks
npx proschi@latest analyze file.proschi     # load, p99, availability, cost, SPOFs
npx proschi@latest import mermaid diagram.mmd -o file.proschi      # also: import openapi
npx proschi@latest share-link file.proschi  # web-editor link; or paste at https://proschi.app/app/ → Share
```
