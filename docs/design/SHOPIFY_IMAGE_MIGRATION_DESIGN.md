# Design: Shopify CDN Image Migration

## Status

Proposed.

## Problem

After Shopify CSV/product import, state can contain `cdn.shopify.com` image URLs in two places:

- SKU-level inventory image fields
- Listing-level image galleries and variant image references

Current migration behavior is not fully backend-driven, not consistently idempotent by Shopify URL identity, and does not guarantee complete URL rewrite across all state surfaces.

## Required Outcome

1. Shopify image migration is executed by backend sync worker(s), not by browser copy loops.
2. Each Shopify CDN image is transferred to Drive at most once per unique source identity.
3. Source identity treats Shopify `v=` as part of uniqueness.
4. On transfer completion, reducers rewrite all matching Shopify URL references in state to the Drive URL.
5. After migration converges and actions are replayed, no `cdn.shopify.com` URLs remain in hydrated application state.
6. If the same Shopify URL is requested again later, system resolves to the existing Drive file via idempotency and rewrites to the same canonical Drive URL.

## Non-Goals

- Changing Shopify sync-to-store behavior.
- Redesigning listing image model.
- Backfilling historical Firestore documents outside normal action/replay flow.
- Modifying import acceptance behavior; import should continue ingesting raw Shopify URLs and migration remains a separate user-triggered step.

## Existing Gaps

- Migration scan is inventory-item-image-centric and can miss listing-only Shopify URLs.
- Existing Shopify->Drive map persistence is inconsistent with `lh3.googleusercontent.com/d/...` output shape.
- Batch import conflict logic does not reliably consume Shopify->Drive equivalence data.
- URL transfer idempotency is not enforced end-to-end in the worker path for Shopify CDN sources.

## Proposed Architecture

### 1. Reuse `sync` queue with backend transfer worker

Use the same sync event architecture already used by Photos transfer.

Recommended: reuse existing `photos/image_transfer_requested` worker contract with an explicit external source type (`shopify_cdn`) and URL source payload.

Event lifecycle:

- `photos/image_transfer_requested`
- `photos/image_transfer_started`
- `photos/image_transfer_completed`
- `photos/image_transfer_failed`

Each request includes:

- `requestId`
- `source.type = "shopify_cdn"`
- `source.url` (raw picker/import URL)
- optional correlation fields (`listingId`, `itemKey`, `origin`) for debugging only

### 2. Idempotency identity for Shopify CDN sources

For Shopify CDN transfers, derive identity from a canonical Shopify URL fingerprint.

Canonicalization rules:

- Keep scheme + host + path.
- Keep query param `v` (required for uniqueness semantics).
- Drop fragment.
- Drop non-semantic/volatile query params if present (for example tracking params).
- Sort retained query params deterministically.

Source ID:

- `sha256(canonicalShopifyUrl)`

Derivation key:

- `shopify:<sha256(canonicalShopifyUrl)>:identity`

Worker behavior:

1. Build derivation key from canonical URL.
2. `findFileByDerivationKey` before any download/upload.
3. If found, emit `...completed` with existing Drive file info (idempotent hit).
4. If not found, fetch source URL, upload with same derivation key, emit `...completed`.

This exactly matches the Photos model: request can be repeated safely; resolver returns same Drive target.

### 3. Reducer-side rewrite on completion

On `photos/image_transfer_completed` for `source.type = shopify_cdn`:

- rewrite all exact matches of source canonical Shopify URL to Drive URL across:
  - inventory SKU `image`
  - listing gallery image URLs
  - listing variant image URLs
  - any other normalized listing image structures used by sync payload generation

Rewrite invariants:

- deterministic and idempotent (safe on replay)
- no `Date.now()` inside reducers
- no partial source-specific state updates outside reducer path

Note on map removal:

- Do not depend on `inventory.shopifyUrlToDriveUrl` for migration correctness.
- Plan to remove that map from state and conflict logic; migration correctness must come from replayed completion events and canonical URL rewrite.

### 4. Migration command flow

After Shopify import, user triggers "Migrate Shopify Images".

Client action:

1. Scan current state for all distinct Shopify CDN URLs from inventory + listings.
2. Canonicalize URLs.
3. Enqueue one backend transfer request per canonical URL.
4. Drive progress UI from sync events.

Result: migration is complete when unresolved Shopify URL set becomes empty.

### 5. Failure and retry behavior

- Failed transfers should not permanently poison URL state.
- Retries should re-enqueue same canonical URL; worker idempotency guarantees no duplicate copies on eventual success.
- Optional retry policy: bounded client retries with backoff; terminal failures remain retryable by user action.

## Data Contract (Proposed)

Completed event payload fields (minimum):

- `source.type = "shopify_cdn"`
- `source.urlRaw`
- `source.urlCanonical`
- `derivationKey`
- `drive.fileId`
- `drive.publicUrl`
- `idempotent` (boolean; true if resolved from existing file)

Failed event payload fields (minimum):

- `source.type = "shopify_cdn"`
- `source.urlRaw`
- `source.urlCanonical` (if parseable)
- `error.code`
- `error.message`
- `retryable`

## Correctness Guarantees

1. Same canonical Shopify URL always resolves to same Drive file target.
2. Completion events eventually eliminate matching Shopify URLs from active state.
3. Replaying event log yields identical rewritten state.
4. Re-running migration after convergence is safe; worker idempotency resolves repeats to existing Drive files.

## Testing Plan

1. Unit: canonicalization preserves `v=` and normalizes ordering.
2. Unit: reducer completion rewrites SKU + listing + variant image URLs in one pass.
3. Unit: mapping insertion and replay idempotency (duplicate completed events).
4. Integration: enqueue same Shopify URL twice -> one Drive file, two successful completions with same file ID.
5. Integration: mixed set of Shopify + existing Drive URLs -> only Shopify URLs enqueue.
6. Integration: listing-only Shopify URLs migrate correctly without SKU mirror.

## Rollout Plan

1. Deploy worker support for `shopify_cdn` source in transfer events.
2. Deploy reducer rewrite across inventory + listing URL surfaces.
3. Update migration UI to enqueue backend requests from both inventory and listing surfaces.
4. Run on staging with representative import including listing-only images and repeated URLs.
5. Promote to production.

## Open Questions

1. Should canonicalization retain any query param beyond `v` for Shopify CDN URLs seen in practice?
2. Do we want a separate map namespace for non-Shopify external URLs, or keep Shopify-specific map for now?
3. Should reducer rewrite search only exact canonical matches, or also normalize legacy equivalent forms before comparison?
