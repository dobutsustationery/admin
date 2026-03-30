# Shopify Catalog Deep Diff Design

> **Status: Implemented on branch**  
> Scope: replay-backed Shopify shadow catalog, incremental sync, deep diff badges, and handle-specific diff inspection.

## 1. Problem

The earlier `/shopify-listings` implementation was an MVP presence audit:

- it fetched handle presence from Shopify
- it compared handle existence against local listings
- it added a timestamp drift view

That was useful for detecting missing or stale listings, but it did not solve the higher-value workflow:

- persist Shopify catalog state in replayable app state
- avoid re-syncing all Shopify data every time the page loads
- support a real deep diff against our internal listing model
- let an operator inspect what differs for a given handle

We now want Shopify listing state to behave like a first-class shadow model in the app, not a transient audit response.

## 2. Goals

- Persist Shopify listing state in Redux via replayed `broadcast` actions.
- Sync Shopify listings incrementally using Shopify modified timestamps.
- Reuse the synced Shopify shadow state from `/shopify-listings` rather than performing a full audit on every page load.
- Compute a normalized deep diff between internal listing state and Shopify state.
- Show a `deep diff` badge in the listings table for mismatched rows.
- Provide a handle-specific diff page that shows the mismatched fields side by side.

## 3. Non-goals

- Full bidirectional reconciliation.
- Automatic local repair from Shopify data.
- Precise deletion handling during incremental sync.
- Historical snapshotting of Shopify catalog states.

Deletion reconciliation is intentionally left to manual full refresh in the current design.

## 4. Summary Of Implemented Approach

The implemented model is:

1. A new Shopify shadow catalog slice in Redux stores normalized Shopify product/listing data plus sync cursor metadata.
2. A new Firestore request collection, `request_shopify_catalog_sync`, triggers a backend catalog sync worker.
3. The backend fetches Shopify products using GraphQL, either:
   - full sync when we have no baseline or when the operator requests it
   - incremental sync using the stored `maxUpdatedAtMs`
4. The backend writes chunked replay actions into `broadcast`:
   - `shopifyCatalog/begin_sync`
   - `shopifyCatalog/apply_sync_chunk`
   - `shopifyCatalog/complete_sync`
   - `shopifyCatalog/fail_sync`
5. The frontend reducer replays those actions into `state.shopifyCatalog`.
6. `/shopify-listings` reads that replayed state, computes deep diffs against local data, and renders status badges.
7. `/shopify-listings/diff?handle=...` shows the normalized local and Shopify values for mismatched fields.

This makes Shopify listing state durable, replayable, and inspectable.

## 5. Architecture

### 5.1 Frontend State

New slice:

- [`src/lib/shopify-catalog-slice.ts`](/Users/anicolao/projects/antigravity/admin2/src/lib/shopify-catalog-slice.ts)

Reducer is registered in:

- [`src/lib/root-reducer.ts`](/Users/anicolao/projects/antigravity/admin2/src/lib/root-reducer.ts)

The slice stores:

```ts
interface ShopifyCatalogState {
  handleToListing: Record<string, ShopifyCatalogListing>;
  maxUpdatedAtMs: number;
  lastSyncMode: "" | "full" | "incremental";
  lastSyncRequestedAtMs: number;
  lastSyncCompletedAtMs: number;
  lastSyncFailedAtMs: number;
  lastSyncError: string;
  lastAppliedRequestId: string;
  lastFailedRequestId: string;
  hasCompletedFullSync: boolean;
  activeRequestId: string;
  stagingHandleToListing: Record<string, ShopifyCatalogListing> | null;
  stagingRequestId: string;
}
```

Key behavior:

- Incremental syncs upsert directly into `handleToListing`.
- Full syncs stage into `stagingHandleToListing` and replace the live catalog only on `complete_sync`.
- This avoids leaving the catalog half-cleared if a full sync fails midway.

### 5.2 Backend Trigger

New request collection constant:

- [`src/lib/sync-events.ts`](/Users/anicolao/projects/antigravity/admin2/src/lib/sync-events.ts)

New Cloud Function:

- [`functions/index.js`](/Users/anicolao/projects/antigravity/admin2/functions/index.js)

