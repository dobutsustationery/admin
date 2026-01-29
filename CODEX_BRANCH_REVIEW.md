# Branch Review: Listings Creation

## Findings (ordered by severity)
1) **Listing images are likely `undefined` on approve.** `approve_proposal_thunk` maps photos using `f.url` and `f.name`, but photo items in `photos.janCodeToPhotos` are `baseUrl`/`filename`/`productUrl`. This creates listings with missing image URLs and alt text. (`src/lib/listing-creation-slice.ts:452-463`)

2) **Approving a handle group drops sibling JAN photos.** The detail page aggregates photos across all proposals with the same handle, but `approve_proposal_thunk` only pulls `janCode` photos from the current proposal when building `listing.images`. Any photos from sibling proposals are silently lost. (`src/routes/listing-detail/+page.svelte:76-174`, `src/lib/listing-creation-slice.ts:452-483`)

3) **Splitting a variant corrupts `janCode` semantics.** `split_variant` uses `variantId` (inventory ID) as the new proposal’s `janCode`. Downstream logic treats `janCode` as a lookup key into `photos.janCodeToPhotos`, so split proposals lose photo groups and related behavior. Use the item’s real JAN instead. (`src/lib/listing-creation-slice.ts:192-226`)

4) **Deleting a photo can uncategorize the wrong JAN.** In creation mode, `handleDeleteImage` always calls `uncategorize_photo` with the primary proposal’s JAN, even when the image came from a sibling proposal. This removes the wrong mapping. `listingImages` needs per-image JAN metadata or a reverse lookup. (`src/routes/listing-detail/+page.svelte:111-171`, `src/routes/listing-detail/+page.svelte:341-351`)

5) **Variant images are hidden from the gallery reorder flow.** `ListingEditor` filters out any image whose URL matches a subtype image, so variant images never appear in the reorderable gallery. This contradicts the design rule that reordering should update variant `imagePosition`. (`src/lib/components/ListingEditor.svelte:24-45`)

6) **`applyHandleUpdate` deletes listings even if other items still reference the old handle.** When moving an item to an existing handle, the old handle’s listing is deleted unconditionally. If any other IDs still map to the old handle, their listing disappears. This should check whether other IDs still point to the prior handle before deleting. (`src/lib/listings-slice.ts:261-291`)

7) **`SecureImage` always sends an Authorization header when a token exists.** This will trigger CORS preflights and can break loading of non-Google image URLs (e.g., Shopify or public URLs). It also leaks tokens unnecessarily. The auth header should be restricted to Google Photos/Drive URLs only. (`src/lib/components/SecureImage.svelte:31-48`)

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
2) Normalize photo field usage when creating listings (`baseUrl`/`productUrl` instead of `url`).
3) Ensure approve uses photos from *all* proposals in a handle group, or limit the detail view to the primary JAN’s photos for consistency.
4) Change `split_variant` to use the variant’s JAN as the new proposal key (and update downstream assumptions if needed).
5) Track JAN on each listing image so delete actions can `uncategorize_photo` on the correct JAN.
6) Include variant images in the reorderable gallery (or remove reorder → `imagePosition` syncing if the design changes).
7) Make `applyHandleUpdate` safe when multiple IDs still reference the old handle.
8) Limit `SecureImage` auth headers to Google URLs to avoid CORS/token leakage.
9) Implement the missing UX pieces (batch progress, dashboard widget, Photos route CTA) or update the design docs to match the current scope.

## Resolved since last review
- **Duplicate import in listings create page** (was a build break). The extra `recalculate_batch_navigation` import was removed. (`src/routes/listings/create/+page.svelte:6-18`)
