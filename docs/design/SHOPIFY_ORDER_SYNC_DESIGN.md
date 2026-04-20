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

This design strictly follows the "Facts vs. Intent" philosophy of the `admin2` architecture, with a strong emphasis on raw data.

- **Green Actions (Facts):** We persist the *literal API responses* from Shopify into the `broadcast` collection. These are the raw, undeniable facts as reported by the external source.
- **Actions:**
  - `shopify_order_created`: The raw payload from an `orders/create` webhook or API response.
  - `shopify_order_updated`: The raw payload from an `orders/updated` webhook or API response.
  - `shopify_order_cancelled`: The raw payload from an `orders/cancelled` webhook.
  - `shopify_refund_created`: The raw payload from a `refunds/create` webhook.
  - `shopify_order_reconciled`: The raw payload for a single order fetched during a reconciliation/polling process.

By recording these raw API responses, we ensure that:
1. We never lose information by mapping to an intermediate format.
2. If our understanding of the Shopify API changes (e.g., how to interpret a specific field), we can simply update the reducer logic and replay history.
3. The ingestion layer remains extremely simple and stable.

## 3. Reducer Responsibility

The `Inventory` and `Orders` reducers are solely responsible for deriving the current state from these raw facts:

- **Parsing logic:** All logic for mapping Shopify line items to local inventory item keys (JAN + Subtype) and calculating quantities lives inside the reducer.
- **Inventory Reducer:** Processes the raw payloads to calculate `shipped` quantity adjustments.
- **Orders Reducer:** Processes the raw payloads to maintain the current state of a local order.

The ingestion logic (webhook handler or poller) **must not** perform any mapping or filtering beyond basic deduplication. It simply wraps the Shopify response in a broadcast action.

## 4. Existing Local Model (important constraint)

Current inventory/order flow uses `new_order` and `package_item` / `quantify_item`. While `quantify_item` sets a target state, for the Shopify sync, we prefer the more granular "Green" actions described above to maintain a pure event log of external facts. The local reducers may internally use the same logic as `quantify_item` when processing a `shopify_order_reconciled` action.

## 5. Goals

- Sync Shopify orders into local orders.
- Update inventory shipped quantities as orders come in.
- Handle updates/cancellations/refunds idempotently using raw data.
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
  2. fallback mapping by JAN/subtype rules if SKU absent (performed by the reducer)

Unknown SKU/JAN should be handled by the reducer (e.g., by logging a warning in the state or creating a "stub" item if appropriate, though usually we want mapping to exist first).

## 6. Ingestion Architecture

### 6.1 Primary path: Webhooks

Webhook receiver (Firebase Function):

1. Verify Shopify HMAC signature.
2. Deduplicate by webhook/event id.
3. Dispatch the raw payload:
   - `shopify_order_created({ payload: <raw_shopify_order_object> })`
   - `shopify_order_updated({ payload: <raw_shopify_order_object> })`
   - `shopify_order_cancelled({ payload: <raw_shopify_order_object> })`
   - `shopify_refund_created({ payload: <raw_shopify_refund_object> })`

### 6.2 Secondary path: Backfill/Reconciliation Poller

Scheduled job (e.g. every 10-30 minutes):

- Query Shopify orders by `updatedAt` cursor/window.
- For each order, fetch the full current state.
- Dispatch `shopify_order_reconciled({ payload: <raw_shopify_order_object> })`.

This action acts as a "ground truth" fact. When the reducer sees a reconciliation action with a later timestamp than the last event it processed for that order, it can use the current state in the payload to reset the order's state.

## 7. Idempotency Strategy

### 7.1 Event-level dedupe

Persist webhook/event ids in `shopify_order_events/{eventId}` with TTL retention. If already processed, skip.

### 7.2 Log-level idempotency

By recording facts with Shopify-provided IDs (Order ID, Line Item ID, Refund ID), we ensure that re-processing the same fact log always produces the same result. The reducer uses these IDs to avoid double-counting. For example, if a `shopify_order_updated` action is received twice (and slips through the dedupe layer), the reducer should see that the order state for that specific update timestamp or version has already been applied.


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
3. Dispatch `shopify_order_*` actions via broadcast.
4. Add reconciliation poller using `updatedAt` cursor.
5. Add UI visibility for sync exceptions and last order sync health.

## 12. Open Questions

- Quantity policy: order-created vs paid vs fulfilled semantics.
- How to map lines without SKU reliably (JAN in title/properties fallback rules).
- Whether to ingest customer/shipping metadata into local order model in v1.

