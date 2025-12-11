# Shopify Integration - Design Document

## Overview

This document outlines the design for integrating the Dobutsu Stationery inventory management system with Shopify.

**Architecture Philosophy: Event Sourcing & Immutability**
The integration relies on **Immutable Actions** recorded in the `broadcast` collection. The state of Shopify connections and Product Listings is **derived in-memory** by reducing these actions. There are no mutable "Product Tables" in the database.

## 1. Inventory Calculation (The "Real" Stock)

Inventory quantity is never "updated". It is calculated from two streams of actions:

1.  **Incoming Stock**: Actions that add to the warehouse (e.g. `receive_stock`, `adjust_stock`).
    *   `Total Stocked` = Sum of all additions.
2.  **Outgoing Shipments**: Actions that mark items as shipped (e.g. `ship_item`).
    *   `Total Shipped` = Sum of all shipments.

**Available for Shopify** = `Total Stocked` - `Total Shipped`.

## 2. Data Model: Actions & Reducers

We introduce a new Redux slice: `shopify`.

### A. New Actions

These actions are dispatched to the `broadcast` collection to record changes to the Shopify integration state.

#### 1. `shopify_link_product`
Links a Shopify Handle and its Variants to internal Item Keys.
```typescript
interface ShopifyLinkProductAction {
  type: 'shopify_link_product';
  payload: {
    handle: string;
    variants: {
      shopifyVariantId: string;
      itemKey: string; // Links to our internal Item
    }[];
    timestamp: number;
    user: string;
  };
}
```

#### 2. `shopify_update_listing`
Records a change to the display metadata of a listing.
```typescript
interface ShopifyUpdateListingAction {
  type: 'shopify_update_listing';
  payload: {
    handle: string;
    field: 'title' | 'body_html' | 'options' | 'tags';
    value: any;
    timestamp: number;
  };
}
```

### B. Derived State (The Reducer)
The client-side reducer listens to these actions to build the "Database":

```typescript
interface ShopifyState {
  // Map Handle -> Listing Data
  listings: Record<string, {
    handle: string;
    title: string;
    body_html: string;
    linkedVariants: Record<string, string>; // VariantID -> ItemKey
  }>;
}
```

## 3. Workflows

### A. Import from Shopify (Initial Setup)
*Goal: Replay the "History" of Shopify into our Action Log.*

1.  **Fetch**: Admin tool fetches all active products from Shopify API.
2.  **Diff**: Compare fetched data against current `ShopifyState`.
3.  **Action Generation**: For each new/changed product:
    *   Dispatch `shopify_link_product` (if new).
    *   Dispatch `shopify_update_listing` (to set Title, Description, etc.).
    *   **Result**: The system "learns" the current state of Shopify by recording it as a series of events.

### B. Inventory Sync (Admin -> Shopify)
*Goal: Keep Shopify inventory correct.*

1.  **Reactive Listener**: The Sync Service subscribes to the Redux Store.
2.  **Compute**: On every state change, calculate `Available Stock` (`Stocked` - `Shipped`) for every linked Item.
3.  **Push**: If `Available Stock` != `Last Known Shopify Qty`, call Shopify API `inventory_levels/set`.

### C. Order Import (Shopify -> Admin)
*Goal: Record orders as actions.*

1.  **Webhook**: Receive `orders/create`.
2.  **Translate**: Convert Shopify Line Items -> Internal Item Keys (using `ShopifyState`).
3.  **Dispatch**:
    *   Dispatch `create_order` action (standard formatting).
    *   **Note**: This does NOT decrement stock. It creates a task for packing.
4.  **Fulfillment**: When the packer scans the item and dispatches `ship_item`:
    *   `Total Shipped` increases.
    *   `Available Stock` decreases.
    *   **Sync Listener** triggers (Step B) and updates Shopify.

### D. Manual Content Merge
*Goal: User controls product descriptions.*

1.  **Detection**: Webhook `products/update` received.
2.  **UI Alert**: "Shopify Listing 'Moon Stickers' has changed."
3.  **Approve**: User clicks "Accept Changes".
4.  **Action**: System dispatches `shopify_update_listing` with the new text.
5.  **State Update**: Reducer updates `ShopifyState`, making it the new truth.

## 4. API & Technical Constraints
*   **Rate Limits**: 2 requests/second (Leaky Bucket).
*   **Immutability**: We never "edit" a record. We always append a new action that supersedes previous state.

## 5. Security
*   **Validation**: All actions must be signed/validated by the user before broadcast.
*   **Webhooks**: HMAC signature verification required.
