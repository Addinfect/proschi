import type { Edge, Graph, Id, Node } from '../../engine';
import { COMPOSES, DEPENDS_ON, USES } from '../../ontology/architecture';

/**
 * A model for the spike: a shop that sells one thing, at the size a real one has.
 *
 * Thirty-eight nodes, seventy-odd edges, three levels. The first version had eight
 * nodes and two levels, and it flattered the layout: every arrow pointed one rank
 * down, nothing was both near and far, and no box was entered from four places. A
 * drawing is only tested by a graph that is awkward in the ways real models are, so
 * this one is awkward on purpose -- each block below names the trouble it brings.
 *
 * - `storefront` calls `catalog`, `backoffice` reads the `ledger`: edges that skip a
 *   rank, which the layout still draws straight down through whatever sits between.
 * - `bus` and `ledger` are what everybody needs, so they are entered from four
 *   places at three ranks: anchors and lanes earn their keep here, or the fan folds.
 * - `pricing`, `cart` and others fold into `checkout` at the top level: one arrow
 *   stands for three edges and has to say so.
 * - `session-store` and `token-service` both call `identity`, the box they live in:
 *   two loops on one box, and the layout draws every loop in the same place.
 * - `checkout-repo` depends on `checkout-handlers` while the handlers use it: the
 *   cycle the checker reports, and what the rank cap makes of it.
 * - `ops` has no edge at all, and `partner-integration-gateway` is wider than its
 *   rank neighbours.
 *
 * Nothing else imports this. It exists to be looked at, and it goes away with the
 * rest of `spike/`.
 */

const part = (id: Id, name: string, layer: string): Node => ({
  id,
  type: 'module',
  name,
  attributes: { layer },
});

/** The tree: `parent` holds these. Declaration order of the nodes is what ranks read. */
const holds = (parent: Id, ...children: readonly Id[]): Edge[] =>
  children.map((child) => ({
    id: `${parent} holds ${child}`,
    relation: COMPOSES,
    source: parent,
    target: child,
  }));

/** A call at runtime: the ordinary arrow of an architecture picture. */
const uses = (source: Id, target: Id): Edge => ({
  id: `${source} uses ${target}`,
  relation: USES,
  source,
  target,
});

/** A build dependency: the direction a level draws `back` when it closes a loop. */
const needs = (source: Id, target: Id): Edge => ({
  id: `${source} needs ${target}`,
  relation: DEPENDS_ON,
  source,
  target,
});

const NODES: readonly Node[] = [
  // The top level, in the order a reader should meet it: what someone uses, then
  // what it is built from, then what everyone shares.
  part('storefront', 'storefront', 'presentation'),
  part('backoffice', 'backoffice', 'presentation'),
  part('partner-integration-gateway', 'partner integration gateway', 'presentation'),
  part('ops', 'ops', 'infrastructure'),
  part('checkout', 'checkout', 'application'),
  part('catalog', 'catalog', 'domain'),
  part('payments', 'payments', 'domain'),
  part('identity', 'identity', 'domain'),
  part('bus', 'event bus', 'infrastructure'),
  part('ledger', 'ledger', 'infrastructure'),

  // storefront
  part('storefront-web', 'storefront web', 'presentation'),
  part('storefront-mobile', 'storefront mobile', 'presentation'),
  part('storefront-shell', 'storefront shell', 'presentation'),

  // backoffice
  part('backoffice-admin', 'backoffice admin', 'presentation'),
  part('backoffice-reports', 'backoffice reports', 'presentation'),

  // partner-integration-gateway
  part('partner-gateway', 'partner gateway', 'application'),

  // checkout, and the parts of its api
  part('cart', 'cart', 'domain'),
  part('pricing', 'pricing', 'domain'),
  part('checkout-api', 'checkout api', 'application'),
  part('checkout-db', 'checkout db', 'infrastructure'),
  part('checkout-handlers', 'checkout handlers', 'application'),
  part('checkout-validation', 'checkout validation', 'application'),
  part('checkout-repo', 'checkout repository', 'infrastructure'),

  // catalog
  part('catalog-api', 'catalog api', 'application'),
  part('catalog-search', 'catalog search', 'application'),
  part('catalog-db', 'catalog db', 'infrastructure'),

  // payments
  part('payments-api', 'payments api', 'application'),
  part('payments-worker', 'payments worker', 'application'),
  part('ledger-writer', 'ledger writer', 'application'),

  // identity
  part('identity-api', 'identity api', 'application'),
  part('token-service', 'token service', 'domain'),
  part('session-store', 'session store', 'domain'),
  part('identity-db', 'identity db', 'infrastructure'),

  // bus
  part('order-topic', 'order topic', 'infrastructure'),
  part('payment-topic', 'payment topic', 'infrastructure'),
  part('audit-topic', 'audit topic', 'infrastructure'),

  // ledger
  part('ledger-db', 'ledger db', 'infrastructure'),
  part('ledger-audit', 'ledger audit', 'application'),
];

