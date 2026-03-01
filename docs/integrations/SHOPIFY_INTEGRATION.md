# Shopify Integration - Design Document

> **Status: Implemented (with CLI sync)** - Shopify integration is available with product management at `/shopify-products`, import at `/shopify-import`, and inventory API sync via `scripts/shopify-sync.ts`.

## Overview

This document outlines the design for integrating the Dobutsu Stationery inventory management system with Shopify.

**Architecture Philosophy: Event Sourcing & Immutability**
The integration relies on **Immutable Actions** recorded in the `broadcast` collection. The state of Shopify connections and Product Listings is **derived in-memory** by reducing these actions.

## 1. Inventory Calculation (The "Real" Stock)

Inventory quantity is never "updated". It is calculated from two streams of actions:

1.  **Incoming Stock**: Actions that add to the warehouse (e.g. `receive_stock`, `adjust_stock`).
    - `Total Stocked` = Sum of all additions.
2.  **Outgoing Shipments**: Actions that mark items as shipped (e.g. `ship_item`).
    - `Total Shipped` = Sum of all shipments.

**Available for Shopify** = `Total Stocked` - `Total Shipped`.

## 2. Data Model: Actions & Reducers

We introduce a new Redux slice: `listings` (and maintain `shopify` for API logs/sync).

### A. New Actions

#### 1. `create_listing` / `update_listing`

Manages the Listing entity (Title, Body, Category, etc).

```typescript
interface CreateListingAction {
  type: "create_listing";
  payload: {
    handle: string;
    title: string;
    bodyHtml: string;
    productCategory: string;
    option1Name: string;
    images: ListingImage[];
    tags: string[];
    vendor: string;
  };
}
```

#### 2. `shopify_link_product` (Legacy/Modified)

Links a Shopify Handle and its Variants to internal Item Keys. Now effectively just ensures `Item.handle` is set.

These actions are dispatched to the `broadcast` collection to record changes to the Listings and Shopify state.

#### 1. `shopify_link_product`

(Legacy support / Sync) - Ensures `Item.handle` is set correctly based on Shopify data.

#### 2. `shopify_update_listing`

Records a change to the display metadata of a listing.

```typescript
interface ShopifyUpdateListingAction {
  type: "shopify_update_listing";
  payload: {
    handle: string;
    field: "title" | "body_html" | "options"; // Tags removed
    value: any;
    timestamp: number;
  };
}
```

#### 3. `shopify_api_log` (Audit & Sync State)

Records the result of _every_ external API call to Shopify. This serves as the audit trail and the source of truth for "Last Known Synced State".

```typescript
interface ShopifyApiLogAction {
  type: "shopify_api_log";
  payload: {
    requestType:
      | "inventory_sync"
      | "product_update"
      | "fetch_listings"
      | "order_import";
    endpoint: string;
    success: boolean;
    response: any; // The JSON response or error details
    context: {
      handle?: string;
      sku?: string;
      targetQty?: number; // For inventory syncs
    };
    timestamp: number;
  };
}
```

**Sync Logic**: To determine if an inventory update is needed, the Sync Service compares the calculated "Available Stock" against the `targetQty` of the most recent successful `shopify_api_log` for that SKU.

### B. Derived State (The Reducer)

The client-side reducer listens to these actions to build the "Database":

```typescript
interface ListingsState {
  // Map Handle -> Listing Data
  handleToListing: Record<
    string,
    {
      handle: string;
      title: string;
      bodyHtml: string;
      productCategory: string; // "Product Category"
      option1Name: string; // e.g. "Color"
      images: { url: string; position: number; altText: string }[];
      status: "active" | "archived" | "draft";
    }
  >;
}

// The 'shopify' slice mainly tracks API logs and Sync State now.
```

## 3. Workflows

### A. Import from Shopify (Initial Setup)

_Goal: Replay the "History" of Shopify into our Action Log._

1.  **Fetch**: Admin tool fetches all active products from Shopify API.
2.  **Diff**: Compare fetched data against current `ShopifyState`.
3.  **Action Generation**: For each new product:
    - Dispatch `shopify_link_product` mapping Handles/Options to SKUs.
    - Dispatch `shopify_update_listing` to capture titles/desc.
    - Dispatch `shopify_api_log` to record the fetch operation.

### B. Inventory Sync (Admin -> Shopify)

_Goal: Keep Shopify inventory correct._

1.  **Reactive Listener**: The Sync Service subscribes to the Redux Store.
2.  **Compute**: Calculate `Available Stock` for every linked Item.
3.  **Check**: Find last `shopify_api_log` for this SKU. Is `targetQty` == `Available Stock`?
4.  **Push**: If different, call Shopify API `inventory_levels/set`.
5.  **Log**: Dispatch `shopify_api_log` with the result.

**Current implementation**:

- **Primary path (browser-triggered):** User clicks **Sync This Listing** in `/listing-detail` (live mode), which writes a `sync_requested` event document in `shopify_sync`. A Firebase Firestore trigger (`functions/index.js`) listens on `shopify_sync/{eventId}` and executes sync.
- **Secondary path (CLI):** CLI tools can enqueue and/or execute `shopify_sync` requests (same shared logic as the function).

