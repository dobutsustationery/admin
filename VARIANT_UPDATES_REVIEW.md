# Variant Updates Review (Updated After `a46919e`)

## Scope Reviewed
- `src/lib/components/ListingEditor.svelte`
- `src/lib/listing-creation-slice.ts`
- `src/lib/root-reducer.ts`
- `src/routes/listing-detail/+page.svelte`
- `tests/unit/listing-creation-variants.test.ts`

## Validation Run
- `npm run check`: pass (0 errors, 0 warnings)
- `npm test -- tests/unit/listing-creation-variants.test.ts tests/unit/shopify-sync-core.test.ts`: pass

## Summary
Most of the previously-blocking issues are fixed in `a46919e`:
- thunk broadcasting replaced with serializable intent actions,
- non-deterministic reducer UUID generation removed,
- illegal `store.getState()` usage removed,
- compile errors resolved,
- targeted unit tests added.

I found one remaining product-safety gap and one testing gap.

## Findings (ordered by severity)

### 1) High: missing transfer warning when an item will be moved from another listing
- `src/lib/root-reducer.ts:1001`
- `src/routes/listing-detail/+page.svelte:1510`

Given the current data model (`inventory item -> single handle`), moving an item between listings is valid behavior, but the user should be warned before approval if a move will happen.

Today there is no explicit user warning in the approval flow when an item already belongs to another listing (live or already-approved draft). The item is silently reassigned on approve.

Impact:
- Users may accidentally remove inventory from an existing listing when approving a new draft.
- Reassignment is technically correct for this model, but easy to do unintentionally without visibility.

Recommendation:
- Keep current “steal/transfer” behavior, but add a confirmation warning in `handleApprove` before dispatching approve.
- Preflight check each proposal variant item against `inventory.idToItem[itemId].handle`:
  - if handle is non-empty and different from the target handle, include it in warning list.
- Warning text should explicitly name source handle and destination handle.
- Proceed only on user confirmation.

This satisfies your desired UX:
- If two drafts share an item, warning appears when approving the second draft after the first has been approved (because the first approval sets the item handle).
- If stealing from an existing live listing, warning appears at approval time and allows intentional transfer.

### 2) Medium: no explicit replay-equivalence test for intent-action path
- `tests/unit/listing-creation-variants.test.ts`

The added tests validate add/remove behavior, but they do not assert replay equivalence (same final state when replaying the same action log from empty state).

Recommendation:
- Add a replay test that records dispatched broadcast actions (`*_requested`, `update_field`, etc.), replays them into a fresh store, and asserts deep state equality for:
  - `listingCreation.proposals`,
  - `inventory.idToItem` handles,
  - variant IDs and ordering.

## What Is Good Now
- Intent-action architecture is a strong improvement for event sourcing.
- Reducer-level add/remove operations are now deterministic with payload-provided `variantId`.
- Root reducer now uses pre/post reducer state instead of external store access.
- Tests cover merge plus add/remove intent flows.

## Ship Recommendation
- I recommend adding finding #1 before broad rollout, because it prevents accidental inventory transfer while preserving intended behavior.
- After that, add replay-equivalence coverage to reduce regression risk.