Request collection:

- `request_shopify_catalog_sync`

Request shape:

```ts
{
  eventType: "shopify/catalog_sync_requested",
  creator: string,
  requestedBy: string,
  source: "shopify-listings-page",
  forceFull: boolean,
  sinceUpdatedAtMs: number,
  createdAtMs: number,
}
```

### 5.3 Replay Path

Unlike the older listing audit approach, the new catalog sync does not store the useful result only in `sync`.

It writes replay actions to:

- `broadcast`

This matters because:

- `broadcast` is the app’s authoritative replay stream
- replayed actions survive reloads and hydration
- the Shopify shadow model becomes part of app state instead of page-local state

### 5.4 UI Routes

Listing overview:

- [`src/routes/shopify-listings/+page.svelte`](/Users/anicolao/projects/antigravity/admin2/src/routes/shopify-listings/+page.svelte)

Handle diff inspection:

- [`src/routes/shopify-listings/diff/+page.svelte`](/Users/anicolao/projects/antigravity/admin2/src/routes/shopify-listings/diff/+page.svelte)

## 6. Shopify Shadow Model

The shadow model intentionally does not store Shopify’s raw GraphQL shape.

Instead it stores a normalized listing-like representation:

```ts
interface ShopifyCatalogListing {
  productId: string;
  handle: string;
  title: string;
  bodyHtml: string;
  vendor: string;
  productType: string;
  productCategory: string;
  tags: string[];
  status: "active" | "archived" | "draft";
  option1Name: string;
  updatedAtIso: string;
  updatedAtMs: number;
  images: ShopifyCatalogImage[];
  variants: ShopifyCatalogVariant[];
}
```

This was a deliberate design choice.

Reasons:

- The diff should compare “what we care about operationally,” not arbitrary Shopify response details.
- The compare surface should match the fields we already push outbound during listing sync.
- A normalized model makes diffs more stable and easier to explain to humans.

## 7. Incremental Sync Design

### 7.1 Cursor

The cursor is:

- `shopifyCatalog.maxUpdatedAtMs`

The page sends that cursor with the next request unless a full refresh is requested.

### 7.2 Query Strategy

The backend uses Shopify GraphQL `products(...)` ordered by `UPDATED_AT`, and applies a query filter derived from the cursor:

```ts
updated_at:>='ISO_TIMESTAMP'
```

The implementation subtracts a small overlap from the stored cursor before querying. This intentionally tolerates edge races around the latest modified timestamp.

### 7.3 Full Sync vs Incremental Sync

Full sync:

- used on first load when no completed full sync exists
- used when the operator clicks `Full Refresh`
- stages results, then replaces the catalog atomically on completion

Incremental sync:

- used after a full sync baseline exists
- fetches only products newer than the stored cursor
- upserts returned listings into the current catalog

### 7.4 Deletions

Incremental sync cannot reliably detect Shopify deletions from `updatedAt` alone.

Current handling:

- incremental syncs detect creates and updates
- manual `Full Refresh` reconciles deletions

This is intentional and explicitly surfaced in the page copy.

## 8. Backend Data Fetch And Normalization

The backend currently fetches:

- product handle, title, description HTML, vendor, product type, status, tags, category
- product options
- product images
- variants including SKU, barcode, price, inventory quantity, selected options, image, weight

Normalization logic lives in:

- [`functions/index.js`](/Users/anicolao/projects/antigravity/admin2/functions/index.js)

Key normalization choices:

- `updatedAt` becomes both `updatedAtIso` and `updatedAtMs`
- product category comes from Shopify `category.fullName`
- option name comes from the first product option
- image arrays are stored in a predictable order
- variant subtype comes from selected option value first, then variant title fallback
- weight is normalized to grams

## 9. Why Chunked Broadcast Actions

A full Shopify catalog can be too large for a single Firestore document.

To avoid oversized `broadcast` actions, the backend chunks the catalog into multiple `apply_sync_chunk` actions.

Current action sequence:

1. `shopifyCatalog/begin_sync`
2. one or more `shopifyCatalog/apply_sync_chunk`
3. `shopifyCatalog/complete_sync`

On error:

