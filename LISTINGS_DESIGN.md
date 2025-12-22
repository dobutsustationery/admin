# Product Listings Redesign - Design Document

## 1. Problem Statement
Currently, Shopify listing-level data (Title, Body, Category, etc.) is duplicated across every SKU (Inventory Item) in the system. Ideally, "Listings" should be a distinct entity that groups multiple SKUs (Variants) via a common "Handle".

## 2. Proposed Architecture

### 2.1 The "Listings" Slice
We will introduce a new Redux slice: `listings`. This slice will look up `Listing` objects by their unique `handle`.

**State Structure:**
```typescript
interface Listing {
  handle: string;           // Primary Key
  title: string;            // Product Title
  bodyHtml: string;         // HTML Description
  productCategory: string;  // Shopify Product Category (e.g. "Stationery > Pens")
  productType: string;      // Custom Product Type (optional)
  vendor: string;           // Vendor (default: SPNSS Ltd.)
  tags: string[];           // Tags
  status: 'active' | 'archived' | 'draft';
  
  // Option Definitions (The "Name" of the option, e.g. "Color" or "Design")
  // Note: The specific value for each SKU (e.g. "Red") comes from Item.subtype
  option1Name: string;      
  
  // Product Gallery Images (Order matters)
  images: ListingImage[];
  
  lastUpdated: number;      // Timestamp
}

interface ListingImage {
  id: string;               // Unique ID (or URL if unique)
  url: string;              // Image Source (Shopify CDN or Drive)
  position: number;         // 1-based index
  altText: string;
}

interface ListingsState {
  handleToListing: Record<string, Listing>;
}
```

### 2.2 Inventory Slice Updates (`Item` Interface)
The `Item` (SKU) will serve as the "Variant". It connects to the Listing via the `handle` field.

**Changes:**
*   **Keep**: `handle` (Foreign Key to Listings slice).
*   **Remove** (migrated to Listing): `bodyHtml`, `productCategory`, `imagePosition`, `imageAltText`.
*   **Retain** (Variant Specific): `janCode`, `subtype` (maps to Option1 Value), `price`, `weight`, `image` (Variant Image), `countryOfOrigin`.

### 2.3 Relationships
*   **SKU to Listing**: `Item.handle` -> `Listings.handleToListing[handle]`
*   **Listing to SKUs**: We will create a helper selector/function `getSkusForHandle(handle)` which scans `inventory.idToItem`.
    *   *Optimization*: If scanning is too slow, we can add `skus: string[]` to the `Listing` interface and maintain it, but scanning is safer for data integrity (single source of truth).

## 3. Operations & Actions

### 3.1 Actions (New `listings-slice.ts`)
We will create a new slice `listings-slice.ts` to manage these actions.

1.  **`create_listing`**
    *   Payload: `Listing` object.
    *   Effect: Adds entry to `handleToListing`.

2.  **`update_listing`**
    *   Payload: `{ handle: string, changes: Partial<Listing> }`.
    *   Effect: Updates fields.

3.  **`add_listing_image` / `remove_listing_image` / `reorder_listing_images`**
    *   Helper actions to manage the gallery.

4.  **`link_sku_to_listing`** (Inventory Action)
    *   Use existing `update_field` or specialized action to set `Item.handle`.

### 3.2 Migration Strategy
A migration script/function (client-side runner) is needed to populate the new slice from existing Item data.
1.  Iterate all Items.
2.  Group by `handle`.
3.  For each group:
    *   Extract common data (Body, Category). If conflicts, pick best/first or flag.
    *   Construct `Listing` object.
    *   Dispatch `create_listing`.
    *   (Items already have `handle` set, so no changes needed there).

## 4. Integration Updates

### 4.1 `products-shopify` Route (Bulk Editor)
*   **Logic Change**: Instead of iterating `InventoryItems`, we should primary iterate `Listings`, or iterate `InventoryItems` but grouped visually by Handle.
*   **Editing**: 
    *   Editing "Title", "Body", "Category" on any row updates the **Listing** (via `update_listing`). This automatically reflects on all other SKUs in that group (since they read from the Listing).
    *   Editing "Price", "Weight", "Subtype" updates the **Item** (Variant).

### 4.2 Shopify Import
*   **Parsing**: When parsing CSV, split data into Listing Data vs Variant Data.
*   **Matching**: 
    *   Check for existing Listing by Handle.
    *   If exists -> Update Listing (if differences found).
    *   If new -> Create Listing.
*   **Variant Sync**: Update Item as usual, ensuring `handle` is linked.

### 4.3 Shopify Export
*   **Generation**: 
    *   Iterate Listings.
    *   For each Listing, find all SKUs.
    *   Generate CSV rows:
        *   Row 1: Listing Data + Variant 1 Data.
        *   Row N: Variant N Data (Listing columns empty or repeated as per Shopify CSV spec).

## 5. UI/UX Considerations
*   **Visual Grouping**: The Bulk Editor should clearly demarcate "Listing Sets" (e.g. alternating background colors for different handles).
*   **Listing Fields**: Input fields for Title/Body should look "merged" or be synchronized across the group.

## 6. Open Questions / TODOs
*   **Option1 Name**: Currently using `subtype`. Need to confirm if users want to customize the *Name* of this option (e.g. "Color" vs "style"). Added `option1Name` to Listing to support this.
*   **Images**: "Listing Images" vs "Variant Images".
    *   Listing Images = The gallery.
    *   Variant Image = `Item.image`.
    *   Need to ensure `Item.image` is accounted for in the gallery if desired, or treated separately. Shopify usually expects the Variant Image to be *one of* the Gallery Images.
