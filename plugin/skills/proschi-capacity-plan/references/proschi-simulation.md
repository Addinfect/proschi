# Proschi simulation and HLD blocks

The blocks that carry load, targets and checks, and the numbers the
simulation starts from. Full reference:
<https://proschi.app/docs/hld/>; how the model works:
<https://proschi.app/docs/model/>.

## Blocks (all optional, top level)

```proschi fragment
traffic {
  "Place order" 200 rps mix "Paid" 95%, "Invalid" 4%, "DB down" 1%
  # Without mix, all traffic goes to the first scenario.
  "Get order" 2k rps
}
requirements {
  # p50 p90 p95 p99 p999; without a name, every use case.
  p99 "Place order" < 300ms
  p99 "Get order" scenario "Hit" < 20ms
  availability >= 99.9%
  # Writes a durable store before responding.
  durable "Place order"
  # Or: survive failure of db / [Redis] / any cache.
  survive any node failure
  cost <= 2000 usd/month
}
# Per-replica overrides, one line per node.
capacity {
  db    reads 30k rps writes 5k rps shards 2 latency 4ms
  api   2k rps cost 120 usd/month
  cache 150k rps availability 99.95%
  pay   timeout 300ms
  web   size M
}
entity Order in db "One placed order" {
  id     uuid   key
  userId uuid   index
  total  int
  note   string optional
}
decision "Publish OrderPlaced to Kafka" {
  because "Email and analytics must not slow down checkout"
  rejected "Call email service inline" "Adds 200 ms and couples availability"
}
decision "Postgres for orders" because "Transactions across order lines"
test "Checkout never waits for email" {
  "Place order" never waits for any queue or any external
  "Place order" writes db before responding
  "Place order" has scenario "DB down"
  "Get order" calls any cache before any database
  no path from user to any database
  api has replicas >= 2
}
```

- `mix` names are the `alt` names (`A › B` when nested); shares add to 100%.
- `capacity` parts: a rate, `reads`/`writes`, `shards` (a single-primary
  store scales writes with shards, not replicas), `size S|M|L` (capacity ×1,
  ×2, ×4 for cost ×1, ×1.8, ×3.5), `latency`, `availability`, `cost`,
  `durable`/`volatile`, `consistency strong|eventual`, `bandwidth`,
  `egress`, `timeout` (what a failed call costs; 1 s by default).
- Quantities: `200 rps`, `6k rpm`, `1m rpd`, `50ms`, `1.5s`, `99.9%`,
  `400 usd/month`, `500 MB/s`, `0.05 usd/GB`; magnitudes `k`, `m`, `b`.

Test assertions (U = `"use case"`, optional `scenario "S"` after it; X/Y =
selector: `id`, `[Tech]`, `any <kind>`, `any strong store`, `any eventual
store`, `X or Y`): `U calls X`, `U every scenario calls X`, `U never calls X`,
`U calls X before Y`, `U calls Y after X`, `U never waits for X`,
`U writes X before responding`, `U responds 201|2xx|4xx`, `U has scenario S`,
`U handles failure of X` (a *success* scenario survives a `-x` to X: a
fallback), `U starts at X`, `[in U] X calls Y`, `[in U] X never calls Y`,
`no path from X to Y`, `X has replicas >= n`.

## Defaults per replica (override in `capacity`)

| Kind | Capacity | Latency | Availability | Cost/month |
|---|---|---|---|---|
| service | 2k rps | 10 ms | 99.5% | $100 |
| function | 10k | 25 ms | 99.95% | $200 |
| gateway | 10k | 10 ms | 99.95% | $100 |
| loadbalancer | 100k | 2 ms | 99.99% | $50 |
| cdn | 200k | 5 ms | 99.99% | $100 |
| cache | 100k | 1 ms | 99.9% | $150 |
| relational db | 20k reads / 5k writes per shard (replicas add reads only) | 5 ms | 99.95% | $400 |
| NoSQL db | 20k | 5 ms | 99.99% | $500 |
| search | 3k | 15 ms | 99.9% | $400 |
| queue, broker | 50k | 5 ms | 99.99% | $200 |
| storage | 5k | 30 ms | 99.99% | $50 |
| external | 1k | 200 ms | 99.9% | $0 |

Latency of a hop grows as base ÷ (1 − utilisation); p99 ≈ 3 × mean of the
slowest scenario carrying ≥ 1% of traffic. A node at 100% is saturated and
fails every latency requirement it is on. n replicas: availability
1 − (1 − a)ⁿ. A `-x` costs its timeout (1 s default). Use case labels: a
request's `x200` prefix is a fan-out (200 calls), `~2MB` a payload size
(transfer time and egress). POST/PUT/PATCH/DELETE write, GET reads; without
a method, a write verb (INSERT, UPDATE, SET, PUBLISH, …) writes; a request to
a queue always writes.