1. `shopifyCatalog/begin_sync`
2. maybe some chunks
3. `shopifyCatalog/fail_sync`

This keeps replay safe and scales better than a single giant payload.

## 10. Deep Diff Design

Diff logic lives in:

- [`src/lib/shopify-deep-diff.ts`](/Users/anicolao/projects/antigravity/admin2/src/lib/shopify-deep-diff.ts)

The compare is not raw-object equality.

Instead both sides are canonicalized into:

```ts
interface ComparableShopifyListing {
  handle: string;
  title: string;
  bodyHtml: string;
  vendor: string;
  productType: string;
  productCategory: string;
  tags: string[];
  status: "active" | "archived" | "draft";
  option1Name: string;
  galleryImages: ComparableImage[];
  variants: ComparableVariant[];
}
```

### 10.1 Local Side

Local comparable data is built from:

- listing data from `state.listings.handleToListing[handle]`
- inventory items associated to the listing via `state.listings.idToHandle`

The compare uses inventory-backed variant values:

- generated SKU
- subtype
- price
- JAN code
- weight
- inventory quantity
- variant image

### 10.2 Shopify Side

Shopify comparable data is built from the shadow listing.

Normalization includes:

- lower-cased/sorted tags
- stable variant ordering by SKU
- gallery images excluding images already claimed by variants
- special handling for the single-default-variant case

### 10.3 Compared Fields

Current mismatch keys:

- `handle`
- `title`
- `bodyHtml`
- `vendor`
- `productType`
- `productCategory`
- `status`
- `option1Name`
- `tags`
- `galleryImages`
- `variants`

This compare surface is intentionally explicit.

## 11. UI Behavior

### 11.1 `/shopify-listings`

The main listings page now:

- requests an initial full sync if no baseline exists
- requests incremental sync thereafter
- allows manual full refresh
- shows:
  - `admin_only`
  - `shopify_only`
  - `admin_ahead`
  - `shopify_ahead`
  - `deep diff`
  - `synced`

For rows present on both sides, the page computes:

- timestamp drift classification
- deep diff mismatch keys

If a row has mismatches, the mismatch badge links to the diff page.

### 11.2 `/shopify-listings/diff`

The diff page:

- loads a handle from the query string
- builds normalized local and normalized Shopify records
- computes mismatch keys
- shows mismatched fields side by side
- also exposes the full normalized objects and raw records for debugging

Image-bearing values render with thumbnails and hover previews through the shared JSON tree component.

## 12. Firebase Rules

The new request collection required a Firestore rule:

- `request_shopify_catalog_sync`

Rule was added in:

- [`firestore.rules`](/Users/anicolao/projects/antigravity/admin2/firestore.rules)

Without that rule, the page could create no sync requests.

## 13. Tests And Verification

New focused tests:

- [`tests/unit/shopify-catalog-slice.test.ts`](/Users/anicolao/projects/antigravity/admin2/tests/unit/shopify-catalog-slice.test.ts)
- [`tests/unit/shopify-deep-diff.test.ts`](/Users/anicolao/projects/antigravity/admin2/tests/unit/shopify-deep-diff.test.ts)

Validated during implementation with:

- `vitest` for new slice and diff logic
- `svelte-check` for UI integration
- `node --check functions/index.js` for backend syntax

## 14. Known Problems In Current Diff Behavior

Two false-diff sources remain.

### 14.1 HTML Diff Noise

Problem:

- our local listing stores authored `bodyHtml`
- Shopify may normalize HTML on write or read
- examples include entity normalization like `&nbsp;` collapsing or disappearing

Result:

- semantically equivalent HTML can still diff as raw string mismatch

### 14.2 Image URL Diff Noise

Problem:

- local listing/image state often contains Drive-backed URLs or normalized Drive identities
- after sync, Shopify rewrites image identity to Shopify CDN URLs

Result:

- the image content can be the same, but URLs do not match

## 15. Suggested Solution Approaches

### 15.1 HTML Diff Solution Options

#### Option A: Canonical HTML Normalization Before Compare

Preferred first step.

Approach:

- normalize both local and Shopify HTML before diff
- parse into a DOM/AST
- decode HTML entities
- normalize whitespace
- normalize non-breaking spaces
- remove purely representational serialization differences
- re-serialize in a stable canonical format

