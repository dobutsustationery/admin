# Subtypes Feature Review

This review is based on `docs/design/SUBTYPES_DESIGN.md` and the current implementation in `src/lib/listing-creation-slice.ts`.

## Critical Issues
1) **Split/allocate flow can create zero‑qty variants with no validation.** `approve_proposal_thunk` uses `v.qty || 0` and always calls `split_inventory_item` when multiple variants share the same itemId. If allocations are left blank, this can create new SKUs with `qty = 0` and leave the base item unchanged. There’s no guard to require non‑zero allocation or to verify totals. (`src/lib/listing-creation-slice.ts:490-544`, `src/lib/inventory.ts:701-742`)

2) **Subtype photos are tracked by `sourceGroup`, but delete/replace still uses `sourceJan`.** The UI now tags photos with `sourceGroup` and variants with `photoGroupKey`, but delete/replace logic still reads `sourceJan`, so subtype photo groups won’t be uncategorized correctly. (`src/routes/listing-detail/+page.svelte:140-166`, `src/routes/listing-detail/+page.svelte:359-472`)

## Major Gaps / Poor Design Decisions
3) **Inventory split IDs can collide or be invalid.** New IDs are built as `${sourceId}:${option1Value}` without sanitization or collision checks. Editing `option1Value` (or duplicates) can create overlapping IDs or invalid identifiers. (`src/lib/listing-creation-slice.ts:507-525`)

## Missing Features
4) **No subtype-aware batch editor.** The batch editor still doesn’t surface per‑variant photo groups or allocation data, so users can’t verify subtype‑specific imagery at scale. (`docs/design/SUBTYPES_DESIGN.md:118-147`, `src/routes/listings/create/+page.svelte`)

## Recommendations
- **Require valid allocations before split.** Block approve if total allocated qty is 0 or exceeds base qty, and show validation errors.
- **Use `sourceGroup` everywhere for subtype photos.** Update delete/replace to respect `sourceGroup` rather than `sourceJan`.
- **Introduce safe ID generation** for split items (slugify + collision handling).

## Summary
The subtype design doc is largely implemented: `generate_proposals` now builds a single multi‑variant proposal per Base JAN, variants carry `photoGroupKey`, and approval can split inventory. However, allocation validation is missing, subtype photo deletions still use `sourceJan` instead of `sourceGroup`, and split ID generation is fragile. The feature is close but still unsafe without validation and consistent photo‑group handling.
