# Layout benchmark

`order-fulfillment.proschi` is a 50-node HLD rebuilt from a hand-drawn
reference diagram. It is a test fixture, not a showcase. Together with three
of the built-in examples it is measured by `layoutMetrics.test.ts`, which
checks thresholds on every test run. `npm run layout:metrics` prints the
table, and `LAYOUT_METRICS_SVG=<dir>` also writes a bare sketch of each
layout to that directory.

Columns: `unrouted` counts edges the layout gave no route (they use the
fallback), `crossings` counts edge segments that cross, the lengths are in
px, `bends` counts the turns of all edges, `overlaps` counts boxes that
overlap where neither contains the other, `throughNodes` counts edges that
cross a node that isn't one of their ends, `cornerEnds` counts edge ends
within 8 px of a corner of their node, and `aspect` is width over height.

Before: ELK layered positions, edges drawn as React Flow beziers from the
bottom handle to the top handle (the beziers were sampled; an S-curve
counts as two bends).

| fixture | nodes | edges | crossings | totalLength | maxLength | bends | overlaps | throughNodes | width | height | aspect |
|---|---|---|---|---|---|---|---|---|---|---|---|
| order-fulfillment | 50 | 57 | 116 | 81231 | 3919 | 108 | 0 | 29 | 4721 | 3174 | 1.49 |
| ecommerce | 7 | 6 | 0 | 1433 | 373 | 10 | 0 | 1 | 816 | 613 | 1.33 |
| events | 6 | 5 | 0 | 1224 | 527 | 10 | 0 | 0 | 816 | 456 | 1.79 |
| url-shortener | 5 | 4 | 0 | 495 | 266 | 4 | 0 | 0 | 528 | 612 | 0.86 |

After: orthogonal ELK routes, cycles broken by declaration order, model
order, network-simplex placement, inline labels, cards at their drawn height.

| fixture | nodes | edges | unrouted | crossings | totalLength | maxLength | bends | overlaps | throughNodes | cornerEnds | width | height | aspect |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| order-fulfillment | 50 | 57 | 0 | 17 | 58908 | 3874 | 178 | 0 | 0 | 0 | 4032 | 3016 | 1.34 |
| ecommerce | 7 | 6 | 0 | 0 | 1833 | 555 | 8 | 0 | 0 | 0 | 800 | 749 | 1.07 |
| events | 6 | 5 | 0 | 0 | 1169 | 390 | 8 | 0 | 0 | 0 | 760 | 538 | 1.41 |
| url-shortener | 5 | 4 | 0 | 0 | 492 | 306 | 2 | 0 | 0 | 0 | 520 | 498 | 1.04 |

Orthogonal routes are longer than beziers between the same points, so total
length on the small examples is not directly comparable. The ecommerce
example is also taller because ELK now leaves room for each label.

