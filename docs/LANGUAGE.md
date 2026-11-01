# Proschi language reference

A Proschi document describes an architecture (nodes, groups and the
connections between them) and its use cases (request flows, step by step)
as plain text. A mistake never stops the diagram: each problem is reported
with its line and column, and the rest still renders.

```proschi
title "E-Commerce Platform"

group vpc "AWS VPC" {
  gateway "API Gateway"   [AWS API Gateway] @Platform
  orders  "Order Service" [REST API]        @Orders "Handles orders"
}
ordersDb "Orders DB"   [PostgreSQL]
events   "OrderEvents" [Kafka]

gateway -> orders   : HTTP
orders  -> ordersDb : SQL
orders  -> events   : Publish

usecase "Create order" {
  gateway -> orders : POST /api/orders json {
    "sku": "A1"
  }
  alt "Created" {
    par {
      orders -> ordersDb : INSERT order
      orders ->> events  : OrderCreated {"orderId": "o-1"}
    }
    orders --> gateway : 201 {"status": "pending"}
  } alt "Invalid payload" {
    orders --> gateway : 400 {"error": "sku required"}
  } alt "DB down" {
    orders -x ordersDb : INSERT order
    orders --> gateway : 503
  }
}
```

> **Try it:** pick "Create order › DB down" and press **Play**. The failed
> insert and the 503 are drawn in red.

The architecture is written once, and any number of use cases play over
it. The web editor, the command line and the [editor plugins](EDITORS.md)
report the same problems. *Format code* in the editor, or
[proschi fmt](EDITORS.md#formatting), indents blocks by two spaces and
lines up similar lines in columns.

## Statements

Each line of a document is one statement. Square brackets mark optional
parts, except in a tech stack such as `[Redis]`, where they are literal.

| Statement | Syntax | Where | Details |
|---|---|---|---|
| Title | `title "Text" ["Summary"]` | top level | The second string is a one-line summary. |
| Node | `id ["Name"] [Tech] [@team] ["Description"] [x3] …` | top level, group | [Nodes](NODES.md#declare-a-node) |
| Group | `group id ["Name"] [Style] … { … }` | top level, group | [Groups](NODES.md#frame-nodes-with-a-group) |
| Connection | `a -> b [.tag] [: label]` | top level, group | [Connections](NODES.md#connect-two-nodes) |
| Legend | `legend { … }` | top level | [Colors and legend](STYLING.md#colors-and-legend) |
| Direction | `direction down\|right\|up\|left` | top level, group | [Steering the layout](STYLING.md#steering-the-layout) |
| Ordered layout | `layout ordered` | top level | [Steering the layout](STYLING.md#steering-the-layout) |
| Use case | `usecase "Name" ["Description"] { … }` | top level | [Use cases](USE-CASES.md) |
| Scenario | `alt "Name" [when "condition"] { … }` | use case, scenario | [Scenarios](SCENARIOS.md) |
| Parallel steps | `par { … }` | use case, scenario | [Parallel steps](SCENARIOS.md#parallel-steps) |
| Import | `import "infra.proschi"` | top level | [Imports](IMPORTS.md) |
| System | `system id ["Name"] [@team] … { … }` | top level, group | [The system block](SYSTEMS.md#the-system-block) |
| Traffic | `traffic { … }` | top level | [Traffic](HLD.md#traffic) |
| Capacity | `capacity { … }` | top level | [Capacity](HLD.md#capacity) |
| Entity | `entity Name [in store] { … }` | top level | [Entities](HLD.md#entities) |
| Decision | `decision "Title" { … }` | top level | [Decisions](HLD.md#decisions) |
| Requirements | `requirements { … }` | top level | [Requirements](TESTS.md#requirements) |
| Test | `test "Name" { … }` | top level | [Tests](TESTS.md#tests) |
| Comment | `# …` | anywhere | To the end of the line. A `#` inside quotes or a JSON payload is text, and so is a hex color after `color`. |

The [grammar](GRAMMAR.md) has every statement in EBNF.

## Pages in this section

- [Nodes, groups and connections](NODES.md): ids, names, tech stacks,
  replicas and owners.
- [Colors, legend and layout](STYLING.md): colors, tags, layout hints and
  what canvas edits write.
- [Use cases](USE-CASES.md): step arrows, labels, payloads, fan-out, reads
  and writes.
- [Scenarios](SCENARIOS.md): success and failure paths, parallel steps and
  endpoint groups.
- [Imports](IMPORTS.md): split a design across files, local or remote.
- [Org diagrams and team systems](SYSTEMS.md): one box per team, with a
  contract.
- [High-level design](HLD.md): quantities, traffic, capacity, entities and
  decisions.
- [Requirements and tests](TESTS.md): checks on numbers and on request
  flows, and selectors.
- [Grammar](GRAMMAR.md): the whole syntax in EBNF.
