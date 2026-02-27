# Variant Updates Review (Updated After `43a8284`)

## Scope Reviewed
- `src/lib/root-reducer.ts`
- `src/routes/listing-detail/+page.svelte`
- `tests/unit/listing-creation-variants.test.ts`

## Validation Run
- `npm run check`: pass (0 errors, 0 warnings)
- `npm test -- tests/unit/listing-creation-variants.test.ts`: pass

## Summary
The new changes address the two prior recommendations:
- Approval preflight now warns when approving a draft would move items from another listing (`handleApprove` collision warning).
- Replay-equivalence coverage was added (`should result in identical state when replaying intent actions from scratch`).

I found one remaining behavior mismatch against your stated requirement.

## Findings

### 1) High: “steal from existing live listing” is still blocked during add-variant selection
- `src/lib/root-reducer.ts:964`
- `src/routes/listing-detail/+page.svelte:1512`

Current selection logic for cross-JAN add only accepts items with no handle:
- `item.janCode === janCode && !item.handle`

So items already attached to a live listing are not selectable for draft add, which prevents the intended “steal on approve with warning” workflow.

Impact:
- Users cannot stage a transfer from an existing live listing into a new draft via add-variant.
- The new approval warning works, but only for collisions that are already present in the draft; this specific entry path never creates those collisions.

Recommendation:
- In create mode intent handling, allow selecting inventory items where:
  - `item.janCode === janCode`
  - item is not already in the same target proposal
  - item can have any `handle` (including another live listing)
- Keep the new approval warning as the confirmation gate before the actual transfer.

## What Looks Good
- Intent actions remain serializable and replay-safe.
- Deterministic variant IDs are still maintained (payload-provided).
- Replay test now exists and passes.
- Approval warning message correctly lists source handles and destination handle.

## Ship Recommendation
- Close the remaining selection constraint (finding #1) to fully match desired transfer behavior.
- After that, this flow is aligned with the stated product rule.
