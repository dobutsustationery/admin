# Shopify Order Sync Implementation Plan

> **Status: Draft**
> **Related Design:** [SHOPIFY_ORDER_SYNC_DESIGN.md](SHOPIFY_ORDER_SYNC_DESIGN.md)

This document outlines the detailed implementation and testing plan for the Shopify Order Sync feature.

## Goal

Implement a robust, idempotent ingestion pipeline for Shopify orders that updates local inventory state using "Green" actions (`new_order`, `quantify_item`).

## Phase 1: Environment Setup

### 1.1 Shopify Development Store
- Create a new development store in the Shopify Partner Dashboard (or use an existing one).
- Populate the store with test products that have SKUs matching existing `InventoryItemKey` formats in our local environment (e.g., `JANCODE:SUBTYPE`).

### 1.2 Custom App Creation
- Create a Custom App in the Shopify Admin.
- Configure **Admin API integration** with the following scopes:
    - `read_orders`
    - `read_products`
    - `read_inventory`
- Store the **Admin API Access Token** and **API Secret Key** (for HMAC verification) securely.

### 1.3 Local Webhook Testing
- Use a tunnel service (e.g., `ngrok` or `cloudflared`) to expose the local Firebase Functions emulator port (typically `5001`).
- Configure Shopify Webhooks (`orders/create`, `orders/updated`, `orders/cancelled`) to point to the tunnel URL: `https://<tunnel-id>.ngrok-free.app/<project-id>/us-central1/shopifyOrderWebhook`.

## Phase 2: Ingestion Logic

### 2.1 Firebase Function: `shopifyOrderWebhook`
- Implement a new Firebase Function (v2) `shopifyOrderWebhook`.
- **HMAC Verification:** Validate every request using the `X-Shopify-Hmac-Sha256` header and the stored API Secret Key.
- **Raw Persistence:** Write the raw payload to a `shopify_order_webhooks` collection *before* processing. This ensures we can re-process if the logic changes (following the "Facts" philosophy).
- **Deduplication:** Check `shopify_order_events/{shopify_event_id}` to prevent duplicate processing.

### 2.2 Error Handling
- Capture mapping failures (e.g., unknown SKU) in a `shopify_sync_errors` collection for visibility in the admin UI.

## Phase 3: Event Mapping & Broadcasting

### 3.1 Mapping Shopify to Local Model
- Extract `line_items` from the Shopify payload.
- Map `line_item.sku` to local `InventoryItemKey`.
- If SKU is missing or invalid, attempt fallback to JAN code in product properties or title.

### 3.2 Dispatching "Green" Actions
- Construct and dispatch raw fact actions:
    ```json
    {
      "type": "shopify_order_placed",
      "payload": {
        "orderID": "shopify:<order_id>",
        "date": "2023-10-27T...",
        "email": "customer@example.com",
        "lines": [
          { "itemKey": "<inventory_item_key>", "qty": 1, "lineItemID": "<shopify_line_id>" }
        ]
      }
    }
    ```
- Similarly for cancellations and refunds, dispatch `shopify_order_cancelled` or `shopify_order_refunded` with raw quantities and IDs.
- **Idempotency:** The reducer uses the Shopify `orderID`, `lineItemID`, and `refundID` to ensure that it only counts each fact once, even if the action is replayed.

## Phase 4: Reconciliation Poller

### 4.1 Scheduled Function: `shopifyOrderReconcile`
- Implement a `pubsub` scheduled function (e.g., every 15 minutes).
- Fetch recent orders via the Shopify Admin REST or GraphQL API.
- Use the `updated_at_min` filter based on a stored `lastOrderUpdatedAtCursor`.

### 4.2 Healing Logic
- The poller dispatches a `shopify_order_reconciled` action:
    ```json
    {
      "type": "shopify_order_reconciled",
      "payload": {
        "orderID": "shopify:<order_id>",
        "timestamp": 1700000000000,
        "lines": [
          { "itemKey": "<item_key>", "currentQty": 2 }
        ]
      }
    }
    ```
- **Ground Truth:** The `Inventory` reducer treats this as the definitive state of the order at that timestamp. If the reducer's last processed event for this order is older than the reconciliation timestamp, it overrides its internal counters with these values.

## Phase 5: Testing & Verification

### 5.1 Manual Verification (Dev Store)
1. **Initial Sync:** Run the reconciliation poller and verify existing dev store orders appear in local state.
2. **Order Placement:** Place a test order in the dev store.
    - Verify `shopifyOrderWebhook` is triggered.
    - Verify raw payload is written to Firestore.
    - Verify `shopify_order_placed` action appears in the `broadcast` log.
    - Verify local Redux state reflects the new inventory impact (derived by the reducer).
3. **Updates & Cancellations:** Modify a test order (e.g., cancel it).
    - Verify `shopify_order_cancelled` is broadcasted.
    - Verify local state updates correctly as the reducer processes the cancellation fact.
4. **Refunds:** Issue a partial refund.
    - Verify `shopify_order_refunded` is broadcasted and inventory impact is adjusted by the reducer.

### 5.2 Automated E2E Test (Mocked)
- Create a new Playwright test in `e2e/016-shopify-sync/`.
- Mock the Shopify webhook payload.
- Verify the UI reflects the inventory changes without a full page reload (testing the real-time broadcast).

### 5.3 Rollout Verification
- Before deploying to production, run a "Dry Run" sync where actions are calculated but not broadcasted, logging the expected changes to `stdout` for manual review.
