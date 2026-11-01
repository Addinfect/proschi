# Nodes, groups and connections

Nodes are the boxes of a Proschi diagram, groups frame several of them, and
connections are the arrows between them. Use cases and the simulation run
on this architecture.

```proschi
title "Notes app"

user "Reader" [Browser]

group app "App cluster" [Service Group] {
  api    "Notes API"    [REST API]   @Platform x3 "Reads and writes notes"
  worker "Search index" [Worker]     @Search
}
db    "Notes DB"    [PostgreSQL] x2
index "Note search" [Elasticsearch]
tip   "Tip" [Text Note] "Replicas are per node: x3 means three API instances"

user   -> api    : HTTPS
api    -> db     : SQL
api    -> worker : note changed
worker -> index  : index note
```

> **Try it:** change `[PostgreSQL]` to `[MongoDB]` on `db`, and the Notes DB
> box gets the MongoDB icon.

## Declare a node

A node is an id followed by optional parts, in any order:

| Part | Example | Meaning |
|---|---|---|
| id | `api` | Letters, digits and underscores, not starting with a digit. |
| first string | `"Notes API"` | The display name. Without it the box shows the id. |
| second string | `"Reads and writes notes"` | The description. |
| tech stack | `[REST API]` | A technology from the catalog. It sets the icon, the [kind](TESTS.md#selectors-and-kinds) and the default simulation numbers. See [Tech stacks](#tech-stacks). |
| owner | `@Platform` | The team that owns the node. |
| replicas | `x3` | The number of instances that share the load. |

A node may also take `color`, a `.tag`, `critical` and `rank N` (see
[Colors, legend and layout](STYLING.md)), and `pos x,y`, which the editor
writes when you drag a box.

The tech stacks Text Note, Sticky Note and Comment make text nodes. The
description, or else the name, becomes the text.

## Frame nodes with a group

```proschi fragment
group vpc "AWS VPC" [Network Boundary] {
  api [REST API]
}
```

A group holds nodes, nested groups and connections. The optional style,
written like a tech stack, is Logical Group (the default), Network
Boundary, Security Zone or Service Group, and sets how the frame is drawn.
The header also takes `pos`, `color`, a `.tag` and `rank`, and the block a
[direction](STYLING.md#steering-the-layout). A node inside a group keeps its
plain id everywhere in the document.

## Connect two nodes

```proschi fragment
api -> db .planned : SQL
```

A connection is an edge of the architecture: two ids, an arrow and an
optional label after the colon. The label runs to the end of the line, so a
`.tag` goes before the colon.

An id that was never declared becomes a plain node. Use case steps follow
connections; see
[Steps follow the architecture](USE-CASES.md#steps-follow-the-architecture).

## Tech stacks

The catalog has about 210 technologies, and the editor and the language
server complete them. Each answers to the names people usually write: S3,
Amazon S3 and AWS S3 are one tech, and so are Postgres and PostgreSQL, or
k8s and Kubernetes. Case, spaces, punctuation and a trailing version don't
matter (route 53, nodejs, PostgreSQL 16).

| Group | Examples |
|---|---|
| Generic, one per kind | `Service`, `Worker`, `Database`, `NoSQL Database`, `Cache`, `Message Queue`, `Object Storage`, `CDN`, `Load Balancer`, `API Gateway`, `DNS`, `WAF`, `Function`, `Search Engine`, `Data Warehouse` |
| Services and runtimes | `REST API`, `gRPC`, `GraphQL`, `WebSocket`, `Spring Boot`, `Kotlin`, `Java`, `Go`, `Node.js`, `Python`, `Django`, `FastAPI`, `.NET`, `Kubernetes`, `Docker`, `AWS ECS`, `AWS EKS`, `GCP GKE`, `Azure AKS` |
| Functions | `AWS Lambda`, `GCP Cloud Functions`, `GCP Cloud Run`, `Azure Functions`, `Cloudflare Workers` |
| Relational and NoSQL | `PostgreSQL`, `MySQL`, `MariaDB`, `SQL Server`, `Oracle`, `AWS Aurora`, `AWS RDS`, `GCP Cloud SQL`, `CockroachDB`, `GCP Spanner`, `DynamoDB`, `Cassandra`, `ScyllaDB`, `MongoDB`, `Azure Cosmos DB`, `Neo4j`, `etcd` |
| Caches | `Redis`, `Valkey`, `Memcached`, `AWS ElastiCache`, `GCP Memorystore`, `Hazelcast` |
| Queues and brokers | `AWS SQS`, `Kafka`, `AWS Kinesis`, `AWS SNS`, `RabbitMQ`, `GCP Pub/Sub`, `NATS`, `AWS EventBridge`, `Azure Service Bus`, `Apache Pulsar`, `Redpanda` |
| Search and analytics | `Elasticsearch`, `OpenSearch`, `Solr`, `GCP BigQuery`, `Snowflake`, `AWS Redshift`, `ClickHouse`, `InfluxDB`, `TimescaleDB` |
| Storage | `AWS S3`, `GCP Cloud Storage`, `Azure Blob Storage`, `MinIO`, `Cloudflare R2` |
| Edge | `AWS CloudFront`, `Fastly`, `Akamai`, `Cloudflare`, `AWS Load Balancer`, `nginx`, `Envoy`, `HAProxy`, `Kubernetes Ingress`, `AWS API Gateway`, `Kong`, `AWS Route53`, `AWS WAF` |
| External | `Stripe`, `PayPal`, `Twilio`, `SendGrid`, `Auth0`, `Okta`, `APNs`, `FCM`, `Payment Gateway`, `Third Party API` |

### When the catalog lacks your tech

An unknown tech is a warning, not an error. The node keeps your text and
takes the kind its name suggests: `[TigerBeetle DB]` is a database, `[Acme
Queue]` a queue. Without a telling word it takes the kind of the closest
catalog tech (`[Postgress]` is a database), or else it is a service. It is
never a client, so it always has a capacity, a latency and a price. The
warning names the closest match, and the language server offers to
replace it:

```text
Unknown tech stack 'Postgress'. Did you mean 'PostgreSQL'?
Until then it is simulated as a generic database, like [Database]
```

To keep a product name without the warning, use the generic tech of its
kind (`[Database]`, `[Message Queue]`) and put the product in the name or
description.

## Go further

- [Colors, legend and layout](STYLING.md): style the boxes and steer where
  they go.
- [Use cases](USE-CASES.md): request flows over these connections.
