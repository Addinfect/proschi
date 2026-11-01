# High-level design

A high-level design adds what a design review asks after the architecture:
how much traffic comes in, what each node can take, what data lives where
and why. With it, the simulation can test the design, not only draw it.

Each part is a top-level block. This URL shortener uses them all, with
[requirements](TESTS.md#requirements) to check:

```proschi
title "URL Shortener" "Short codes that redirect to long URLs"

user  "Visitor"       [Browser]
api   "Shortener API" [REST API]   x12
cache "Code cache"    [Redis]      x3
db    "URL store"     [PostgreSQL] x3

user -> api   : HTTPS
api  -> cache : RESP
api  -> db    : SQL

usecase "Redirect" {
  user -> api : GET /{code}
  alt "Cache hit" {
    api -> cache : GET code
    api --> user : 301
  } alt "Cache miss" {
    api -> cache : GET code
    api -> db    : SELECT url
    api -> cache : SET code
    api --> user : 301
  }
}

usecase "Shorten" {
  user -> api  : POST /urls {"target": "https://example.com"}
  api  -> db   : INSERT url
  api --> user : 201 {"code": "k7Qz2"}
}

traffic {
  "Redirect" 100k rps mix "Cache hit" 90%, "Cache miss" 10%
  "Shorten"  1k rps
}

requirements {
  p99 "Redirect" < 100ms
  availability >= 99.9%
  durable "Shorten"
  survive any node failure
  cost <= 3000 usd/month
}

capacity {
  api 15k rps
  db  20k rps latency 4ms
}

entity Url in db "One short code and where it points" {
  code      string key
  target    string
  createdAt time   index
}

decision "Cache redirects in Redis" {
  because "Reads outnumber writes 100:1; p99 must stay under 100 ms"
  rejected "Read replicas only" "5 ms a read, many replicas at 100k rps"
}
```

> **Try it:** change the mix to `"Cache hit" 50%, "Cache miss" 50%`, open
> the example in the editor, and `survive any node failure` fails in the
> *Results* tab.

How these blocks become numbers is on
[How the simulation works](https://proschi.app/docs/model/).

- **The opening words are keywords only in that shape** (`traffic` and a
  brace, `entity` and a name), so they still work as node ids.
- **A broken line is skipped, not the block.** A malformed line is an
  error, and the rest is read. A block inside a group or use case is an
  error.

## Quantities

Every number in these blocks is a quantity: a number, an optional magnitude
(k, m or b) and a unit.

| Kind | Units | Examples |
|---|---|---|
| Rate | rps, rpm, rpd (requests per second, minute, day) | `100k rps`, `6k rpm` |
| Duration | ms, s | `50ms`, `1.5s` |
| Share or availability | % | `99.9%` |
| Cost | usd/month, usd/GB (egress price) | `3000 usd/month` |
| Bandwidth | MB/s, GB/s | `500 MB/s` |

The unit may be attached or one space away (`50ms`, `50 ms`). Rates become
requests per second (6k rpm is 100 rps). A missing or wrong unit is an error
that names the one expected.

## Traffic

Traffic is the load: requests per second for each use case, split over its
scenarios. Without it the simulation measures nothing, so add it first.

- One line per use case: its name in quotes, then a rate, as in the
  example above.
- `mix` splits the traffic over the [scenarios](SCENARIOS.md) by their full
  names ("A › B" for nested ones). Without it, all the traffic goes to the
  first scenario.
- Shares that don't add up to 100% are scaled to fit, with a warning.
- An unknown use case or scenario name is a warning. Two lines for the same
  use case are an error.

## Capacity

Every node starts with its tech stack's default
[profile](https://proschi.app/docs/model/#profiles). When you know better,
from a benchmark or production, write it here: one line per node id, parts
in any order, numbers per replica.

```proschi fragment
capacity {
  db    20k rps latency 4ms availability 99.95% cost 400 usd/month
  cache 150k rps volatile
  users reads 30k rps writes 8k rps shards 4 consistency strong
  blobs bandwidth 500 MB/s egress 0.05 usd/GB
  pay   timeout 300ms
}
```

| Part | Meaning |
|---|---|
| a rate | Requests per second, reads and writes alike |
| `reads`, `writes` | Separate read and write capacity |
| `shards` | Number of shards. A store with a single primary scales writes with shards, not replicas. |
| `size S`, `M` or `L` | Instance size: the default capacity ×1, ×2 or ×4, for ×1, ×1.8 or ×3.5 the cost. An explicit rate or cost wins. |
| `latency` | Latency per call |
| `availability` | Availability |
| `cost` | Monthly cost |
| `durable`, `volatile` | Whether a write there survives a crash |
| `consistency strong`, `consistency eventual` | Whether `any strong store` or `any eventual store` matches it |
| `bandwidth` | Network bandwidth, for transfer time |
| `egress` | Price per GB sent to clients and third parties |
| `timeout` | What a failed call to the node costs; 1 s by default |

An unknown node id is a warning, and so are `shards` or `consistency` on a
non-store. A repeated part, a rate with `reads` or `writes`, and a second
line for one node are errors.

![A load gauge for Orders DB with a capacity of 2k rps: 1.2k rps is sent, it runs hot from 1.4k (70%) and saturates at 2k (100%), so it takes 200 more rps before it runs hot and 800 more before it saturates](images/concepts/headroom.svg "Headroom: how much more load a node takes before it runs hot (70%) and before it saturates (100%).")

## Entities

An entity names a kind of record, its fields and the store that holds it,
like `Url` in the example above. Entities are documentation: the simulation
doesn't use them.

- The first line is the name, then optionally `in` and the id of the node
  that stores it, and a description in quotes.
- Then one field per line: a name, a free-form type (string, int, time)
  and any of the flags `key`, `index`, `unique` and `optional`.
- Placing an entity in a node that is not a data store (cache, database,
  search, analytics, queue, broker or storage
  [kind](TESTS.md#selectors-and-kinds)) is a warning.

## Decisions

A decision records what was chosen and why, and which options were rejected
and why. Like entities, decisions are documentation.

```proschi fragment
decision "Cache redirects in Redis" {
  because "Reads outnumber writes 100:1; p99 must stay under 50 ms"
  rejected "Read replicas only" "5 ms a read, many replicas at 100k rps"
  rejected "Memcached" "No replication; losing a node empties the cache"
}
decision "Base62 codes from a counter" because "Short and unique"
```

A decision has at most one `because` and any number of `rejected` lines
(the option, then the reason). The one-line form takes only `because`.

## Go further

- [Requirements and tests](TESTS.md): the checks on these numbers.
- [HLD documents](EDITORS.md#hld-documents): render the design as a
  document from the command line.
