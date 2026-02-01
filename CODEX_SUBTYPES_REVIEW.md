# Subtypes Feature Review

This review is based on `docs/design/SUBTYPES_DESIGN.md` and the current implementation in `src/lib/listing-creation-slice.ts`.

## Critical Issues
1) **Duplicate proposals share the same inventory items.** `generate_proposals` now creates **one proposal per photo key** (e.g., `JAN:Blue`, `JAN:Red`), but each proposal reuses the **same `inventoryItemIds` list** for the base JAN. This means multiple draft proposals point at the **same inventory IDs**, which violates the “one item = one SKU” rule and will cause conflicting approvals/updates. (`src/lib/listing-creation-slice.ts:372-412`)

2) **No SKU split / inventory allocation exists.** The design calls for splitting a base JAN into multiple SKUs and allocating quantities per subtype. There is **no action, UI, or data flow** to create new inventory items or allocate stock between variants. As-is, approving multiple subtype proposals will overwrite subtype/handle on the same base item. (`docs/design/SUBTYPES_DESIGN.md:25-88`, `src/lib/listing-creation-slice.ts:372-412`)

3) **Multi-variant proposal logic is not implemented.** The design proposes **one proposal per Base JAN** with multiple variants mapped to photo groups. The current code generates **separate proposals**, which prevents a single listing with variants. This conflicts with the intended workflow and creates duplicate listings instead of one listing with options. (`docs/design/SUBTYPES_DESIGN.md:23-80`, `src/lib/listing-creation-slice.ts:372-412`)

## Major Gaps / Poor Design Decisions
4) **`janCode` semantics are overloaded with subtype keys.** Proposals now use `janCode = "JAN:Subtype"` as a key, but other parts of the system treat `janCode` as the **barcode** used for inventory matching and handle generation. This will lead to inconsistent handles, grouping, and potential collisions if colon-suffixed JANs are treated as unique barcodes. (`src/lib/listing-creation-slice.ts:392-405`, `src/lib/listing-creation-slice.ts:430-500`)

5) **Variant-to-photo-group mapping is implicit and brittle.** The design relies on matching `option1Value` to the suffix of the photo group key (e.g., `JAN:Blue`). There is **no explicit mapping field** in the proposal, so the UI can’t reliably bind a variant to a specific photo group, especially when names diverge or are edited. (`docs/design/SUBTYPES_DESIGN.md:96-118`)

6) **Inventory history and event-sourcing are not respected.** Creating new SKUs from a base JAN requires a **green event** that records the split/allocation. No such action exists. Using `update_field` on the base item to represent multiple variants is not reversible and corrupts history. (`docs/design/SUBTYPES_DESIGN.md:54-79`, `src/lib/inventory.ts:286-329`)

## Missing Features
7) **No UI for subtype quantity allocation.** The design explicitly calls for prompting the user (“How many are Red?”). There is no UI, validation, or state to perform or persist this allocation. (`docs/design/SUBTYPES_DESIGN.md:58-79`)

8) **No subtype-aware listing creation in batch editor.** The batch editor and proposal view don’t distinguish `JAN:Subtype` photo groups or link them to variant rows. Without UI changes, users cannot verify or correct variant-photo associations. (`docs/design/SUBTYPES_DESIGN.md:118-147`)

## Recommendations
- **Implement a single multi-variant proposal per Base JAN.** Aggregate photo groups and build a unified `variants` array with explicit photo-group mapping.
- **Introduce an inventory split action** (green event) that creates new item IDs and records quantity allocation across subtypes.
- **Store explicit `variantPhotoGroupId`** (or similar) in the proposal instead of relying on suffix matching.
- **Add UI for quantity allocation and confirmation** before approving.

## Summary
The new subtype design document is directionally correct, but the current code **does not implement the intended workflow**. The present `generate_proposals` approach creates duplicate proposals that share the same inventory items, which will lead to data corruption when approved. The subtype feature needs explicit SKU creation, allocation, and variant-photo mapping to be safe and correct.
