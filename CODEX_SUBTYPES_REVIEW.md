# Subtypes Feature Review

This review is based on `docs/design/SUBTYPES_DESIGN.md` and the current implementation in `src/lib/listing-creation-slice.ts`.

## Critical Issues
1) **No SKU split / inventory allocation exists.** The design calls for splitting a base JAN into multiple SKUs and allocating quantities per subtype. There is **no action, UI, or data flow** to create new inventory items or allocate stock between variants. The proposal now includes multiple variants, but they **all point to the same base `itemId`**, so approvals will overwrite subtype/handle on a single item. (`docs/design/SUBTYPES_DESIGN.md:25-88`, `src/lib/listing-creation-slice.ts:392-432`, `src/lib/listing-creation-slice.ts:488-499`)

2) **Photo group keys are not used in the UI.** `generate_proposals` now stores `photoGroupKey` on variants and includes `photoGroupIds`, but the listing creation UI still loads photos via `photos.janCodeToPhotos[p.janCode]`, which uses the **base JAN** and ignores `JAN:Subtype` keys. This means subtype photo groups likely never render. (`src/lib/listing-creation-slice.ts:404-430`, `src/routes/listing-detail/+page.svelte:132-146`)

## Major Gaps / Poor Design Decisions
3) **Inventory history and event-sourcing are not respected.** Creating new SKUs from a base JAN requires a **green event** that records the split/allocation. No such action exists. Using `update_field` on the base item to represent multiple variants is not reversible and corrupts history. (`docs/design/SUBTYPES_DESIGN.md:54-79`, `src/lib/inventory.ts:286-329`)

4) **Variant-to-photo-group mapping is stored but not enforced.** `photoGroupKey` now exists on variants, but nothing consumes it. If the UI doesn’t bind photos by this key, edits can drift and “Blue” can be paired with “Red” images. (`src/lib/listing-creation-slice.ts:404-430`, `src/routes/listing-detail/+page.svelte:132-146`)

## Missing Features
5) **No UI for subtype quantity allocation.** The design explicitly calls for prompting the user (“How many are Red?”). There is no UI, validation, or state to perform or persist this allocation. (`docs/design/SUBTYPES_DESIGN.md:58-79`)

6) **No subtype-aware listing creation in batch editor.** The batch editor and proposal view don’t distinguish `JAN:Subtype` photo groups or link them to variant rows. Without UI changes, users cannot verify or correct variant-photo associations. (`docs/design/SUBTYPES_DESIGN.md:118-147`)

## Recommendations
- **Implement a single multi-variant proposal per Base JAN.** Aggregate photo groups and build a unified `variants` array with explicit photo-group mapping.
- **Introduce an inventory split action** (green event) that creates new item IDs and records quantity allocation across subtypes.
- **Store explicit `variantPhotoGroupId`** (or similar) in the proposal instead of relying on suffix matching.
- **Add UI for quantity allocation and confirmation** before approving.

## Summary
The subtype design doc is directionally correct, and `generate_proposals` now creates a **single multi-variant proposal per Base JAN**, which fixes the duplicate-proposal issue. However, it still **reuses the same inventory item for all variants**, lacks any stock allocation workflow, and the UI does **not** honor `photoGroupKey` for subtype-specific photo groups. The subtype feature remains unsafe until SKU split/allocation and photo-group binding are implemented.
