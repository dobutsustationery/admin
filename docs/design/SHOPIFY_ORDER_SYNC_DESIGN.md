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

- **Green Actions (Facts):** We only persist raw facts from Shopify into the `broadcast` collection. These actions represent things that *happened* in Shopify, not the resulting state we want to reach.
- **Actions:**
  - `shopify_order_placed`: Records the fact that a new order was created with specific line items and quantities.
  - `shopify_order_cancelled`: Records the fact that specific line items in an order were cancelled.
  - `shopify_order_refunded`: Records the fact that specific line items in an order were refunded.
  - `shopify_order_reconciled`: Records the current "ground truth" state of an order as reported by Shopify at a specific timestamp.

By recording these raw facts, we ensure that if our business logic for calculating inventory impact (e.g., how to handle partial refunds) changes, we can simply replay the actions to reach the new correct state.

## 3. Reducer Responsibility

The `Inventory` and `Orders` reducers are responsible for deriving the current state from these facts:

- **Inventory Reducer:** Calculates `committedQty` for an item by summing quantities from `shopify_order_placed` and subtracting quantities from `shopify_order_cancelled` and `shopify_order_refunded`.
- **Orders Reducer:** Maintains the current state of an order by applying the sequence of Shopify events.

The ingestion logic **must not** perform this calculation; it only maps the raw Shopify payload to these "Green" actions.

## 4. Existing Local Model (important constraint)

Current inventory/order flow uses `new_order` and `package_item` / `quantify_item`. While `quantify_item` sets a target state, for the Shopify sync, we prefer the more granular "Green" actions described above to maintain a pure event log of external facts. The local reducers may internally use the same logic as `quantify_item` when processing a `shopify_order_reconciled` action.

## 5. Goals

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
3. Parse order payload into "Green" actions:
   - `shopify_order_placed({ orderID, date, email, lines: [{ itemKey, qty }] })`
   - `shopify_order_cancelled({ orderID, lines: [{ itemKey, qty }] })`
   - `shopify_order_refunded({ orderID, lines: [{ itemKey, qty }] })`
4. Dispatch actions to the broadcast collection.

Suggested initial topics:

- `orders/create` -> `shopify_order_placed`
- `orders/updated` -> logic to determine if it's a placement, cancellation, or refund
- `orders/cancelled` -> `shopify_order_cancelled`
- `refunds/create` -> `shopify_order_refunded`

### 6.2 Secondary path: Backfill/Reconciliation Poller

Scheduled job (e.g. every 10-30 minutes):

- Query Shopify orders by `updatedAt` cursor/window.
- For each order, fetch the full current state.
- Dispatch `shopify_order_reconciled({ orderID, timestamp, lines: [{ itemKey, currentQty }] })`.

This action acts as a "ground truth" fact. When the reducer sees a reconciliation action with a later timestamp than the last event it processed for that order, it can use the `currentQty` to reset the order's state, effectively healing any missed webhooks.

## 7. Idempotency Strategy

### 7.1 Event-level dedupe

Persist webhook/event ids in `shopify_order_events/{eventId}` with TTL retention. If already processed, skip.

### 7.2 Log-level idempotency

By recording facts with Shopify-provided IDs (Order ID, Line Item ID, Refund ID), we ensure that re-processing the same fact log always produces the same result. The reducer uses these IDs to avoid double-counting.

## 8. Quantity Semantics

The inventory impact is derived:
`inventoryImpact = total_placed - total_cancelled - total_refunded`

The logic for this derivation lives in the `Inventory` reducer, not in the sync layer. This allows us to adjust how "refunded" items affect inventory (e.g., do they return to stock?) by changing the reducer logic and replaying the actions.

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

