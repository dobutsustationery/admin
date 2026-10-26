# Photo import repair plan

Proposed implementation and recovery sequence, October 26, 2026. Fix future imports first, then recover affected product images from original sources while preserving their intended edits and associations. The [bug summary](../../PHOTO_IMPORT_BUG.md) and [snapshot audit](../investigations/PHOTO_RESOLUTION_AUDIT_2026-10-26.md) contain the incident evidence. No repair or deployment is recorded by this plan.

## Download and verify original sources

Extract the source-download policy in `functions/shared/photos-sync-worker.cjs` into a testable helper. Classify sources explicitly as Google Photos, Drive or external URLs rather than applying a Photos fallback policy to every image.

For Photos images, try the refreshed download URL and then the stored download URL, each using the normalized `=d` form and the appropriate Photos bearer token. Never accept a bare URL or thumbnail rendition as an original fallback. If the original cannot be retrieved, fail with a useful retry/reselection state. Preserve authenticated Drive media downloads and existing external-source recovery as separate policies.

Google documents the download parameter, requires bearer authorization for Picker media URLs, and limits those URLs to about 60 minutes. A stored photo ID is therefore not a guarantee of later access; recovery must support reselection. See [Google Photos media retrieval](https://developers.google.com/photos/picker/guides/media-items).

Carry expected width and height from the selected media metadata through transfer requests. Decode downloaded bytes before upload; check actual dimensions and format against expected dimensions, accounting for EXIF orientation. Reject unexplained reductions. Where metadata is absent, require successful download-form retrieval and decodable bytes, record quality as unverified, and flag suspicious small sources for review rather than claiming original resolution. A legitimately small original must not fail solely because of a universal minimum size.

Verify HEIC support in the deployed image decoder. If the runtime cannot decode the returned original, report an explicit format failure or use a documented full-resolution conversion path; do not silently recover via previews. Use the decoded response format for uploads so a converted response is not labelled with the selected source's old MIME type.

## Prevent reuse of degraded imports

Introduce a source-quality version for Photos identity imports in the shared derivation-key policy. Update browser lookups and server lookups together. The TypeScript utility is the source of truth; its CommonJS counterpart is generated for functions. Audit all upload entry points, including `PhotoUploadManager`, photo history, Photos transforms and Gemini paths, before selecting the versioning boundary.

Do not accept a legacy cached Photos import as a verified original. Persist a quality version, expected and measured dimensions, source identity and content hash with new successful imports. Cache reuse must preserve those facts. Use a new repaired source Drive ID for downstream transformations so their derivations cannot resolve to the old source's results.

The existing `forceFunctionsPath` flag only skips the server's pre-work lookup. It does not address browser caches, and duplicate request IDs can still stop at the existing started/result events. Recovery needs new stable request IDs scoped to the repair and a deliberate quality version, with retries reusing those same repair IDs.

## Preserve source and edit lineage

Record the original Photos ID, source Drive file ID, parent edit ID, expected source dimensions, decoded dimensions, output dimensions, actual MIME type, content hash and quality policy version. Keep recoverable facts in durable completion events and the projections needed by subsequent edits. Avoid introducing credentials or fresh expiring media URLs into audit artifacts.

Treat original dimensions and transformed output dimensions separately: a deliberate crop can reduce dimensions without indicating a bad import. Retain the ordered edit chain and any manual crop geometry. Do not rerun a historical manual crop as today's automatic smart crop, or assume a newly executed AI edit will reproduce the selected image exactly.

## Test before release

- A bare URL would return a 512-pixel HTTP 200 preview, but is never used for a Photos original import.
- Refreshed `=d` failure tries the stored `=d`; failure of both never falls back to a preview or emits a successful upload.
- Dimension mismatch, rotated EXIF dimensions, a genuinely small original, missing metadata, invalid image bytes and HEIC/runtime format failures have explicit outcomes.
- A legacy cached low-resolution import cannot bypass quality validation in either browser or worker. A verified current-version cache entry remains reusable.
- Drive and external-source imports retain their intended behavior. Actual response MIME type survives upload and completion.
- Repair retries do not duplicate completed work, interrupted work can recover, and the selected edit order, gallery order and variant associations remain intact.

Use mocked network/image fixtures for worker tests and a focused browser test for selection, cache bypass and visible failures. Run one freshly selected original through import and the normal edit pipeline; compare decoded source dimensions and visually inspect the output before enabling broad recovery.

## Recover existing products in bounded batches

Build a dry-run manifest from the audit CSVs, refreshed against current product/image state. Retain the audit's confidence classes: 346 fully traced images, 163 linked through the same photo with incomplete edit history, and 31 small images with unverified origin. Do not automatically attribute or regenerate the latter group. Review the seven medium-resolution images and 59 larger images with thumbnail history separately.

Prioritize the 76 live, stocked products with degraded lead images in the October 26 snapshot. Start with JAN `4542804169317`, whose three images provide a concrete comparison, then proceed to other affected gallery images. Current stock, publication state and images may have changed since the snapshot; recheck them when building a batch.

For each image, capture current references and ordering, retrieve or reselect the original, validate the new Drive source, and replay only the reproducible intended edits. Incomplete manual lineage goes to visual review. Stage the replacement without disturbing the current published image, then compare it with the current version. Retain old Drive assets and a mapping from old references to replacements for rollback.

Inspect the Shopify sync replacement behavior before choosing the publication operation; verify preservation of variant image assignments, alt text, lead image and gallery order. Replace only successfully prepared images, detect concurrent product changes, and journal each completed replacement so an interrupted batch can resume. Retain a concrete rollback manifest without deleting the old assets during repair.

After publication, download the actual Shopify CDN master without sizing parameters, decode it and compare dimensions and visual detail with the prepared output. A filename containing `_s1600`, a successful upload response or a large upscaled image is not acceptance. Track repaired, awaiting reselection, awaiting edit review and failed rows separately.

## Delivery sequence

1. Commit downloader policy, decoded validation and regression coverage.
2. Commit quality-aware cache handling, request metadata and durable lineage across browser/server paths.
3. Release the import fix and verify a fresh original plus normal edits.
4. Implement manifest generation and a resumable recovery tool with a dry-run default and per-batch results.
5. Verify the three calendar images end to end, then recover priority batches and review uncertain cases separately.

The implementation can start with download correctness and tests. Bulk recovery depends on source access, reproducible edit history and verified Shopify replacement behavior.
