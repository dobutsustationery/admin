# Shopify Integration - Design Document

## Overview

This document outlines the design for integrating the Dobutsu Stationery inventory management system with Shopify.

**Architecture Philosophy: Event Sourcing & Immutability**
The integration relies on **Immutable Actions** recorded in the `broadcast` collection. The state of Shopify connections and Product Listings is **derived in-memory** by reducing these actions.

## 1. Inventory Calculation (The "Real" Stock)

Inventory quantity is never "updated". It is calculated from two streams of actions:

1.  **Incoming Stock**: Actions that add to the warehouse (e.g. `receive_stock`, `adjust_stock`).
    *   `Total Stocked` = Sum of all additions.
2.  **Outgoing Shipments**: Actions that mark items as shipped (e.g. `ship_item`).
    *   `Total Shipped` = Sum of all shipments.

**Available for Shopify** = `Total Stocked` - `Total Shipped`.

## 2. Data Model: Actions & Reducers

We introduce a new Redux slice: `listings` (and maintain `shopify` for API logs/sync).

### A. New Actions

#### 1. `create_listing` / `update_listing`
Manages the Listing entity (Title, Body, Category, etc).
```typescript
interface CreateListingAction {
  type: 'create_listing';
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
  type: 'shopify_update_listing';
  payload: {
    handle: string;
    field: 'title' | 'body_html' | 'options'; // Tags removed
    value: any;
    timestamp: number;
  };
}
```

#### 3. `shopify_api_log` (Audit & Sync State)
Records the result of *every* external API call to Shopify. This serves as the audit trail and the source of truth for "Last Known Synced State".

```typescript
interface ShopifyApiLogAction {
  type: 'shopify_api_log';
  payload: {
    requestType: 'inventory_sync' | 'product_update' | 'fetch_listings' | 'order_import';
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
  handleToListing: Record<string, {
    handle: string;
    title: string;
    bodyHtml: string;
    productCategory: string; // "Product Category"
    option1Name: string; // e.g. "Color"
    images: { url: string; position: number; altText: string }[];
    status: 'active' | 'archived' | 'draft';
  }>;
}

// The 'shopify' slice mainly tracks API logs and Sync State now.
```

## 3. Workflows

### A. Import from Shopify (Initial Setup)
*Goal: Replay the "History" of Shopify into our Action Log.*

1.  **Fetch**: Admin tool fetches all active products from Shopify API.
2.  **Diff**: Compare fetched data against current `ShopifyState`.
3.  **Action Generation**: For each new product:
    *   Dispatch `shopify_link_product` mapping Handles/Options to SKUs.
    *   Dispatch `shopify_update_listing` to capture titles/desc.
    *   Dispatch `shopify_api_log` to record the fetch operation.

### B. Inventory Sync (Admin -> Shopify)
*Goal: Keep Shopify inventory correct.*

1.  **Reactive Listener**: The Sync Service subscribes to the Redux Store.
2.  **Compute**: Calculate `Available Stock` for every linked Item.
3.  **Check**: Find last `shopify_api_log` for this SKU. Is `targetQty` == `Available Stock`?
4.  **Push**: If different, call Shopify API `inventory_levels/set`.
5.  **Log**: Dispatch `shopify_api_log` with the result.

### C. Order Import (Shopify -> Admin)
*Goal: Record orders as actions.*

1.  **Webhook**: Receive `orders/create`.
2.  **Translate**: Convert Shopify Line Items -> Internal Item Keys (using `ShopifyState`).
3.  **Dispatch**:
    *   Dispatch `create_order` action.
    *   Dispatch `shopify_api_log` recording the webhook receipt.
4.  **Fulfillment**: When items are shipped, `Available Stock` decreases, automatically triggering Workflow B.

### D. Manual Content Merge
*Goal: User controls product descriptions.*

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
VITE_SHOPIFY_API_VERSION=2024-01

# Private (Server)
SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxxxxxxxx
SHOPIFY_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxx
SHOPIFY_SYNC_ENABLED=true
```

### Creating Shopify Credentials (Custom App)

1.  **Shopify Admin** -> **Settings** -> **Apps and sales channels**.
2.  **Develop apps** -> **Create an app**.
3.  **Scopes**:
    *   `read_products`, `write_products`
    *   `read_inventory`, `write_inventory`
    *   `read_orders`
4.  **Install App**: This generates the `Admin API access token` (`shpat_...`).
5.  **Webhooks**:
    *   Register `orders/create` and `products/update`.
    *   Copy the `Client secret` to `SHOPIFY_WEBHOOK_SECRET`.

### Development Environments
*   **Local**: Use `npm run dev:local`. No real sync (unless configured to a Dev Store).
*   **Staging**: Use a **Shopify Partner Development Store**. These are free and isolated.
*   **Production**: Connects to the live store.

## 5. Security & Constraints
*   **Rate Limits**: 2 requests/second. Sync Service must use a queue.
*   **Immutability**: We never "edit" a record. We always append a new action.
*   **Validation**: HMAC signature verification required for all webhooks.
