# Shipped and Cost Ledger Choke Point

## Problem

`Item.shipped` is an accounting field. Any reducer that changes it is changing
inventory on hand, and therefore must also update the cost ledger with a sale or
sale reversal. Today `shipped` is a normal mutable property on `Item`, so reducer
code can update it directly and accidentally skip the ledger side effect.

The concrete failure was `shopify_refund_created`: it reduced `shipped` for the
refunded line, but did not add the matching negative sale row to the cost
ledger. Visible inventory became correct, while cost-ledger inventory remained
oversold.

## Goal

Make it impossible to change `shipped` casually. Every shipped mutation should
flow through a small set of named helper functions that update visible inventory,
cost ledger, and item history as one operation.

## Proposed API

Introduce reducer-local helpers in `src/lib/inventory.ts`:

```ts
applyShippedDelta(state, {
  itemKey,
  delta,
  saleAtMs,
  actionId,
  reason,
  history,
});

moveShippedBetweenItems(state, {
  fromKey,
  toKey,
  qty,
  saleAtMs,
  actionId,
  reason,
});

initializeShipped(state, {
  itemKey,
  shipped,
  reason,
});
```

`applyShippedDelta` should be the normal path for package, quantify, Shopify,
Etsy, live-event, cancel, refund, and order reconciliation actions. It should:

- update `state.idToItem[itemKey].shipped`
- call `recordSale` with the same signed delta
- apply loose-piece fractional logic when relevant
- append any required history
- call `reconcileItemQtyFromCostLedger` when the item has a ledger

`moveShippedBetweenItems` should be used for retyping order lines. It should
record a negative sale on the old key and a positive sale on the new key.

`initializeShipped` should be reserved for item creation and structural
migration paths where there is no sale event.

## Enforcement

Add a test or lint script that scans reducer source for direct writes to
`.shipped`:

```ts
item.shipped += qty
item.shipped -= qty
item.shipped = qty
state.idToItem[key].shipped += qty
```

The only allowed direct writes should be inside the shipped helper
implementations. Object literals such as test fixtures and new item creation
payloads are allowed.

## Replay Invariant

Add a replay invariant test against a production backup:

For every action, if an existing item's `shipped` changes because of an order,
refund, cancel, retype, or reconciliation event, the same action must also change
that item's effective cost-ledger sale quantity.

Structural exceptions must be explicitly named:

- item creation/import initialization
- JAN/subtype key migration that also migrates ledger rows
- subtype split/merge that redistributes ledger rows
- archive/recount handling

This catches the class of bug where visible inventory and cost-ledger inventory
diverge even though each route looks locally correct.

## Migration Plan

1. Add `applyShippedDelta` and move package, quantify, cancel, Shopify refund,
   Shopify reconcile, Etsy reconcile, and retype paths onto it.
2. Add the direct-write guard in tests.
3. Add the replay invariant as a separate slower test or diagnostic script.
4. Move structural writes into named helper functions so remaining exceptions are
   intentional and searchable.
