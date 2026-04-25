# Etsy Order Sync Design

> **Status: Draft** - Ingest Etsy orders (Receipts) into our event-sourced system and update inventory as orders arrive.
> **Implementation Plan:** (TBD)

## 1. Problem

Orders from Etsy are not yet synchronized into our inventory workflow. We need a robust, idempotent way to ingest these orders, similar to our Shopify integration, to ensure accurate stock levels across platforms.

We need:
- Near-real-time ingestion via Etsy webhooks.
- Scheduled reconciliation to catch missed events.
- Deterministic inventory impact (JAN + Subtype mapping).
- Safe replay and idempotency.

## 2. "Facts vs. Intent" Philosophy

This design follows the established "Facts vs. Intent" philosophy of the `admin2` architecture.

- **Green Actions (Facts):** We persist literal API responses from Etsy into the `broadcast` collection. These are raw facts as reported by Etsy.
- **Actions:**
  - `etsy_order_created`: Raw payload from `receipt.created` webhook or API.
  - `etsy_order_updated`: Raw payload from `receipt.updated` webhook or API.
  - `etsy_order_reconciled`: Raw payload for a single receipt fetched during polling.

By recording raw responses, we can evolve our parsing logic without losing historical data.

## 3. Reducer Responsibility

The `Inventory` and `Orders` reducers are responsible for deriving state from these raw Etsy facts:
- **Mapping:** Mapping Etsy transactions to local inventory item keys (JAN + Subtype).
- **Inventory Impact:** Calculating adjustments to `shipped` quantities based on receipt status and transaction details.
- **Order State:** Maintaining a local representation of the Etsy receipt.

The ingestion layer (webhook handler/poller) simply wraps the Etsy response in a broadcast action.

## 4. Source of Truth and Keys

- **Remote Order Key:** `etsyReceiptId` (The `receipt_id` from Etsy API).
- **Local Order Key:** `orderID = "etsy:<etsyReceiptId>"`.
- **Remote Line Key Preference:**
  1. `sku` on the transaction object.
  2. Fallback to JAN/subtype extraction from the listing title or variation properties (performed by the reducer).

## 5. Ingestion Architecture

### 5.1 Primary Path: Webhooks (Etsy v3)

Webhook receiver (Firebase Function):
1. Verify Etsy webhook signature (using the shared secret).
2. Deduplicate by webhook event ID.
3. Dispatch raw payload:
   - `etsy_order_created({ payload: <raw_etsy_receipt_object> })`
   - `etsy_order_updated({ payload: <raw_etsy_receipt_object> })`

### 5.2 Secondary Path: Reconciliation Poller

Scheduled job (e.g., every 15-30 minutes):
1. Query Etsy receipts using the `getShopReceipts` endpoint.
2. Filter by `min_last_modified_timestamp` using a persistent cursor.
3. For each changed receipt, fetch the full current state.
4. Dispatch `etsy_order_reconciled({ payload: <raw_etsy_receipt_object> })`.

## 6. Idempotency Strategy

### 6.1 Event-level Dedupe
Persist Etsy event IDs in `etsy_order_events/{eventId}` with TTL.

### 6.2 Log-level Idempotency
The reducer uses Etsy's internal timestamps and status fields to ensure out-of-order events don't regress state. A `reconciledTimestamp` track is maintained per order, similar to the Shopify implementation.

## 7. Quantity Semantics

Inventory impact is derived from the receipt and its transactions:
`inventoryImpact = sum(transaction.quantity)` for all non-cancelled transactions in a valid receipt.

Cancelled receipts (e.g., status "cancelled" or refunded transactions) will result in a zero or reduced inventory impact.

## 8. Data Model Additions

Proposed Firestore collections:
```ts
// Dedupe
etsy_order_events/{eventId}

// Reconciliation state
etsy_order_sync_state/default {
  lastReceiptModifiedTimestamp: number;
  lastRunAt: number;
}
```

## 9. Rollout Plan

1. Implement Etsy OAuth 2.0 credential management (if not already present).
2. Implement Etsy webhook receiver + signature validation.
3. Define `etsy_order_*` actions and update `Inventory` reducer mapping logic.
4. Add the reconciliation poller with persistent cursor.
5. Add UI visibility for Etsy sync health.

## 10. Open Questions

- Does Etsy provide a single `updated_at` for the whole receipt that catches all transaction changes?
- How to handle Etsy "Variations" mapping when SKU is missing (extraction logic).
