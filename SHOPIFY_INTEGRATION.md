# Shopify Integration - Design Document

## Overview

This document outlines the design for integrating the Dobutsu Stationery inventory management system with Shopify. 

**Core Philosophy: Inventory System is Master.**
All product listings, inventory levels, and order records are mastered in the Dobutsu Admin system. Shopify is treated as a sales channel and storefront, not the primary system of record.

## Data Architecture

### 1. New Entity: `ShopifyProduct`
To map our flat `Item` structure (SKUs) to Shopify's grouped conceptual model, we introduce a `ShopifyProduct` entity in Firestore.

**Structure:**
```typescript
interface ShopifyProduct {
  handle: string;       // Unique ID (e.g., "amifa-moon-stickers")
  title: string;        // "Amifa Moon and Sky Wall Stickers"
  bodyHtml: string;     // Description
  vendor: string;       // "SPNSS Ltd."
  productType: string;  // "Stickers"
  tags: string[];       // ["sticker", "cute"]
  options: {
    name: string;       // e.g. "Design"
    values: string[];   // ["Moon", "Sky"]
  }[];
  variants: {
    sku: string;        // Links to Item.janCode (e.g. "4542804112443Moon")
    option1: string;    // "Moon"
    option2?: string;
    price: number;
    grams: number;
    imageId?: string;   // Link to Shopify Image ID
  }[];
  images: {
    id: string;
    src: string;
    altText?: string;
  }[];
}
```

### 2. Relationship to `Item`
*   **SKU is Key**: The `sku` in a Shopify Variant **MUST** match our `janCode` (for single items) or `janCode` + `subtype` (for variants).
*   **Inventory Source**: `qty` for a variant is **ALWAYS** read directly from the linked `Item` in the Admin system.

## Workflows

### 1. Import from Shopify (Urgent: Initial Setup)
*Goal: Populate Admin with existing Shopify listings.*

1.  **Fetch**: Admin pulls all Products from Shopify API.
2.  **Match**: For each Variant, try to match `sku` to an internal `Item`.
3.  **Persist**: Create a `ShopifyProduct` record in Firestore.
4.  **UI**: Show a "Linked Products" dashboard.
    *   **Green**: All variants linked to existing Items.
    *   **Red**: Variant SKU not found in Inventory (Needs Item creation).

### 2. Create Listing from Inventory (Urgent: New Stock)
*Goal: Turn new internal items into a Shopify page.*

1.  **Select**: User selects 1 or more `Items` in the Admin "Inventory" list.
2.  **Group**: Click "Create Shopify Listing".
3.  **Configure**:
    *   **Handle**: Auto-suggested as `title-jancode` (kebab-case). User can edit.
    *   **Title/Desc**: Input product details.
    *   **Options**: Define Variant Options (e.g. "Color") and map values to selected Items.
4.  **Push**: Admin creates the Product and Variants in Shopify via API.

### 3. Sync Changes (Bidirectional)

#### A. Inventory (Admin -> Shopify)
*   **Trigger**: Real-time (on `qty` change in Admin).
*   **Action**: Update `inventory_quantity` in Shopify.
*   **Rule**: **Admin Wins**. Shopify inventory is overwritten.

#### B. Product Details (Shopify -> Admin)
*   **Trigger**: Manual "Check for Updates" or Webhook `products/update`.
*   **Action**: **Manual Merge UI**.
    *   The system detects a difference (e.g. Title changed in Shopify).
    *   User sees a "Diff" view.
    *   User clicks "Accept" to update the Admin `ShopifyProduct` record, or "Reject" to overwrite Shopify with Admin data.
*   **Rule**: **Explicit User Action**. No automatic overwrites of product data.

### 4. Orders (Shopify -> Admin)
*   **Trigger**: Webhook `orders/create`.
*   **Action**:
    1.  Parse Line Items. match SKUs to `Items`.
    2.  Create internal `Order` record.
    3.  **Deduct Stock**: Immediately reduce `qty` in Admin (which triggers Sync A to update Shopify, keeping them consistent).
    4.  **Shipped Status**: Auto-mark standard items as "pending packing". Workers manually flag special items (extras/gifts) as shipped if needed.

## Technical Implementation

### API & Auth
*   **Scopes**: `read_products`, `write_products`, `read_inventory`, `write_inventory`, `read_orders`.
*   **Rate Limits**: strict leaky bucket queue to respect 2 req/s.

### Deployment Phases
1.  **Phase 1 (Sync Existing)**: Build "Import" tool. Populate `ShopifyProduct` collection. Enable Inventory Level Sync.
2.  **Phase 2 (Create New)**: Build "Listing Creator" UI.
3.  **Phase 3 (Orders)**: Webhook listener and Order record creation.