const EDGES: readonly Edge[] = [
  // What holds what.
  ...holds('storefront', 'storefront-web', 'storefront-mobile', 'storefront-shell'),
  ...holds('backoffice', 'backoffice-admin', 'backoffice-reports'),
  ...holds('partner-integration-gateway', 'partner-gateway'),
  ...holds('checkout', 'cart', 'pricing', 'checkout-api', 'checkout-db'),
  ...holds('checkout-api', 'checkout-handlers', 'checkout-validation', 'checkout-repo'),
  ...holds('catalog', 'catalog-api', 'catalog-search', 'catalog-db'),
  ...holds('payments', 'payments-api', 'payments-worker', 'ledger-writer'),
  ...holds('identity', 'identity-api', 'token-service', 'session-store', 'identity-db'),
  ...holds('bus', 'order-topic', 'payment-topic', 'audit-topic'),
  ...holds('ledger', 'ledger-db', 'ledger-audit'),

  // The way in: every front end has a back end, and they all reach for the same one.
  uses('storefront-shell', 'storefront-web'),
  uses('storefront-web', 'checkout-api'),
  uses('storefront-mobile', 'checkout-api'),
  uses('storefront-web', 'catalog-api'),
  uses('storefront-mobile', 'catalog-api'),
  uses('backoffice-admin', 'checkout-api'),
  uses('backoffice-admin', 'identity-api'),
  uses('backoffice-admin', 'audit-topic'),
  uses('backoffice-reports', 'ledger-db'),
  uses('partner-gateway', 'checkout-api'),
  uses('partner-gateway', 'identity-api'),
  uses('partner-gateway', 'token-service'),

  // The checkout, from its api inwards and outwards.
  uses('checkout-api', 'cart'),
  uses('checkout-api', 'checkout-db'),
  uses('checkout-api', 'payments-api'),
  uses('checkout-api', 'catalog-api'),
  uses('checkout-api', 'bus'),
  uses('checkout-api', 'order-topic'),
  uses('cart', 'pricing'),
  uses('cart', 'checkout-db'),
  uses('pricing', 'catalog'),
  uses('pricing', 'bus'),

  // The api's own parts, two of which also write through the api's repository.
  uses('checkout-handlers', 'checkout-validation'),
  uses('checkout-handlers', 'checkout-repo'),
  uses('checkout-validation', 'checkout-repo'),
  uses('checkout-repo', 'checkout-db'),

  // The catalog.
  uses('catalog-api', 'catalog-db'),
  uses('catalog-api', 'catalog-search'),
  uses('catalog-search', 'catalog-db'),
  uses('catalog-search', 'bus'),

  // The payments.
  uses('payments-api', 'ledger'),
  uses('payments-api', 'ledger-writer'),
  uses('payments-worker', 'payments-api'),
  uses('payments-worker', 'bus'),
  uses('payments-worker', 'ledger'),
  uses('ledger-writer', 'ledger-db'),

  // Identity, where two parts call the module they live in rather than each other.
  uses('identity-api', 'identity-db'),
  uses('identity-api', 'session-store'),
  uses('token-service', 'identity-db'),
  uses('token-service', 'session-store'),
  uses('session-store', 'identity'),
  uses('token-service', 'identity'),

  // The ledger.
  uses('ledger-audit', 'ledger-db'),

  // Build dependencies: the write paths, and one cycle the checker will report.
  needs('checkout-repo', 'checkout-handlers'),
  needs('checkout-db', 'ledger'),
  needs('checkout-db', 'ledger-db'),
  needs('ledger-writer', 'ledger'),
  needs('audit-topic', 'ledger-db'),
];

export const SHOP: Graph = { nodes: NODES, edges: EDGES };

/** The text on a box: the node's name, else its id. */
export function labelOf(id: Id): string {
  const node = SHOP.nodes.find((candidate) => candidate.id === id);
  return node?.name ?? id;
}
