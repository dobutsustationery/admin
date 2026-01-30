# Branch Review: Listings Creation

## Findings (ordered by severity)
1) **Draft image “replace” does not actually replace the old image.** The draft flow adds a new listing-only image and swaps the order ID, but it never removes the old image from the gallery or uncategorizes it. The old image will still render unless it’s explicitly removed. (`src/routes/listing-detail/+page.svelte:421-458`)

## Design mismatches / missing pieces
- **Batch queue is capped (now 1000 proposals).** `generate_proposals` stops after 1000 items, so the “to-do list” still doesn’t reflect the full backlog. The design calls for a larger (or unbounded) proposal pool with batch selection at review time. (`src/lib/listing-creation-slice.ts:366-409`)
- **Batch size is 50, not 10.** `handleStartBatch` now takes 50 drafts per batch. If the design still expects 10, this needs alignment. (`src/routes/listings/create/+page.svelte:185-190`)
- **Batch progress UI is still missing.** The batch header shows a count, but there’s no progress bar (0/10) or completion summary redirect. (`docs/design/listings-creation.md:26-42`, `src/routes/listings/create/+page.svelte`)

## TODOs / cleanup
- **Draft gallery image replacement is incomplete.** It adds a new listing-only image and swaps order IDs, but does not remove the replaced image from the gallery. (`src/routes/listing-detail/+page.svelte:421-458`)
- **Clarify photo ordering source of truth.** `listingImageOrder` is stored only on the primary proposal, but the detail view merges photos from all sibling proposals. If a handle group is split later, ordering information may be lost or inconsistent. (Design: `docs/design/listings-creation-photos.md:72-99`)

## Suggested closure checklist
1) Complete draft image replacement (remove/uncategorize the old image or convert it to listing-only explicitly).
2) Resolve batch size/progress UI mismatches (10 vs 50, progress bar vs count).

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
- **Split variant preserves JAN semantics** by keeping the original JAN in the proposal data while using a unique key. (`src/lib/listing-creation-slice.ts:209-226`)
- **Batch limit increased to 1000** to widen the proposal pool. (`src/lib/listing-creation-slice.ts:405-408`)
- **Celebration now offers “Return to Dashboard.”** (`src/routes/listings/create/+page.svelte:49-74`, `src/routes/listings/create/+page.svelte:354-368`)
