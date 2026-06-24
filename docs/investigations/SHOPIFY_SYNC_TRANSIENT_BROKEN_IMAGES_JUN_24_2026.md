# Shopify sync transient broken images — Jun 24 2026

## Summary

On Jun 24 2026, a recent Shopify sync for the listing containing JAN
`4542804123579` appeared to leave some Shopify images broken. The issue later
resolved without intervention.

The production records do not show a persistent dead image URL. A read-only
check of the current Shopify product showed all current Shopify CDN image URLs
returning `200 image/png`.

The likely cause is the current listing sync procedure: it deletes every
existing Shopify product image and recreates the full image set from source
Google image URLs. That can create a transient broken-image window while
Shopify fetches and processes replacement images. It also means a routine sync
can replace stable Shopify-hosted image records even when the intended change is
not image-related.

## Production delta inspected

The latest local production backup was `../production-backup-jun-23`.

Cutoffs from that backup:

- `broadcast`: latest timestamp `2026-06-22T19:11:10.617Z`
- `sync`: latest timestamp `2026-06-21T15:48:51.823Z`
- `request_shopify_sync`: latest timestamp `2026-06-21T15:47:57.805Z`

New production docs after those cutoffs:

- `broadcast`: 12 docs
- `sync`: 7 docs
- `request_shopify_sync`: 1 doc

The relevant sync request was:

- request doc: `apGSl35v58BN9Loj32Pd`
- event type: `shopify/sync_requested`
- timestamp: `2026-06-24T11:38:17.878Z`
- handle: `amifa-masterpiece-collection-a4-collage-paper-8-15-4542804123555`
- request id: `listing-sync-1782301097391-j3I5AzfxDaNHa7Es4cZigFs4vEI2`
- Shopify product id: `15828311277950`

The sync completed successfully:

- result doc: `result_apGSl35v58BN9Loj32Pd`
- event type: `shopify/sync_completed`
- timestamp: `2026-06-24T11:38:58.848Z`
- reported `successCount: 2`, `failureCount: 0`

## Preceding inventory action

About four minutes before the sync, production recorded:

- broadcast doc: `Wyb2VfksLB4iLyb17Bq5`
- action type: `replace_subtype`
- timestamp: `2026-06-24T11:34:30.917Z`

Payload:

```json
{
  "sourceKey": "4542804123555Transparent",
  "targetKey": "4542804123555Opaque",
  "reason": "4542804123555 was split by mistake - there are two distinct Jans 4542804123579 (transparent)"
}
```

After this, the listing sync payload contained two variants:

| Item key | SKU | JAN | Subtype | Available | Image source |
| --- | --- | --- | --- | ---: | --- |
| `4542804123579Transparent` | `4542804123579Transparent` | `4542804123579` | `Transparent` | 18 | Google `lh3` URL |
| `4542804123555Opaque` | `4542804123555Opaque` | `4542804123555` | `Opaque` | 20 | Google `lh3` URL |

## Image payload

The sync request carried four listing gallery images:

| Position | Source URL shape | Alt text |
| ---: | --- | --- |
| 1 | `https://lh3.googleusercontent.com/d/1trqhI9TpPe8l0rLI1HBTLl8hf349GIOg=s0` | `IMG_7586.HEIC` |
| 2 | `https://lh3.googleusercontent.com/d/1gqnlqfSEGsOzRsxfQyAmikSDYeb6Q7_d=s0` | `IMG_7585.HEIC` |
| 3 | `https://lh3.googleusercontent.com/d/1hiuEWzTvzFajJ3HLgmlU6hX5haVJ5dqM=s0` | `IMG_7588.HEIC` |
| 4 | `https://lh3.googleusercontent.com/d/1hbN1q6ducd7ra0t7VXKd8UatFHArIlHu=s0` | `IMG_7587.HEIC` |

These were not new image URLs. Earlier sync requests for the same handle in the
Jun 23 backup used the same four image URLs.

## Current Shopify state

A read-only Shopify Admin API check of product `15828311277950` after the issue
resolved showed:

- product status: `active`
- variant count: 2
- image count: 6

The six images were all created during the Jun 24 sync window:

- 4 gallery images, positions 1-4
- 2 duplicate variant attachment images, positions 5-6

The variant image ids point to the duplicate attachment images, not the gallery
images:

| SKU | Variant image position |
| --- | ---: |
| `4542804123579Transparent` | 5 |
| `4542804123555Opaque` | 6 |

All six current CDN URLs returned `200 image/png` when checked.

## Why this can self-resolve

The observed broken images were most likely transient Shopify image processing
or propagation, not a durable bad URL in our stored state.

The sync procedure currently:

1. Updates the product with an `images` payload derived from listing gallery
   images.
2. Fetches the product again.
3. Deletes every existing Shopify product image.
4. Recreates gallery images from Google `lh3` source URLs.
5. Recreates variant attachment images from variant image URLs, even when those
   URLs are already present in the gallery.
6. Updates variants to point at the newly-created variant attachment images.

That means an ordinary listing sync can temporarily remove stable Shopify CDN
images and replace them with newly imported copies. If Shopify accepts the API
operation but image ingestion or CDN propagation lags behind product publication,
the storefront can briefly show broken images and then recover without any
action from us.

## Audit gap

The sync audit records do not record individual image deletes, image creates, or
variant image-id assignments. The relevant audit rows show only high-level calls:

- `location_resolve`
- `product_update`
- `product_publication_sync`
- two `inventory_sync` calls
- `sync_completed`

The `product_update` audit response stores only:

- `productId`
- `handle`
- `variantCount`

This hides the destructive image reconciliation work. A future investigation
would not be able to reconstruct the exact image ids deleted and recreated from
the persisted sync records alone.

## Code path

Relevant code is in
`functions/shared/shopify-sync-core.cjs`.

Key behavior:

- `buildGalleryImageEntries` normalizes listing image URLs into desired gallery
  entries.
- `buildVariantAttachmentEntries` independently builds variant image entries
  from variant `image` fields.
- `reconcileProductGallery` deletes every existing product image before creating
  the desired gallery and variant images.

The important procedure-level concern is not that this specific sync now needs
repair. It is that image sync is not idempotent by Shopify image identity and
does not preserve stable Shopify-hosted images when sources are unchanged.

## Recommendation

No immediate data repair is required for this incident because the storefront
images recovered and current CDN URLs are reachable.

However, we should reconsider the Shopify listing sync procedure before relying
on it for routine production updates:

1. Do not delete all existing Shopify product images as the default
   reconciliation strategy.
2. Reuse existing Shopify image records when the normalized source identity is
   unchanged.
3. Avoid creating separate duplicate variant images when the variant image is
   already present in the gallery and can be attached by image id.
4. Log image-level operations in sync records: deleted image ids, created image
   ids, source URLs, final CDN URLs, and variant image assignments.
5. Consider a two-phase image sync: upload/verify replacement images first, then
   switch product/variant references after Shopify returns usable CDN assets.

This incident is therefore best treated as a transient symptom of a risky sync
procedure, not as evidence that the specific `4542804123579` listing data is
currently broken.
