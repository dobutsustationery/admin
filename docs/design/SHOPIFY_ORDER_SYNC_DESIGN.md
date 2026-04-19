# Shopify Order Sync Design

> **Status: Active** - Ingest Shopify orders into our event-sourced system and update inventory as orders arrive.
> **Implementation Plan:** [SHOPIFY_ORDER_SYNC_IMPLEMENTATION_PLAN.md](SHOPIFY_ORDER_SYNC_IMPLEMENTATION_PLAN.md)

## 1. Problem

Orders are not yet synchronized from Shopify into our inventory/order workflow in a robust, idempotent way.

We need:

- Near-real-time order ingestion.
- Deterministic inventory impact.
- Safe replay/idempotency.
- Recovery when webhooks are missed.

## 2. "Facts vs. Intent" Philosophy

This design strictly follows the "Facts vs. Intent" philosophy of the `admin2` architecture.

- **Green Actions (Facts):** We only persist raw facts from Shopify into the `broadcast` collection.
- **Actions:**
  - `new_order`: Records the fact that a new order exists with specific metadata.
  - `quantify_item`: Records the fact that a specific order line has a target quantity.

By using `quantify_item` (target state) instead of incremental deltas, we ensure idempotency and allow for safe replay of the action log.

## 3. Existing Local Model (important constraint)

Current inventory/order flow uses:

- `new_order` to create/update `orderIdToOrder`.
- `package_item` / `quantify_item` to update order line quantities and `item.shipped`.

`quantify_item` is useful for idempotent sync because it sets target quantity per order line (instead of always incrementing).

## 3. Goals

- Sync Shopify orders into local orders.
- Update inventory shipped quantities as orders come in.
- Handle updates/cancellations/refunds idempotently.
- Prevent duplicate application of the same webhook/event.

## 4. Non-goals

- Full fulfillment workflow replacement.
- Multi-store support in v1.
- Historical analytics beyond operational sync correctness.

## 5. Source of Truth and Keys

- Remote order key: `shopifyOrderId` (numeric GraphQL/REST id normalized as string).
- Local order key: `orderID = "shopify:<shopifyOrderId>"`.
- Remote line key preference:
  1. `sku` -> map directly to local inventory item key
  2. fallback mapping by JAN/subtype rules if SKU absent

Unknown SKU/JAN should be recorded as sync exceptions (not silently ignored).

## 6. Ingestion Architecture

### 6.1 Primary path: Webhooks

Webhook receiver (Firebase Function):

1. Verify Shopify HMAC signature.
2. Deduplicate by webhook/event id.
3. Parse order payload into canonical internal model.
4. Dispatch broadcast actions:
   - `new_order({ orderID, date, email, product })`
   - per mapped line: `quantify_item({ orderID, itemKey, qty })`
5. Record processing event/log.

Suggested initial topics:

- `orders/create`
- `orders/updated`
- `orders/cancelled`
- `refunds/create` (or equivalent order update handling with refunded quantities)

References:

- https://shopify.dev/docs/apps/build/webhooks/subscribe
- https://shopify.dev/docs/api/admin-rest/2025-07/resources/webhook#event-topics-orders-create

### 6.2 Secondary path: Backfill/Reconciliation Poller

Scheduled job (e.g. every 10-30 minutes):

- Query Shopify orders by `updatedAt` cursor/window.
- Recompute canonical desired order line quantities.
- Re-apply `quantify_item` target state for each order.

This heals missed webhooks and guarantees eventual consistency.

## 7. Idempotency Strategy

### 7.1 Event-level dedupe

Persist webhook/event ids in `shopify_order_events/{eventId}` with TTL retention.

If already processed, skip.

### 7.2 State-level idempotency

Always use `quantify_item` with target quantity per order line (not incremental deltas).

This makes replays safe:

- duplicate event -> no net change
- out-of-order update -> later reconciliation corrects state

## 8. Quantity Semantics

Define one clear quantity policy in v1:

- `committedQty = paid/authorized quantity - cancelled - refunded`

`committedQty` is what we mirror into local order lines and thus into `item.shipped` via `quantify_item`.

If fulfillment-based semantics are preferred later, introduce policy versioning.

## 9. Data Model Additions

Proposed Firestore support collections:

```ts
// Dedupe and observability
shopify_order_events/{eventId}

// Reconciliation cursor/state
shopify_order_sync_state/default {
  lastOrderUpdatedAtCursor: string; // ISO UTC
  lastRunAt: number;
}

// Optional canonical mirror for debugging/replay
shopify_orders_mirror/{shopifyOrderId} {
  updatedAt: string;
  committedLines: Array<{ itemKey: string; qty: number }>;
  source: "webhook" | "reconcile";
}
```

## 10. Failure Handling

- Unknown SKU mapping:
  - write sync exception event with order id + line details
  - keep order ingested for known lines
- Shopify API transient failure:
  - retry with exponential backoff
  - rely on reconciliation poller for eventual catch-up
- Signature validation failure:
  - reject request, log security event

## 11. Rollout Plan

1. Implement webhook receiver + HMAC validation + dedupe store.
2. Implement mapping layer from Shopify line items -> local item keys.
3. Dispatch `new_order` + `quantify_item` actions via broadcast.
4. Add reconciliation poller using `updatedAt` cursor.
5. Add UI visibility for sync exceptions and last order sync health.

## 12. Open Questions

- Quantity policy: order-created vs paid vs fulfilled semantics.
- How to map lines without SKU reliably (JAN in title/properties fallback rules).
- Whether to ingest customer/shipping metadata into local order model in v1.

