# Branch Review: Listings Creation

## Findings (ordered by severity)
1) **Splitting a variant corrupts `janCode` semantics.** `split_variant` uses `variantId` (inventory ID) as the new proposal’s `janCode`. Downstream logic treats `janCode` as a lookup key into `photos.janCodeToPhotos`, so split proposals lose photo groups and related behavior. Use the item’s real JAN instead. (`src/lib/listing-creation-slice.ts:192-226`)

2) **Variant images are hidden from the gallery reorder flow.** `ListingEditor` filters out any image whose URL matches a subtype image, so variant images never appear in the reorderable gallery. This contradicts the design rule that reordering should update variant `imagePosition`. (`src/lib/components/ListingEditor.svelte:24-45`)

## Design mismatches / missing pieces
- **Batch queue is capped at 10 proposals.** `generate_proposals` stops after 10 items, so the “to-do list” never materializes beyond the first batch. The design calls for a larger proposal pool with batch selection at review time. (`src/lib/listing-creation-slice.ts:366-409`)
- **Approve should advance to next item, not return to batch list.** The design says “Approve” moves to the next proposal; the implementation navigates back to `/listings/create` immediately. (`src/routes/listing-detail/+page.svelte:442-447`)
- **Drop should remove the entire handle group.** The design (and approve flow) treat a handle group as a single unit in review. `handleDrop` removes only the current proposal, leaving sibling proposals intact and inconsistent with the aggregated detail view. (`src/routes/listing-detail/+page.svelte:507-534`)
- **Integration plan missing:** no “Create Listings” button in Photos, and no dashboard widget showing pending proposal count. (`docs/design/listings-creation.md:170-176`, `src/routes/photos/+page.svelte`)
- **Batch progress UI and “return to dashboard” are not implemented.** There’s a celebration overlay, but no progress bar or dashboard summary redirect. (`docs/design/listings-creation.md:26-42`, `src/routes/listings/create/+page.svelte`)

## TODOs / cleanup
- **Draft gallery image replacement is not implemented.** In creation mode, replacing a gallery image just alerts. (`src/routes/listing-detail/+page.svelte:415-416`)
- **Remove unused imports.** Clean unused items like `merge_proposal`, `split_variant`, `move_variant` in the create page. (`src/routes/listings/create/+page.svelte:6-18`)
- **Clarify photo ordering source of truth.** `listingImageOrder` is stored only on the primary proposal, but the detail view merges photos from all sibling proposals. If a handle group is split later, ordering information may be lost or inconsistent. (Design: `docs/design/listings-creation-photos.md:72-99`)

## Suggested closure checklist
1) Remove unused imports in `src/routes/listings/create/+page.svelte`.
2) Change `split_variant` to use the variant’s JAN as the new proposal key (and update downstream assumptions if needed).
3) Include variant images in the reorderable gallery (or remove reorder → `imagePosition` syncing if the design changes).
4) Implement the missing UX pieces (batch progress, dashboard widget, Photos route CTA) or update the design docs to match the current scope.

## Resolved since last review
- **Duplicate import in listings create page** (was a build break). The extra `recalculate_batch_navigation` import was removed. (`src/routes/listings/create/+page.svelte:6-18`)
- **Listing images undefined on approve** fixed by using `baseUrl`/`productUrl` and `filename`. (`src/lib/listing-creation-slice.ts:468-472`)
- **Approve dropped sibling JAN photos** fixed by aggregating photos across all handle-group proposals. (`src/lib/listing-creation-slice.ts:453-479`)
- **Wrong JAN uncategorized on delete** fixed by threading `sourceJan` into image objects and delete handler. (`src/routes/listing-detail/+page.svelte:130-158`, `src/routes/listing-detail/+page.svelte:343-356`)
- **`applyHandleUpdate` removed listings still in use** fixed by checking whether the old handle is still referenced. (`src/lib/listings-slice.ts:279-305`)
- **`SecureImage` auth header leak/CORS** fixed by limiting auth headers to Google domains. (`src/lib/components/SecureImage.svelte:39-46`)
