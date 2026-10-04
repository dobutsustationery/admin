# Shopify Listing Sync Slowness

> Investigation date: 2026-07-14  
> Environment: production (`dobutsu-admin`)  
> Route: `/shopify-listings`  
> Scope: read-only investigation; no production, configuration, or code changes were made while gathering this evidence.

## Summary

The slow operation was not the Shopify-to-admin catalog refresh. It was a bulk
admin-to-Shopify update of 223 listings queued from the Shopify Listings page.

The operation is slow for two related reasons:

1. The worker is limited to three single-concurrency function instances, so at
   most three listings are processed at once.
2. Every listing request performs a full product synchronization, including
   destructive image reconciliation, even when the issue selected in the UI is
   unrelated to images and the images already compare equal.

For each existing product, image reconciliation fetches the current product,
deletes every Shopify product image, recreates all gallery and variant images
sequentially, fetches the product again, and reattaches the newly created image
IDs to variants. Shopify must therefore download unchanged images again from
Google-hosted URLs. This is both the main source of variable processing time and
the cause of all failures observed in this run.

The user's expectation that a quantity-, price-, category-, or metadata-only
sync would leave matching images untouched is not represented in the current
mutation path. The UI comparison is field-aware, but the queued request and
backend worker are not field-scoped.

## Production snapshot

At 2026-07-14 09:23:14 EDT:

| State | Listings |
| --- | ---: |
| Queued | 223 |
| Succeeded | 174 |
| Failed | 8 |
| Running | 3 |
| Waiting to be claimed | 38 |
| Partial failures | 0 |

Additional observations:

- The 223 requests were queued between 08:23 and 08:30 EDT.
- 81.6% had reached a terminal state at the snapshot.
- Successful requests had synchronized 373 variants.
- Worker execution time was 52.1 seconds at the median, 91.0 seconds at the
  90th percentile, and 163.7 seconds at the maximum.
- Only 24 requests reached a terminal state in the preceding ten minutes, or
  approximately 2.4 listings per minute.
- At that rate, the remaining queue was expected to require approximately 16
  more minutes.
- Some successful requests spent approximately 55 minutes waiting for a worker
  before their actual processing began. Most of the apparent per-listing delay
  was queue wait rather than execution time.
- Requests were not observed to be claimed strictly in creation order.

The separate incremental catalog refresh requested at 09:19:57 EDT completed
in about ten seconds and applied 177 changed Shopify catalog records. It was not
the source of the long-running status.

## Why every request touches images

### 1. The UI computes a detailed diff

`src/routes/shopify-listings/+page.svelte` builds a comparable local projection
and calls `diffComparableShopifyListingsDetailed`. The result contains mismatch
keys and issue classifications such as quantity, price, gallery, variant image,
category, and metadata.

This part of the system knows whether images differ.

### 2. The issue classification is not included in the request

`syncListingsForSection(issue, sectionRows)` uses `issue` to choose rows and to
format the completion message. For every selected row it calls the same
`buildListingSyncRequest` function.

The request contains the complete listing projection and all variants, but no
field mask, changed-field list, selected issue, or image-sync decision. Once the
request reaches the backend, it is impossible for the worker to distinguish a
quantity-only sync from an image sync.

Relevant code:

- `src/routes/shopify-listings/+page.svelte`, `buildListingSyncRequest` and
  `syncListingsForSection`
- `src/lib/shopify-listing-projection.ts`, `buildShopifySyncRequestEvent`

### 3. The projection always carries image URLs

`buildAdminShopifyListingProjection` includes all listing gallery images and
the image for each non-default variant. `buildShopifySyncRequestEvent` copies
that complete projection into the Firestore request.

Matching images are therefore still present in every ordinary full listing
request.

### 4. The worker always executes the full upsert

`functions/shared/shopify-sync-worker.cjs` calls
`upsertProductFromRequest(shopifyConfig, requestData)` for every claimed
request. There is no alternate path for inventory-only, metadata-only, or
image-free updates.

The normal workflow is:

