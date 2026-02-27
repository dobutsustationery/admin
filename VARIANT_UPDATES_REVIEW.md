# Variant Updates Review (Updated After `1dea6e3`)

## Scope Reviewed
- `src/lib/root-reducer.ts`
- `src/routes/listing-detail/+page.svelte`
- `src/lib/components/ListingEditor.svelte`
- `tests/unit/listing-creation-variants.test.ts`

## Validation Run
- `npm run check`: pass (0 errors, 0 warnings)
- `npm test -- tests/unit/listing-creation-variants.test.ts tests/unit/shopify-sync-core.test.ts`: pass

## Summary
Recent commits fixed the previously reported selection blocker:
- cross-JAN add now allows selecting items attached to other listings (steal workflow),
- replay-equivalence coverage is present and passing.

I found one remaining high-severity mismatch with the requested UX.

## Findings

### 1) High: transfer happens at draft add-time, so submit-time warning can be bypassed
- `src/lib/root-reducer.ts:1005`
- `src/routes/listing-detail/+page.svelte:1135`

In create mode, `add_variant_requested` immediately mutates inventory `handle` for newly brought-in items:
- `from: currentItemHandle`
- `to: targetHandle`

That means the item is moved when added to draft, before approval.

`handleApprove` warning only triggers when `item.handle !== targetHandle`. Since add-time already changed `item.handle` to `targetHandle`, the approve-time warning often does not fire for those items.

Impact:
- Inventory can be moved/unlisted during draft editing rather than on submit.
- The intended safeguard (“warn when submitting second draft / stealing from live listing”) is weakened or skipped.
- Removing the variant before approval can leave the item detached (`handle: ""`) without explicit transfer confirmation.

Recommendation:
- For create-mode variant adds, avoid mutating live inventory `handle` until approval.
- Keep transfer intent in draft proposal state; on approve, show collision warning, then apply handle updates.
- If immediate mutation is required, add explicit add-time confirmation in create mode and adjust approve copy to say transfer may already have occurred.

## What Looks Good
- Intent actions are serializable and replay-safe.
- Deterministic variant IDs are maintained via payload-provided `variantId`.
- Replay-equivalence test exists and passes.
- Steal selection path is now enabled.
- Approval warning copy is clear when collisions are detected.

## Ship Recommendation
- Fix finding #1 before rollout if the product requirement remains “warning at submit/approve before transfer.”
