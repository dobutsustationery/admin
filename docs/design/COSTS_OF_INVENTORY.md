# Cost of Inventory Tracking

## Overview
We need to track the Unit Cost (buying price) for every SKU in the inventory to calculate COGS (Cost of Goods Sold) and profit margins. Currently, the system tracks `price` (Selling Price) but not `cost` (Buying Price).

## Data Model Changes
### Inventory Item
The `Item` interface in `src/lib/inventory.ts` will be updated to include:
```typescript
interface Item {
  // ... existing fields
  cost?: number; // Unit cost in JPY (or base currency)
}
```

## Source of Data
The primary source for `cost` is the **Order Import** workflow (Supplier Invoices/Receipts).
- The CSV files processed in `order-import` contain a "price" column.
- **Crucially**, in the context of a *Supplier Invoice*, this "price" represents the **Unit Cost**, not the Selling Price.
- We will re-map the import logic to store this CSV value into the `cost` field instead of the `price` field.

## Implementation Details

### 1. Inventory Slice (`src/lib/inventory.ts`)
- Update `Item` interface.
- Update `applyInventoryUpdate` to handle the `cost` field.
- Ensure `cost` is persisted to Firestore.

### 2. Order Import Slice (`src/lib/order-import-slice.ts`)
- Update `ImportItem` interface to include `cost`.
- Update `mapImportItem`:
  - Map the CSV column `price` (and aliases like `unit price`, `cost`) to `ImportItem.cost`.
  - **Stop** mapping it to `ImportItem.price` (Selling Price) to avoid overwriting MSRP with Cost.
- Update `computeOrderImportBatch` to include `cost` in the update payload.

### 3. SKU Review / Visibility
- We need to identify items that are missing `cost` data.
- We will add a visual indicator or filter in the main Inventory UI to highlight items where `cost` is undefined or 0.

## Migration
Existing items will have `cost: undefined`. They will be populated gradually as:
1. New stock is imported via Order Import.
2. Manual updates are performed (if UI is added for it).