1. resolve the Shopify location;
2. upsert the product;
3. synchronize publication state;
4. set inventory for each variant sequentially.

### 5. Product upsert always reconciles images

At the end of `upsertProductFromRequest`, the code unconditionally calls
`reconcileVariantOrderAndImages`. That function unconditionally calls
`reconcileProductGallery`.

`reconcileProductGallery` then:

1. fetches the product;
2. loops over every existing image and deletes it;
3. creates every desired gallery image sequentially;
4. creates every desired variant attachment image sequentially;
5. fetches the product again;
6. updates image metadata as needed;
7. fetches the product once more;
8. updates variant positions and newly assigned image IDs sequentially.

There is no equality check before deletion. The later position/alt-text check
only operates on images that have already been deleted and recreated.

Relevant code:

- `functions/shared/shopify-sync-core.cjs`, `reconcileProductGallery`
- `functions/shared/shopify-sync-core.cjs`,
  `reconcileVariantOrderAndImages`
- `functions/shared/shopify-sync-core.cjs`, `upsertProductFromRequest`

The initial REST product update payload also includes the complete `images`
array. The explicit reconciliation runs afterward, so Shopify may process the
image set during the product update and then process it again during the
delete-and-recreate phase.

## Failures observed

All eight failures had the same shape: Shopify returned HTTP 422 while creating
a product image because it timed out downloading an unchanged image from
`lh3.googleusercontent.com`.

Affected handles:

1. `furukawa-playful-neko-cat-letter-set-4952270286409`
2. `gatcha-blind-mystery-box-sleeping-dog-collectibles-4570198783888`
3. `amifa-frog-day-sticky-notes-70-4542804151541`
4. `amifa-botanical-clear-card-set-4542804115918`
5. `amifa-fruit-sticker-flakes-4542804102017`
6. `amifa-antique-foil-sticker-flakes-4542804103199`
7. `amifa-color-me-up-clear-paper-stickers-30-4542804125566`
8. `amifa-photo-doodle-flakes-24-4542804152067`

These failures occurred during product/image processing before inventory
synchronization. No automatic retry was observed.

## Impact

- Unchanged images are deleted and re-uploaded during unrelated updates.
- Bulk jobs generate substantially more Shopify and Google image traffic than
  their displayed issue count suggests.
- Three workers remain occupied by slow external image downloads, increasing
  queue time for all listings.
- A transient image-host timeout can fail an otherwise valid quantity or
  metadata update.
- Because deletion precedes recreation, a failed image transfer can leave a
  product with transiently missing or incomplete images. This is consistent
  with the risk described in
  `docs/investigations/SHOPIFY_SYNC_TRANSIENT_BROKEN_IMAGES_JUN_24_2026.md`.
- Progress reporting groups the work as listing syncs and does not reveal that
  most time is spent waiting in the queue or replacing images.

## Review questions

No fix is proposed or implemented in this document. The following decisions
should be made before changing the workflow:

1. Should the UI send an explicit field mask derived from the reviewed diff?
2. Should the backend independently compare current Shopify state before
   mutating fields, rather than trusting a client-provided field mask?
3. Should inventory-only updates use a dedicated path that skips product,
   publication, category, and image operations?
4. When images do need synchronization, can reconciliation preserve matching
   Shopify image IDs and only create, delete, reorder, or reattach the delta?
5. Should image transfer failures be isolated from otherwise successful
   metadata and inventory changes?
6. Should transient Shopify/Google download errors be retried, and if so, how
   can retries avoid repeating destructive image deletion?
7. Should bulk-sync progress distinguish queued, actively processing,
   succeeded, failed, and retriable listings?

## Conclusion

The job is slow primarily because a field-aware audit feeds a field-unaware,
full-replacement mutation. With only three concurrent workers, unconditional
serial image replacement makes each listing expensive and turns a 223-listing
bulk operation into a long queue. Avoiding image work when the image comparison
already matches would remove the largest unnecessary cost and eliminate the
failure mode observed in this run.
