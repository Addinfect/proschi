import type { Graph, Id } from '../../engine';
import { COMPOSES, DEPENDS_ON, USES } from '../../ontology/architecture';

/**
 * A model for the spike, written by hand: a shop that sells one thing.
 *
 * Two levels, so that opening a box has something to show, and every kind of
 * edge a level can have, so that the drawing is checked by the eye rather than by
 * a promise: two relations between the same pair of boxes (`checkout` and
 * `payments` are joined by `uses` and by `depends-on`), edges that run inside one
 * box and are only drawn once it is opened, and three edges that leave `checkout`
 * and are lifted to its boundary.
 *
 * Nothing else imports this. It exists to be looked at, and it goes away with the
 * rest of `spike/`.
 */

const part = (id: Id, name: string, layer: string) => ({
  id,
  type: 'module',
  name,
  attributes: { layer },
});

export const SHOP: Graph = {
  nodes: [
    part('storefront', 'storefront', 'presentation'),
    part('checkout', 'checkout', 'application'),
    part('checkout-api', 'checkout api', 'application'),
    part('checkout-db', 'checkout db', 'infrastructure'),
    part('payments', 'payments', 'domain'),
    part('payments-api', 'payments api', 'application'),
    part('ledger', 'ledger', 'infrastructure'),
    part('bus', 'event bus', 'infrastructure'),
  ],
  edges: [
    { id: 'e1', relation: COMPOSES, source: 'checkout', target: 'checkout-api' },
    { id: 'e2', relation: COMPOSES, source: 'checkout', target: 'checkout-db' },
    { id: 'e3', relation: COMPOSES, source: 'payments', target: 'payments-api' },
    { id: 'e4', relation: COMPOSES, source: 'payments', target: 'ledger' },
    { id: 'e5', relation: USES, source: 'checkout-api', target: 'payments-api' },
    { id: 'e6', relation: USES, source: 'checkout-api', target: 'bus' },
    { id: 'e7', relation: USES, source: 'storefront', target: 'checkout-api' },
    { id: 'e8', relation: USES, source: 'payments-api', target: 'ledger' },
    { id: 'e9', relation: DEPENDS_ON, source: 'checkout-db', target: 'ledger' },
  ],
};

/** The text on a box: the node's name, else its id. */
export function labelOf(id: Id): string {
  const node = SHOP.nodes.find((candidate) => candidate.id === id);
  return node?.name ?? id;
}
