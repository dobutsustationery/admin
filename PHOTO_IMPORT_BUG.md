# Photo import resolution bug

Summary prepared from the October 26, 2026 investigation and the current local source. Production counts below describe the snapshot at **2026-10-26 17:51:15.875 UTC**, not a fresh audit. This document does not record a repair or deployment.

## What went wrong

The Google Photos importer can download a small preview and persist it to Drive as though it were the original source image. Subsequent cropping/background removal and Shopify sync use that already degraded copy. The Google Photos original remains crisp, but Shopify receives a small image with detail already lost.

In `functions/shared/photos-sync-worker.cjs`, `fetchSourceBytes()` builds candidates by adding the bare Google Photos URL before its `=d` download form. It tries the refreshed source first, then the stored source, and accepts the first successful HTTP response. A successful preview download therefore prevents the original-resolution candidate from being tried. The path lacks resolution validation that would reject this loss of detail. This bare-first ordering is still present in the local worker inspected for this summary.

This is distinct from intentionally requesting small images for admin thumbnails or storefront cards. The audit downloaded Shopify CDN master URLs without a width parameter and confirmed that the stored master files themselves were small. Enlarging their display or requesting a larger rendition cannot recover the missing detail.

## When and why the change was made

- Original backend implementation: `0f419375`, February 23, 2026, required the Google Photos `=d` download URL.
- Regression: `745faebe`, March 16, represented in this branch by `321055e91c75a838cc938b25183d03ee510ed996` (author date March 16; commit date March 18).
- Commit subject: `photos: refresh picker source urls and unstick failed reselections`.
- The diff added source-URL refreshing and multiple candidate URLs, but inserted each bare URL before its download form.

The recorded purpose was to recover photo selection/import failures involving source URLs. The evidence does not show a deliberate decision to reduce image quality for performance. Accepting previews was a regression in the recovery logic.

Retrieved bare-download completion events run from **2026-03-16T07:59:24.338Z** through **2026-10-25T19:21:09.523Z**. Those are observed events, not proof that these are the first and last affected imports ever.

## Confirmed scope

The audit covered 473 Shopify products and 2,843 image records.

| Finding | Snapshot count |
|---|---:|
| CDN images at most 512 pixels on their longest side | 540 |
| Products containing those images | 104 |
| Affected active, published products | 103 |
| Affected active, published products with stock | 99 |
| Affected products with stock, including one draft | 100 |
| Products with a low-resolution lead image | 80 |
| Products whose images are all low-resolution | 56 |
| Live, stocked products with a low-resolution lead image | 76 |

All 540 small CDN files were downloaded and decoded; their dimensions matched Shopify's API. The audit also measured 1,015 historical Drive source copies representing 584 distinct Google Photos IDs. Every measured source copy was at most 512 pixels on its longest side. Repeated transfers and gallery/variant duplication mean image records, files and original photos are different counts.

Attribution must remain qualified:

- **346 images:** fully recorded lineage to a bare-URL download.
- **163 images:** same Google Photos ID and measured preview import, but incomplete manual-edit parent history. Strong linkage, not a complete chain.
- **31 images across seven products:** small masters confirmed, but origin unverified. Four existed in September 2025, before this regression.
- **Seven medium-resolution images:** 513-1023 pixels, for separate review.
- **59 larger images across 14 products:** thumbnail-download history with incomplete current ancestry. They may have been repaired or enlarged; they are not included in the 540 confirmed-small total.

## Import dates for affected products with stock

For the 100 affected stocked products, source import dates are traceable for 93. Their recorded Google Photos-to-Drive imports range from **March 16 through October 25, 2026, in America/Toronto time**. The remaining seven products have unknown source-import dates, so that range does not bound every affected photo.

These are source import dates, not Shopify image creation dates. Where edit ancestry is incomplete, dates identify recorded imports of the same photo ID rather than proving which exact copy was used.

The existing [stocked-product date table](docs/investigations/photo-resolution-audit-2026-10-26/STOCKED_PRODUCT_IMPORT_DATES.md) gives the per-product answer, stock and confidence. Its companion CSVs retain per-image evidence.

## Concrete example: JAN 4542804169317

The original report referred to `454280416931`; the complete JAN is `4542804169317`, the 2027 Kawaii Animal Desk Calendar. All three current images were affected. Recorded source imports were October 25, 2026 (Toronto).

| Photo | Google Photos original dimensions | Imported Drive copy | Shopify CDN master |
|---|---|---|---|
| IMG_3120.HEIC | 2913 x 3533 | 422 x 512 | 387 x 275 |
| IMG_3121.HEIC | 2532 x 2676 | 484 x 512 | 413 x 277 |
| IMG_3119.HEIC | 3024 x 4032 | 384 x 512 | 379 x 292 |

The third has fully recorded ancestry; the first two have incomplete manual-edit parent links. All three imported copies were measured.

Shopify should receive a suitably large master derived from the full-resolution source and the intended edits. The existing sync requests up to 1600 pixels on the longest side. An `_s1600` filename or requested size is not proof that those pixels exist; cropping can change dimensions, and a small source cannot become a sharp large master by resizing.

## Repair approach and verification

1. Fix the source downloader before bulk reprocessing. Use the original-download form for Google Photos imports; do not silently accept a preview as a successful original import. Validate decoded dimensions against source metadata, allowing documented orientation/transform effects, and surface failures clearly.
2. Preserve source dimensions, downloaded dimensions, photo ID and edit ancestry so future imports can be audited. Add regression coverage for a bare URL returning HTTP 200 with a preview, failed original downloads, and cached low-resolution results.
3. Retrieve fresh original sources and regenerate the intended edits. Prioritize the 76 live, stocked products with degraded lead images, then the other affected gallery images. Do not merely enlarge existing files.
4. Invalidate or deliberately bypass old derivations. The worker's derivation key uses source type, source ID and transform; a normal retry can reuse an existing Drive result. Re-syncing the same file is not a repair.
5. Preserve product/variant image associations, selected edits and ordering. Validate repaired Drive files before replacing Shopify media, then inspect the actual CDN master dimensions and visual detail afterward.
6. Review uncertain-origin and larger-history cases separately. Do not assume every small legacy image was caused by this regression.

No repair was performed by the original audit or by writing this summary. Production deployment/fix status has not been independently re-checked here.

## Evidence already in this repository

- [Full audit, methods, product list and evidence links](docs/investigations/PHOTO_RESOLUTION_AUDIT_2026-10-26.md)
- [Machine-readable summary](docs/investigations/photo-resolution-audit-2026-10-26/summary.json)
- [Affected products and priorities](docs/investigations/photo-resolution-audit-2026-10-26/affected-products.csv)
- [Low-resolution image lineage and event IDs](docs/investigations/photo-resolution-audit-2026-10-26/low-resolution-images.csv)
- [Measured imported source copies](docs/investigations/photo-resolution-audit-2026-10-26/thumbnail-source-copies.csv)
- [Stocked-product import dates](docs/investigations/photo-resolution-audit-2026-10-26/stocked-product-import-dates.csv)
- [Stocked-image import dates](docs/investigations/photo-resolution-audit-2026-10-26/stocked-image-import-dates.csv)

The audit and its data directory are committed alongside this summary so the relative evidence links remain usable. No credentials or expiring source URLs are reproduced here.