Effect:

- `&nbsp;`, encoded entities, and minor serialization differences stop creating false diffs

Benefits:

- keeps authored HTML intact in stored state
- limits the fix to compare-time semantics
- easy to reason about as a diff-layer normalization rule

Risks:

- if the canonicalizer is too aggressive, it can hide real meaningful markup differences

Recommended compare behavior:

- compare `canonicalBodyHtml(local)` vs `canonicalBodyHtml(shopify)`

#### Option B: Store A Separate Sync Fingerprint

Approach:

- when we sync outbound, compute and persist a canonical body HTML fingerprint for the payload we sent
- compare Shopify HTML against that canonical fingerprint rather than raw local text

Benefits:

- better reflects “did Shopify preserve what we meant”

Risks:

- more state and complexity
- fingerprints can become stale if local content changes without resync

#### Option C: Ignore `bodyHtml` In Deep Diff

This is not recommended except as a temporary emergency valve.

Reason:

- it suppresses a real and important sync surface

### 15.2 Image Diff Solution Options

#### Option A: Canonical Image Identity Map

Preferred direction.

Approach:

- compare images by stable content identity rather than raw URL
- define a normalization layer that maps:
  - Drive URLs
  - `drive:<fileId>`
  - Shopify CDN URLs
    into a shared comparable identity

The cleanest way to do this is to persist image provenance in the Shopify shadow state during or after sync.

Potential identities:

- original Drive file id
- explicit sync provenance object
- hash of source image content

Benefits:

- resolves the real problem instead of hiding it
- lets the diff say “same image, different hosting URL”

Risks:

- requires a trustworthy source of cross-host image identity

#### Option B: Persist Sync-Time Image Mapping

Strong practical candidate.

Approach:

- when syncing images to Shopify, record a mapping from local source identity to Shopify CDN URL
- store this in replayed state or another durable mapping structure
- during deep diff, canonicalize both sides through that mapping

Example model:

```ts
interface ShopifyImageProvenance {
  localImageKey: string; // drive:<fileId> or other canonical local key
  shopifyImageUrl: string; // CDN URL
  handle: string;
  variantSku?: string;
}
```

Benefits:

- leverages information we already know at sync time
- avoids reverse-engineering image identity from URLs alone

Risks:

- requires plumbing provenance through sync completion paths
- older listings synced before provenance capture would still need fallback behavior

#### Option C: Compare Images By Position + Alt + Count Only

Temporary mitigation only.

Approach:

- when one side is Drive-backed and the other is Shopify CDN-backed, ignore raw URL equality and compare only:
  - image count
  - order/position
  - alt text

Benefits:

- quick to implement

Risks:

- can hide genuinely wrong images if the wrong asset is present at the same position

This should not be the final solution.

## 16. Recommended Follow-up Plan

### Phase 1

Reduce false diffs without expanding state too much.

- Add compare-time canonical HTML normalization.
- Add a narrower image normalization heuristic:
  - Drive URLs collapse to `drive:<fileId>`
  - Shopify CDN URLs remain CDN URLs
  - continue showing image mismatch when identities are truly unknown

### Phase 2

Make image diff identity explicit.

- Capture image provenance during outbound Shopify sync.
- Persist mapping from local image identity to resulting Shopify CDN identity.
- Update deep diff to compare canonical provenance keys instead of raw URLs.

### Phase 3

Optional refinement.

- Add field-level “normalized equal but raw different” annotations in the diff UI
- for example:
  - `bodyHtml`: equal after normalization
  - `images`: equal by provenance mapping

That would let operators distinguish:

- true mismatch
- representation-only mismatch

## 17. Tradeoff Summary

Why this design is still the right base:

- replayable state is a major improvement over transient audits
- incremental sync avoids unnecessary full fetches
- deep diff is explicit and inspectable
- the remaining false diffs are localized normalization problems, not architectural flaws

The current branch solves the hard structural problem first:

- model Shopify as durable app state
- sync it incrementally
- diff it in a defined compare layer

The remaining work is to make the compare layer more semantic for HTML and images.