**CLI capabilities**:

- Queue a request into `shopify_sync`.
- Execute queued requests from `shopify_sync`.
- Uses the same shared sync core as the cloud function (`functions/shared/shopify-sync-core.cjs` and `functions/shared/shopify-sync-worker.cjs`).

### C. Order Import (Shopify -> Admin)

_Goal: Record orders as actions._

1.  **Webhook**: Receive `orders/create`.
2.  **Translate**: Convert Shopify Line Items -> Internal Item Keys (using `ShopifyState`).
3.  **Dispatch**:
    - Dispatch `create_order` action.
    - Dispatch `shopify_api_log` recording the webhook receipt.
4.  **Fulfillment**: When items are shipped, `Available Stock` decreases, automatically triggering Workflow B.

### D. Manual Content Merge

_Goal: User controls product descriptions._

1.  **Detection**: Webhook `products/update`.
2.  **UI Alert**: User sees diff.
3.  **Approve**: User clicks "Accept Changes".
4.  **Action**: System dispatches `shopify_update_listing` with the new text.

## 4. Credentials & Setup

### Environment Configuration

Credentials are managed via `.env` files. **Do not commit these to git.**

**`.env.example`**

```bash
# Public (Client)
VITE_SHOPIFY_STORE_URL=your-store.myshopify.com
VITE_SHOPIFY_API_VERSION=2026-01

# Private (Server)
# Option A (static token, if available)
# SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxx

# Option B (Dev Dashboard app credentials)
SHOPIFY_CLIENT_ID=xxxxxxxxxxxxxxxx
SHOPIFY_CLIENT_SECRET=xxxxxxxxxxxxxxxx

SHOPIFY_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxx
SHOPIFY_SYNC_ENABLED=true
```

### Running Inventory Sync

> **Note:** The CLI sync implementation is currently **untested** against production/staging stores.

### Browser-triggered Listing Sync (no CLI)

1. Open `/listing-detail?mode=live&handle=<your-handle>`.
2. Click **Sync This Listing**.
3. The app writes `sync_requested` event to `shopify_sync`.
4. Firebase Function `syncShopifyRequest` processes and appends follow-up events (no in-place mutation):
   - `sync_claimed`
   - `sync_api_call` (one per API call)
   - `sync_completed` or `sync_partial_failed` or `sync_failed`
5. `shopify_api_log` actions are also appended to `broadcast`.
6. Monitor progress in `/sync-status` (derived by reducing `shopify_sync` events by `requestId`).

### Firebase Functions Setup

Use local gitignored env files in repo root:

- `./.env.emulator`
- `./.env.staging`
- `./.env.production`

Each file should include:

- `SHOPIFY_STORE_URL`
- `SHOPIFY_ACCESS_TOKEN` OR (`SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`)
- `SHOPIFY_API_VERSION`

Deployment/runtime wiring:

- `npm run emulators` prepares `functions/.env` from `./.env.emulator`.
- `npm run deploy:staging` prepares `functions/.env` from `./.env.staging` and deploys hosting + functions.
- `npm run deploy:production` prepares `functions/.env` from `./.env.production` and deploys hosting + functions.

For a full step-by-step local setup and validation flow (Firebase emulators + functions + Shopify development store), see:

- [Shopify Sync Runbook (Emulators + Dev Store)](./SHOPIFY_SYNC_EMULATOR_DEVSTORE_RUNBOOK.md)

```bash
# Queue a listing sync request from CLI (same queue as browser writes)
npm run shopify:sync:request -- --firestore-env production --handle your-listing-handle

# Execute queued requests from CLI worker
npm run shopify:sync:worker -- --firestore-env production --limit 20

# Execute one request document by id
npm run shopify:sync:worker -- --firestore-env production --request-doc-id <docId>
```

### Creating Shopify Credentials (Custom App)

1.  **Shopify Admin** -> **Settings** -> **Apps and sales channels**.
2.  **Develop apps** -> **Create an app**.
3.  **Scopes**:
    - `read_products`, `write_products`
    - `read_inventory`, `write_inventory`
    - `read_locations` (required for `/locations.json` lookup used by inventory sync)
    - `read_orders`
4.  **Install app**.
5.  In app credentials, copy:
    - `Client ID`
    - `Client secret`
6.  Use those in your `.env.*` file:
    - `SHOPIFY_CLIENT_ID=...`
    - `SHOPIFY_CLIENT_SECRET=...`
7.  If your app UI also provides a static `Admin API access token` (`shpat_...`), you may use:
    - `SHOPIFY_ACCESS_TOKEN=...`
      instead of client credentials.
8.  **Webhooks**:
    - Register `orders/create` and `products/update`.
    - Copy the `Client secret` to `SHOPIFY_WEBHOOK_SECRET`.

### Development Environments

- **Local**: Use `npm run dev:local`. No real sync (unless configured to a Dev Store).
- **Staging**: Use a **Shopify Partner Development Store**. These are free and isolated.
- **Production**: Connects to the live store.

## 5. Security & Constraints

- **Rate Limits**: 2 requests/second. Sync Service must use a queue.
- **Immutability**: We never "edit" a record. We always append a new action.
- **Validation**: HMAC signature verification required for all webhooks.
