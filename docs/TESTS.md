# Requirements and tests

Requirements check the numbers a design must meet: latency, availability,
cost and surviving a failure. Tests check how requests flow, such as "the
redirect reads the cache before the database". Both pass or fail in the
editor's *Results* tab and in `proschi test`.

```proschi
title "Paste bin"

user  "Visitor"    [Browser]
api   "Paste API"  [REST API]   x4
cache "Hot pastes" [Redis]      x2
db    "Pastes"     [PostgreSQL] x2

user -> api   : HTTPS
api  -> cache : RESP
api  -> db    : SQL

usecase "Read paste" {
  user -> api : GET /p/{id}
  alt "Hit" {
    api -> cache : GET paste
    api --> user : 200
  } alt "Miss" {
    api -> cache : GET paste
    api -> db    : SELECT paste
    api --> user : 200
  }
}

traffic {
  "Read paste" 2k rps mix "Hit" 80%, "Miss" 20%
}

requirements {
  p99 "Read paste" < 100ms
  survive any node failure
}

test "Reads try the cache first" {
  "Read paste" calls any cache before any database
  "Read paste" scenario "Hit" never calls any database
}
test "Clients never reach a store" {
  no path from any client to any database
}
```

> **Try it:** change `x2` to `x1` on `db`, and `survive any node failure`
> fails in the *Results* tab.

## Requirements

A `requirements` block lists targets, one per line. Each becomes a check.

```proschi fragment
requirements {
  p99 "Redirect" < 50ms
  p99 "Redirect" scenario "Cache hit" < 10ms
  p95 < 300ms                 # every use case
  availability "Redirect" >= 99.95%
  availability >= 99.9%       # every use case
  durable "Shorten"
  survive any node failure
  survive failure of cache    # a node id, [Tech], or any <kind>
  cost <= 3000 usd/month
}
```

| Requirement | Holds when |
|---|---|
| Latency: `p99 "U" < 50ms` | That percentile (p50, p90, p95, p99, p999) of the use case's latency, its scenarios mixed by share, is under the limit. Without a use case, every use case with traffic is checked; `scenario "S"` checks one scenario. |
| Availability: `availability "U" >= 99.9%` | The use case's (or every use case's) availability is at least that. |
| Durability: `durable "U"` | Every success scenario writes to a durable store, synchronously, before the first request is answered. |
| Failures: `survive any node failure` | After losing any one node instance, nothing saturates and every latency target that held still holds. `survive failure of` a [selector](#selectors-and-kinds) checks only those nodes. |
| Budget: `cost <= 3000 usd/month` | Replicas plus egress cost at most that much. |

Requirements need [traffic](HLD.md#traffic): a use case without traffic is
not measured.

## Tests

A `test` block holds assertions about the use cases' steps. All must hold.

```proschi fragment
test "Checkout answers before slow work" {
  "Checkout" never waits for any queue or any external
  "Checkout" calls ledger after gateway
  any service never calls blobs
  "Retry charge" starts at any queue
}
```

In the table, U is a use case and S a scenario, each a name in quotes, and
X and Y are [selectors](#selectors-and-kinds). After U you may add
`scenario "S"` to check one scenario only.

| Assertion | Holds when |
|---|---|
| `U calls X` | Some scenario of U has a step to X. |
| `U every scenario calls X` | Every scenario of U calls X. |
| `U never calls X` | No scenario of U calls X. |
| `U calls X before Y` | In every scenario that calls Y, X is called earlier, and some scenario calls Y. |
| `U calls Y after X` | In every scenario that calls both, the last call to Y comes after the first call to X, and some scenario calls both. |
| `U never waits for X` | No synchronous call to X happens before U's first request is answered. Async sends and later calls are fine. |
| `U writes X before responding` | Every success scenario has a synchronous, successful step to X before the answer. |
| `U responds 201` | Some scenario answers with that status, or a class such as 4xx. |
| `U has scenario S` | The scenario exists. |
| `U handles failure of X` | Some success scenario of U contains a failed call to X. |
| `U starts at X` | U's first request is sent by X. |
| `X calls Y` | Some step, in any use case, is sent by X to Y. Start with `in "U"` to look at one use case. |
| `X never calls Y` | No step is sent by X to Y. |
| `no path from X to Y` | No connection or step goes directly from X to Y. |
| `X has replicas >= 2` | Every node matching X has at least that many replicas. |

An assertion that starts with a use case is about steps that reach X; one
that starts with a selector is about the sender. Order is sequence order,
requests and responses interleaved. Unknown names and empty tests are
warnings, and two tests with one name are an error.

## Selectors and kinds

Tests and the failure requirement take a selector, so a rule such as
"never calls any database" still holds when you add a database.

| Selector | Matches |
|---|---|
| `db` | The node with that id |
| `[PostgreSQL]` | Every node with that tech stack |
| `any database` | Every node of that kind (see the table below) |
| `any strong store`, `any eventual store` | Data stores with that consistency: relational databases and queues are strong; caches, most NoSQL, search, CDNs and object storage eventual. [Capacity](HLD.md#capacity) can change it. |
| `X or Y` | A node matching any of them, as in `never calls any cache or any database` |

A node's kind comes from its tech stack, or for an unknown tech, from its
name (see [Tech stacks](NODES.md#tech-stacks)):

| Kind | Tech stacks (examples) |
|---|---|
| `client` | Actor, Browser, Mobile App, shapes and nodes without a tech |
| `edge` | WAF, AWS WAF, Global Accelerator; `any edge` also selects the four kinds below |
| `cdn` | CDN, CloudFront, Fastly, Akamai, Cloudflare |
| `loadbalancer` | Load Balancer, AWS Load Balancer (ALB, NLB), nginx, Envoy, HAProxy |
| `gateway` | API Gateway, AWS API Gateway, Apigee, Kong |
| `dns` | DNS, Route53, Azure DNS, Cloud DNS |
| `service` | Service, Worker, REST API, gRPC, Spring Boot, Node.js, Kubernetes, ECS |
| `function` | Function, Lambda, Cloud Functions, Cloud Run, Cloudflare Workers |
| `cache` | Cache, Redis, Valkey, ElastiCache, Memcached |
| `database` | Database, PostgreSQL, MySQL, Aurora, DynamoDB, Cassandra, MongoDB, … |
| `search` | Search Engine, Elasticsearch, OpenSearch, Solr, Algolia |
| `analytics` | Data Warehouse, BigQuery, Snowflake, Redshift, ClickHouse |
| `queue` | Message Queue, SQS, Azure Queue Storage; `any queue` also selects brokers |
| `broker` | Kafka, Kinesis, SNS, EventBridge, Pub/Sub, RabbitMQ, NATS; simulated like a queue |
| `storage` | Object Storage, S3, Blob Storage, MinIO, R2 |
| `external` | Third Party API, Payment Gateway, Stripe, Twilio, Auth0 |
| `other` | groups, text nodes and the Note shape |

## Go further

- [High-level design](HLD.md): traffic and capacity, which the requirements
  measure.
- [Simulation and tests in CI](EDITORS.md#simulation-and-tests): run
  `proschi test` on every pull request.