Tried and dropped: network-simplex placement with movable ports (shorter
edges, but ports slid onto node corners), a second layout pass that gives
busy nodes ports on their left and right sides (23 crossings, 13% longer),
and layering every edge by declaration order, not only cycles (9 crossings
and 46,629 px on the fixture, but it turns edges upward in documents whose
order isn't top-down). That one is now opt-in as `layout ordered` (below).

## With layout hints

`order-fulfillment-hinted.proschi` is the same diagram with the hints an
author would add to steer it towards the reference (docs/STYLING.md,
"Steering the layout"): `layout ordered`, `rank 0` on the third-party
systems around the Order Fulfillment API, `rank 1` to `rank 4` on AWS
region 1, region 2, the Kafka cluster and GCP, and `direction right` in the
Kafka cluster so its topics form one row. `layoutMetrics.test.ts` checks its
thresholds and its shape: one aligned top row, the four groups one below the
other, the topics side by side.

| fixture | nodes | edges | unrouted | crossings | totalLength | maxLength | bends | overlaps | throughNodes | cornerEnds | width | height | aspect |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| no hints | 50 | 57 | 0 | 17 | 58908 | 3874 | 178 | 0 | 0 | 0 | 4032 | 3016 | 1.34 |
| `layout ordered` | 50 | 57 | 0 | 11 | 49121 | 3145 | 175 | 0 | 0 | 0 | 2721 | 3590 | 0.76 |
| ordered + group ranks | 50 | 57 | 0 | 13 | 49993 | 3386 | 223 | 0 | 0 | 0 | | | |
| ordered + top row + group ranks | 50 | 57 | 0 | 33 | 58681 | 3911 | 235 | 0 | 0 | 0 | | | |
| ordered + `direction right` in Kafka | 50 | 57 | 0 | 26 | 49455 | 3327 | 219 | 0 | 0 | 0 | | | |
| order-fulfillment-hinted (all of them) | 50 | 57 | 0 | 9 | 61038 | 3694 | 225 | 0 | 0 | 0 | 3429 | 3768 | 0.91 |

The committed hints give the fewest crossings and the reference's shape:
externals in one row on top, region 2 above the Kafka cluster (not below
it), the topics in one row and GCP at the bottom. They cost about 20% more
edge length than `layout ordered` alone, mostly because one aligned top row
stretches the edges of externals that the plain layering would put next to
their partners. `layout ordered` alone gives the shortest layout, but its
externals are scattered over several rows.

The partial combinations show that ELK's crossing minimization swings a lot
on this graph. One rank more or less moves the count by ten or more in
either direction (the top row alone: 33, with Hurrier and the Vendor
Service ranked beside GCP: 27, with the Kafka row on top of that: 9), so
crossings are a check here, not something to tune one hint at a time.
Only two costs are steady: ranks align rows at the price of edge length,
and a group with its own direction keeps its members in one order. The
order it keeps is the order a layout with the group in the main flow would
give them.

How the engine does it (autoLayout.ts):

- `rank`: in each container that has ranked children, autoLayout computes
  the layers itself, with network simplex like ELK, and passes them to ELK's
  interactive layering as positions. With a single harmless rank the fixture
  gets 13 crossings, against 11 with ELK's own layering. Connected nodes of one rank can't share a layer (layered layouts
  have no edges within a layer), so the target goes one layer lower. That's
  why the regions have ranks 1 and 2 and not one shared rank. ELK turns a
  centred label into a node of its own before layering, and interactive
  layering can't place it, so in these containers each label is a real
  stand-in node in a layer of its own, which the edge runs through.
- `direction` in a group: with INCLUDE_CHILDREN, ELK gives every group the
  root's direction, so a group with its own direction is laid out on its
  own (its members in the order a first layout with the group in the main
  flow gives them) and placed as one box. Edges across its border end at fixed ports
  straight across from the member they reach, and a short straight leg
  joins the port and the member. ELK can't route those legs around other
  members, so a port goes on whichever side has a clear way in.

## Declaration order and spread edge ends

`microservices.proschi` recreates a published microservices diagram, written
in its reading order (it uses `layout ordered` and group ranks). Two more
columns measure what it needs: `outOfOrder` counts pairs of siblings side by
side in one row with the one declared later on the left, and `crowdedEnds`
counts pairs of edge ends on one node less than 20 px apart.

layoutGraph now tries up to four layouts: as is, with every group's members
forced into declaration order (ELK's `forceNodeModelOrder` on groups), and
each of those mirrored (ELK gets every list reversed and the result is turned
back; not when a group has its own direction). It keeps the one with the
fewest crossings, then the fewest siblings out of order, so crossings never go
up. Edges through one port of a group with its own direction now part just
before the member instead of meeting it in one point.

| fixture | crossings before | after | outOfOrder before | after | crowdedEnds before | after |
|---|---|---|---|---|---|---|
| order-fulfillment | 17 | 17 | 20 | 20 | 0 | 0 |
| order-fulfillment-hinted | 9 | 9 | 36 | 36 | 9 | 0 |
| microservices | 2 | 0 | 12 | 5 | 0 | 0 |

The microservices services now come out A, B, C (they were C, A, B), and the
registry, auth server and logging are no longer mirrored. The five pairs left
out of order would each cost crossings. Tried and dropped: forcing
declaration order everywhere (78 crossings on the hinted fixture, 11 on
microservices), only in groups as the one layout (32 and 29 on the two
order-fulfillment fixtures), ELK's `crossingCounterNodeInfluence` (13 on the
hinted fixture, and very slow), and one port per edge end on a group with its
own direction (13 to 28 crossings on the hinted fixture, depending on the
order of the ports).
