# Shopify Product Creation Design

## Objective

The goal is to automate the generation of a Shopify-compatible product CSV
(`shopify-products.csv`) from primary internal sources:

1. **Inventory System** (Firestore): Provides SKU, Quantity, and base product
   existence.
2. **Photos Module** (Google Photos + Gemini): Provides high-resolution images,
   AI-generated HTML descriptions, and Titles.

This document outlines the data mapping required, and actions required, to
generate the Shopify product CSV.

## Desired Output format

The Shopify product CSV must conform to Shopify's
[Product CSV format](https://help.shopify.com/en/manual/products/import-export/using-csv#import-products).
Key fields to populate include:

Fields that we will need to populate with varying data are:

- Handle: user needs control of this, to group SKUs into listings
  - Generated from Title + janCode
  - Example: amifa-wall-stickers-4542...
- Title: Stored in **Listing** (User control).
- Body (HTML): Stored in **Listing** (User control, initially from Gemini).
- Product Category: Stored in **Listing**.
- Option1 Name: Stored in **Listing** (e.g. "Color").
- Option1 Value: Variant Subtype (e.g., "Blue", "Purple").
- Variant SKU: JAN Code + Subtype
- Variant Grams: Weight in grams
- Variant Inventory Qty: Stock Level
- Variant Price: Retail Price, manually entered
- Variant Barcode: JAN Code
- Image Src: URLs from Photos module
- Image Position: Manually assigned to control order of images in listing
- Image Alt Text: from AI description keywords
- Variant Image: Assign specific images to variants

Fields that we need to populate with static or default values are:

- Option1 Name: Subtype
- Vendor = SPNSS Ltd.
- Published = true
- Variant Inventory Tracker = shopify
- Variant Inventory Policy = deny
- Variant Fulfillment Service = manual
- Variant Requires Shipping = true
- Variant Taxable = true
- Variant Weight Unit = g
- Status = active

## Data Sources Analysis

### 1. Inventory (`src/lib/inventory.ts`)

The `Item` interface represents our physical stock.

- **Strengths:** Accurate "Source of Truth" for Stock Levels (`qty`),
  Identifiers (`janCode`, `subtype`), and basic categorization.
- **Gaps:** Lacks commercial data required for selling (Price, Weight).
- **Key Data:** Each item corresponds to a single SKU. The user will group these
  into listings by `Handle` to construct the store.

**Current Fields:**

- `janCode`: Primary Key (Barcode).
- `subtype`: Variant Subtype (e.g., color, animal).
- `shipped`: Number of this SKU that have shipped
- `qty`: Quantity ever received. Available stock can be computed from qty -
  shipped
- `description`: Inventory Description (Internal use).
- `handle`: Link to the parent **Listing**.
- `image`: Variant-specific image.

**Missing Fields (Action Required):**

- `price`: Retail price.
- `weight`: Shipping weight (grams).

### 2. Photos (`src/lib/google-photos.ts` & `src/lib/gemini-client.ts`)

The Photos module fetches images and uses Gemini to analyze them.

- **Strengths:** High-quality images
- **Key Data:**
  - `janCode`: Detected from image analysis.
  - `imageUrls`: High-res URLs.
- AI Grouping needs to move into the new shopify export process. After creating
  a Listing, and assigning SKUs to it, we can use AI to generate initial data (Title, Body) for the Listing. Key data:
  - `body`: AI-generated HTML body (Listing level).
  - `variants`: One variant per SKU in the handle.

## Proposed Implementation Plan

### Phase 1: Schema Extension

Update `src/lib/inventory.ts` to include commercial fields.

```typescript
export interface Item {
  // ... existing fields
  price?: number; // Retail price in target currency
  weight?: number; // Weight in grams
}
```

Update the order-import route to import these fields if present in CSVs.

Add a SKU Review route where missing data per SKU can be filled in by the user.
Highlight exceptions that need attention: SKUs with images missing or not from
our Photos module, SKUs without price/weight, etc.

### Phase 2: Bulk Product Listing UI

A spreadsheet-style UI that allows quickly sorting all the skus by any
attribute, enabling the user to assign Handles to consecutive rows of SKUs, edit
Titles, Prices, Weights, and other fields in bulk. This screen corresponds
almost exactly to the Shopify product CSV format, focused on the columns
identified above that vary per SKU.

### Phase 2: Input UI Updates

Update `src/lib/InventoryScanner.svelte` and
`src/routes/order-import/+page.svelte` to allow data entry for these new fields.

- **Scanner:** Add input fields for Price and Weight. Retain values for
  same-session scans of similar items?
- **Import:** If source CSVs eventually contain price/weight, map them.
  Otherwise, bulk edit capability may be needed.

### 3. Export Logic (`src/lib/shopify-export.ts`)

Create a utility to generate the Shopify product CSV and write it to Google
Drive, similar to the current inventory export.
