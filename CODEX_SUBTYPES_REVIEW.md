# Subtypes Feature Review

This review is based on `docs/design/SUBTYPES_DESIGN.md` and the current implementation in `src/lib/listing-creation-slice.ts`.

## Critical Issues
No remaining critical blockers identified after the latest fixes.

## Major Gaps / Poor Design Decisions
1) **Inventory split IDs can still collide with existing items.** IDs are now sanitized, but there’s no collision check against existing inventory. If an ID already exists, `split_inventory_item` merges qty into it, which can silently combine unrelated variants. (`src/lib/listing-creation-slice.ts:507-525`, `src/lib/inventory.ts:721-742`)

2) **Allocation totals are not required to match base stock.** Validation blocks zero and over‑allocation, but it still allows partial allocation (e.g., 3/10). The remaining quantity stays on the base item without a subtype, which may be undesired if the goal is full split. If partial split is intended, it needs to be explicit in the UI. (`src/lib/listing-creation-slice.ts:500-525`, `src/lib/inventory.ts:701-718`)

## Missing Features
3) **No subtype-aware batch editor.** The batch editor still doesn’t surface per‑variant photo groups or allocation data, so users can’t verify subtype‑specific imagery at scale. (`docs/design/SUBTYPES_DESIGN.md:118-147`, `src/routes/listings/create/+page.svelte`)

## Recommendations
- **Add collision handling for split IDs.** Either disallow collisions or append a suffix to ensure uniqueness.
- **Decide on partial vs full allocation.** If full allocation is required, enforce `sum(qty) == base.qty`. If partial is valid, make it explicit in UI copy.

## Summary
The subtype design doc is largely implemented: `generate_proposals` now builds a single multi‑variant proposal per Base JAN, variants carry `photoGroupKey`, approval can split inventory, and delete/replace now respects `sourceGroup`. The remaining gaps are collision handling for split IDs and clarity/enforcement around partial vs full allocation. Batch editor remains subtype‑agnostic.
