# Subtypes Feature Review

This review is based on `docs/design/SUBTYPES_DESIGN.md` and the current implementation in `src/lib/listing-creation-slice.ts`.

## Critical Issues
No remaining critical blockers identified after the latest fixes.

## Major Gaps / Poor Design Decisions
1) **Inventory split IDs can still collide with existing items.** IDs are now sanitized, but there’s no collision check against existing inventory. If an ID already exists, `split_inventory_item` merges qty into it, which can silently combine unrelated variants. This is still unsafe when option values are duplicated or empty. (`src/lib/listing-creation-slice.ts:507-525`, `src/lib/inventory.ts:721-742`)

2) **Allocation totals are not required to match base stock.** Validation now blocks zero and over‑allocation, but it still allows partial allocation (e.g., 3/10). The remaining quantity stays on the base item without a subtype. If partial split is intended, it needs to be explicit in the UI copy; otherwise enforce full allocation. (`src/lib/listing-creation-slice.ts:500-525`, `src/lib/inventory.ts:701-718`)

## Missing Features
3) **Batch editor is still only partially subtype-aware.** It now shows allocated quantity and uses `photoGroupKey` for thumbnails, but it doesn’t expose the photo group key itself or any validation state (e.g., allocation totals) at a glance. (`docs/design/SUBTYPES_DESIGN.md:118-147`, `src/routes/listings/create/+page.svelte`)

## Recommendations
- **Add collision handling for split IDs.** Either disallow collisions or append a suffix to ensure uniqueness.
- **Decide on partial vs full allocation.** If full allocation is required, enforce `sum(qty) == base.qty`. If partial is valid, make it explicit in UI copy.

## Summary
The subtype design doc is largely implemented: `generate_proposals` now builds a single multi‑variant proposal per Base JAN, variants carry `photoGroupKey`, approval can split inventory, and delete/replace now respects `sourceGroup`. Allocation validation now blocks zero/over‑allocation, but partial allocation remains ambiguous. The remaining gaps are split‑ID collision handling, clarity/enforcement around partial vs full allocation, and deeper batch‑editor visibility into subtype groups and validation state.

## Review Update (2026-02-01)
No new commits or working tree changes since the prior review. The issues listed above still apply and remain open.
