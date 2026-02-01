# Subtypes Feature Review

This review is based on `docs/design/SUBTYPES_DESIGN.md` and the current implementation in `src/lib/listing-creation-slice.ts`.

## Critical Issues
No remaining critical blockers identified after the latest fixes.

## Major Gaps / Poor Design Decisions
No remaining major gaps after the latest fixes.

## Missing Features
1) **Batch editor is still only partially subtype-aware.** It now shows allocated quantity and uses `photoGroupKey` for thumbnails, but it doesn’t expose the photo group key itself or any validation state (e.g., allocation totals) at a glance. (`docs/design/SUBTYPES_DESIGN.md:118-147`, `src/routes/listings/create/+page.svelte`)

## Recommendations
- **Optional: Surface subtype context in the batch editor.** Consider adding a column or tooltip for `photoGroupKey` and a visual indicator when allocations are incomplete.

## Summary
The subtype design doc is largely implemented: `generate_proposals` now builds a single multi‑variant proposal per Base JAN, variants carry `photoGroupKey`, approval can split inventory, delete/replace respects `sourceGroup`, allocation is strictly enforced to match source stock, and collision handling now covers both existing inventory IDs and intra‑batch duplicates. The remaining gap is deeper batch‑editor visibility into subtype groups and validation state.

## Review Update (2026-02-01)
Intra‑batch collision handling was added in `ba1f3d6`, resolving the last functional gap called out in the previous review. The only remaining item is the batch editor visibility enhancement noted above.
