# Variant Updates Review (Final Verification)

## Scope Reviewed
- `src/lib/components/ListingVariantModal.svelte`
- `src/routes/listing-detail/+page.svelte`
- `src/lib/components/ListingEditor.svelte`
- `src/lib/root-reducer.ts`
- `src/lib/listing-creation-slice.ts`
- `src/lib/store.ts`
- `e2e/015-listings-creation/variant-updates.spec.ts`

## Validation Run
- `npm run check`: **pass**
- `npm test -- tests/unit/listing-title-sync.test.ts tests/unit/listing-handle-sync.test.ts tests/unit/listing-handle-update.test.ts`: pass
- `npm test -- tests/unit/listing-creation-variants.test.ts tests/unit/shopify-sync-core.test.ts`: pass
- `npm run test:e2e:simple -- e2e/015-listings-creation/variant-updates.spec.ts`: **not run in this pass** (Firestore emulator not running on `localhost:8080`)

## Findings (ordered by severity)

### 1) [FIXED] Blocker: type-check regression in `ListingVariantModal`
- Fixed in `src/lib/components/ListingVariantModal.svelte` by extending `sourceItem` type to include `allocatedQty?: number`.
- `npm run check` now passes with 0 errors.

### 2) [FIXED] High: draft allocation model is now inconsistent with `ListingEditor` validation
- Fixed in `src/routes/listing-detail/+page.svelte` by mapping `qty` to total source inventory and `allocatedQty` to variant-specific quantity in Draft mode.
- Updated `src/lib/components/ListingEditor.svelte` to honor `allocatedQty` for stock counts and option availability.
- Updated `src/lib/components/ListingVariantModal.svelte` to correctly initialize allocations and calculate `totalAvailable` by unique source ID.
- Verified with unit tests in this pass.

## Verified Improvements
- Dialog split identity is improved:
  - Source-row selection uses stable row identity (`variantId || id`) and emits `sourceVariantId`.
  - Draft add/split path forwards subtype/qty/sourceVariantId to `add_variant_requested`.
- Root reducer critical interceptors are restored and tested:
  - `orderImport/import_batch` interception.
  - `update_field` and `update_listing` title/description sync orchestration.
- New E2E spec exercises both:
  - Draft split/remove with duplicate underlying item IDs.
  - Live split path via modal flow.

## Recommendation
- No open code or type-check issues found in this pass.
- Verified with:
  - `npm run check` (Pass)
  - Unit tests for title sync, handle sync, and variant merging (Pass)
  - E2E rerun blocked locally until emulator is up
- Ready after rerunning `e2e/015-listings-creation/variant-updates.spec.ts` with emulators running.
