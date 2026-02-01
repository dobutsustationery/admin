# Subtypes Feature Review

This review is based on `docs/design/SUBTYPES_DESIGN.md` and the current implementation in `src/lib/listing-creation-slice.ts`.

## Critical Issues
No remaining critical blockers identified after the latest fixes.

## Major Gaps / Poor Design Decisions
1) **Split ID collisions are only partially handled.** The new collision check only looks at existing inventory IDs. If two variants share the same option value (or both default), the generated IDs can still collide within the same split batch, collapsing variants into one item via the merge path in `split_inventory_item`. This still risks losing intended variant separation. (`src/lib/listing-creation-slice.ts:523-551`, `src/lib/inventory.ts:721-742`)

## Missing Features
3) **Batch editor is still only partially subtype-aware.** It now shows allocated quantity and uses `photoGroupKey` for thumbnails, but it doesn’t expose the photo group key itself or any validation state (e.g., allocation totals) at a glance. (`docs/design/SUBTYPES_DESIGN.md:118-147`, `src/routes/listings/create/+page.svelte`)

## Recommendations
- **Extend collision handling to intra-batch IDs.** Track generated IDs in a temporary set when building `splits`, so duplicates get a suffix even if not yet in `state.inventory`.

## Summary
The subtype design doc is largely implemented: `generate_proposals` now builds a single multi‑variant proposal per Base JAN, variants carry `photoGroupKey`, approval can split inventory, delete/replace respects `sourceGroup`, and allocation is now strictly enforced to match source stock. Collision handling now prevents conflicts with existing inventory IDs, but it does not prevent duplicates within the same split batch. The remaining gaps are intra-batch ID collision handling and deeper batch‑editor visibility into subtype groups and validation state.

## Review Update (2026-02-01)
Strict allocation enforcement and basic collision handling were added in `a44750b`, so prior gaps on partial allocation and existing-ID collisions are resolved. One collision case still remains (duplicate option values within the same split batch), and the batch editor is still only partially subtype-aware.
