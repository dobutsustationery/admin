# Branch Review: Listings Creation

## Findings (ordered by severity)
1) **Splitting a variant corrupts `janCode` semantics.** `split_variant` uses `variantId` (inventory ID) as the new proposal’s `janCode`. Downstream logic treats `janCode` as a lookup key into `photos.janCodeToPhotos`, so split proposals lose photo groups and related behavior. Use the item’s real JAN instead. (`src/lib/listing-creation-slice.ts:192-226`)

## Design mismatches / missing pieces
- **Batch queue is capped (now 50 proposals).** `generate_proposals` stops after 50 items, so the “to-do list” still doesn’t reflect the full backlog. The design calls for a larger (or unbounded) proposal pool with batch selection at review time. (`src/lib/listing-creation-slice.ts:366-409`)
- **Batch progress UI and “return to dashboard” are not implemented.** There’s a celebration overlay, but no progress bar or dashboard summary redirect. (`docs/design/listings-creation.md:26-42`, `src/routes/listings/create/+page.svelte`)

## TODOs / cleanup
- **Draft gallery image replacement is not implemented.** In creation mode, replacing a gallery image just alerts. (`src/routes/listing-detail/+page.svelte:415-416`)
- **Clarify photo ordering source of truth.** `listingImageOrder` is stored only on the primary proposal, but the detail view merges photos from all sibling proposals. If a handle group is split later, ordering information may be lost or inconsistent. (Design: `docs/design/listings-creation-photos.md:72-99`)

## Suggested closure checklist
1) Change `split_variant` to use the variant’s JAN as the new proposal key (and update downstream assumptions if needed).
2) Implement the missing UX pieces (batch progress, dashboard widget, Photos route CTA) or update the design docs to match the current scope.

## Resolved since last review
- **Duplicate import in listings create page** (was a build break). The extra `recalculate_batch_navigation` import was removed. (`src/routes/listings/create/+page.svelte:6-18`)
- **Listing images undefined on approve** fixed by using `baseUrl`/`productUrl` and `filename`. (`src/lib/listing-creation-slice.ts:468-472`)
- **Approve dropped sibling JAN photos** fixed by aggregating photos across all handle-group proposals. (`src/lib/listing-creation-slice.ts:453-479`)
- **Wrong JAN uncategorized on delete** fixed by threading `sourceJan` into image objects and delete handler. (`src/routes/listing-detail/+page.svelte:130-158`, `src/routes/listing-detail/+page.svelte:343-356`)
- **`applyHandleUpdate` removed listings still in use** fixed by checking whether the old handle is still referenced. (`src/lib/listings-slice.ts:279-305`)
- **`SecureImage` auth header leak/CORS** fixed by limiting auth headers to Google domains. (`src/lib/components/SecureImage.svelte:39-46`)
- **SKU-first image ordering** now used for both create and live mode; gallery order is preserved and variant positions are deterministic. (`src/lib/listing-image-ordering.ts`, `src/routes/listing-detail/+page.svelte`)
- **Approve now advances to the next item** when a batch remains. (`src/routes/listing-detail/+page.svelte:451-466`)
- **Drop removes the entire handle group** instead of only the current proposal. (`src/routes/listing-detail/+page.svelte:522-556`)
- **Integration plan items implemented:** Photos route button and dashboard “Create Listings” card. (`src/routes/photos/+page.svelte:965-969`, `src/routes/+page.svelte:61-63`)
