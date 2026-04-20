# Shopify Order Sync Implementation Plan

> **Status: Draft**
> **Related Design:** [SHOPIFY_ORDER_SYNC_DESIGN.md](SHOPIFY_ORDER_SYNC_DESIGN.md)

This document outlines the detailed implementation and testing plan for the Shopify Order Sync feature.

## Goal

Implement a robust, idempotent ingestion pipeline for Shopify orders that updates local inventory state using "Green" actions (`shopify_order_placed`, `shopify_order_cancelled`, and `shopify_order_refunded`).

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

## Phase 3: Raw Event Broadcasting

### 3.1 Simple Webhook Handler
- Modify `shopifyOrderWebhook` to NOT map the payload.
- Simply identify the event type and dispatch the corresponding raw action:
    - `orders/create` -> `shopify_order_created`
    - `orders/updated` -> `shopify_order_updated`
    - `orders/cancelled` -> `shopify_order_cancelled`
    - `refunds/create` -> `shopify_refund_created`
- Action payload format:
    ```json
    {
      "type": "shopify_order_created",
      "payload": {
        "raw": { ... entire shopify object ... }
      }
    }
    ```

### 3.2 Dispatching via Broadcast
- Use the existing broadcast middleware to ensure all clients receive the raw events.
- **Idempotency:** The reducer uses the Shopify `id`, `updated_at`, and `admin_graphql_api_id` to ensure idempotent processing.

## Phase 4: Reducer-Side Logic (The "Brain")

### 4.1 Moving Mapping to `inventory.ts`
- Move `mapSkuToItemKey` and related parsing logic into `src/lib/inventory.ts`.
- The reducer must handle:
    - Extracting line items and mapping to local `InventoryItemKey`.
    - Calculating `placed`, `cancelled`, and `refunded` quantities from the raw payload.
    - Maintaining `shipped` quantity adjustments on the `Item` objects.
    - Storing `shopifyFacts` in the `OrderInfo` object for consistent state derivation.

### 4.2 Reconciliation Logic
- The `shopifyOrderReconcile` poller also broadcasts raw payloads using the `shopify_order_reconciled` action.
- The reducer treats the raw order object in `shopify_order_reconciled` as the definitive state at that moment.

## Phase 5: Testing & Verification

### 5.1 Manual Verification (Dev Store)
1. **Initial Sync:** Run the reconciliation poller and verify existing dev store orders appear in local state.
2. **Order Placement:** Place a test order in the dev store.
    - Verify `shopifyOrderWebhook` is triggered.
    - Verify raw payload is written to Firestore and broadcasted.
    - Verify local Redux state reflects the new inventory impact (calculated by the reducer from raw data).
3. **Refunds & Cancellations:** Verify that complex Shopify payloads (like partial refunds) are correctly interpreted by the reducer.

### 5.2 Automated E2E Test (Mocked)
- Update `e2e/016-shopify-sync/` to use raw Shopify JSON payloads in the test fixtures.
- Verify the UI reflects the inventory changes calculated from these raw payloads.

### 5.3 Rollout Verification
- Before deploying to production, run a "Dry Run" sync where actions are calculated but not broadcasted, logging the expected changes to `stdout` for manual review.
