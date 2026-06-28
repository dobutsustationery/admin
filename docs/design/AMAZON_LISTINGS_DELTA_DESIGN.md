# Amazon Listings Delta Design

> **Status: Draft**
> **Scope:** Build an Amazon equivalent of `/shopify-listings` that compares the admin system's intended Amazon state against the observed Amazon/SP-API state.
> **First milestone:** Read-only audit. No listing writes, no inventory writes, no order sync.

## 1. Problem

We do not yet have a working Amazon listing sync. We may have at least one product that appears in Amazon search, but that does not mean we have a seller listing in a usable, buyable, or correctly attributed state.

Before we create or repair Amazon listings, we need a screen that answers:

- Which local listings are intended to exist on Amazon?
- Which of those have a matching Amazon catalog item or seller listing?
- Which Amazon-side records exist but do not correspond cleanly to admin listings?
- What would we change if we later implemented an admin-to-Amazon sync?
- Which cases are blocked by missing ASIN, product type, category, image, price, inventory, or listing issue data?

This should be much closer to the current Shopify Listings delta workflow than to order sync.

## 2. Current Repository Context

There is no Amazon-specific design or implementation in the repository as of this draft.

Relevant existing patterns:

- `docs/design/SHOPIFY_CATALOG_DEEP_DIFF_DESIGN.md`
- `docs/design/SHOPIFY_LISTING_SYNC_AUDIT_DESIGN.md`
- `src/routes/shopify-listings/+page.svelte`
- `src/lib/shopify-catalog-slice.ts`
- `src/lib/shopify-listing-projection.ts`
- `functions/shared/sync-dispatcher.cjs`

The Amazon design should reuse the same system principles:

- External API fetches write replayable facts or replayable shadow-state chunks.
- UI diffs are computed from Redux state, not from ephemeral route-local API calls.
- Writes to external marketplaces are explicit sync requests, not side effects of local edits.
- Computed values should not be persisted as user intent.

## 3. Current Amazon API Research

Official Amazon SP-API documentation points to four relevant surfaces.

### 3.1 Listings Items API

The Listings Items API gives programmatic access to seller listings on Amazon. Amazon says it should be used with Product Type Definitions because product type requirements drive valid listing payloads.

Useful operations:

- `searchListingsItems`: enumerate seller listings for a seller and marketplace.
- `getListingsItem`: retrieve one seller listing by seller SKU.
- `putListingsItem`: create or fully update one seller listing.
- `patchListingsItem`: partially update one seller listing.
- `deleteListingsItem`: delete one seller listing.

For read-only audit, `searchListingsItems` and `getListingsItem` matter first.

Important fields/datasets:

- `summaries`
- `attributes`
- `issues`
- `offers`
- `fulfillmentAvailability`
- `relationships`
- `productTypes`

These let us ask whether the seller listing exists, is buyable/discoverable, has issues, has price/offer data, has inventory availability, and participates in variations.

### 3.2 Catalog Items API

The Catalog Items API is for Amazon catalog discovery. It can search by product identifiers such as EAN/JAN/UPC/ASIN, or by keywords. This is not the same thing as seller listing state.

For our use case:

- Search by JAN/EAN to identify possible ASINs.
- Detect ambiguous catalog matches.
- Detect "catalog exists but seller listing missing."
- Pull image/title/product type signals for comparison.

This matters because "shows up in Amazon search" may mean an Amazon catalog item exists even if our seller listing is missing or inactive.

### 3.3 Product Type Definitions API

Product Type Definitions returns the JSON schema and requirements for a product type in a marketplace.

This should not be step one for the UI, but it is required before safe writes because Amazon listing payloads are product-type-specific and have conditional requirements.

The audit screen should surface product type gaps so that a later sync implementation can decide whether an item is actionable.

### 3.4 Feeds API / `JSON_LISTINGS_FEED`

Amazon describes `JSON_LISTINGS_FEED` as the bulk equivalent of the Listings Items API. It uses the same product type definition model.

This is not the first implementation target. It becomes relevant when we have a proven projection and want bulk writes.

Important current constraint: Amazon says legacy XML and flat-file listing feeds, including pricing, inventory, relationships, and images, are no longer supported by Feeds API as of July 31, 2025. Any future bulk implementation should be JSON listings feed only.

### 3.5 Authorization

For a private seller app, use SP-API self-authorization to obtain an LWA refresh token for the seller account. SP-API calls use a Login with Amazon access token derived from the refresh token.

Amazon announced that SP-API no longer requires AWS IAM or AWS Signature Version 4 as of October 2, 2023. We should not build new code that assumes SigV4 is required.

## 4. Design Principle: Compare Projections, Not Raw APIs

The route should not compare local listings directly to raw Amazon response objects.

Instead:

1. Build an admin-to-Amazon projection from local listing state.
2. Build an observed Amazon projection from SP-API responses.
3. Diff those two projections.

This mirrors where `/shopify-listings` has ended up: "If we synced admin -> marketplace now, would we make edits?"

## 5. Proposed Local Projection

The local Amazon projection should be deliberately smaller than the Shopify projection until we understand Amazon's requirements.

Draft shape:

```ts
type AmazonProjectedListing = {
  localHandle: string;
  localListingId: string;
  intendedAmazonStatus: "active" | "draft" | "no_sync";
  title: string;
  description: string;
  brand: string;
  bulletPoints: string[];
  mainImage: string;
  otherImages: string[];
  productType: string;
  recommendedBrowseNodes: string[];
  variants: AmazonProjectedVariant[];
};

type AmazonProjectedVariant = {
  itemKey: string;
  jan: string;
  subtype: string;
  sku: string;
  asin?: string;
  priceEur: number;
  quantityAvailable: number;
  conditionType: "new_new";
  optionLabel?: string;
};
```

Open choices:

- SKU format: use existing item key, or introduce Amazon-specific SKU aliases.
- Currency: Amazon marketplace for Ireland/Europe likely uses EUR, but marketplace IDs must decide exact behavior.
- Product type: infer from local category only if we have a reliable mapping; otherwise mark missing.
- Browse node/category: do not invent mappings silently.

## 6. Proposed Amazon Shadow State

Add a replayed Amazon shadow slice similar to `shopifyCatalog`.

Draft state:

```ts
type AmazonCatalogState = {
  marketplaceId: string;
  sellerId: string;
  skuToListing: Record<string, AmazonObservedListing>;
  janToCatalogMatches: Record<string, AmazonCatalogMatch[]>;
  lastSyncMode: "" | "full" | "sample" | "jan_probe";
  lastSyncRequestedAtMs: number;
  lastSyncCompletedAtMs: number;
  lastSyncFailedAtMs: number;
  lastSyncError: string;
  activeRequestId: string;
  hasCompletedFullSync: boolean;
};
```

Observed listing shape:

```ts
type AmazonObservedListing = {
  sku: string;
  asin: string;
  marketplaceId: string;
  summaries: unknown[];
  attributes: Record<string, unknown>;
  issues: AmazonListingIssue[];
  offers: unknown[];
  fulfillmentAvailability: unknown[];
  relationships: unknown[];
  productTypes: string[];
  fetchedAtMs: number;
};
```

For v1, raw-ish datasets can be preserved inside the observed shape. The normalized diff layer can use selected fields and ignore the rest.

## 7. Replay Actions

Do not write Amazon sync results only to the `sync` collection. The useful result needs to be replayable from `broadcast`.

Proposed request collection:

- `request_amazon_catalog_sync`

Proposed sync event namespace:

- `amazon/sync_requested`
- `amazon/sync_claimed`
- `amazon/sync_api_call`
- `amazon/sync_completed`
- `amazon/sync_failed`

Proposed replay actions:

```ts
amazonCatalog / begin_sync;
amazonCatalog / apply_listing_chunk;
amazonCatalog / apply_catalog_match_chunk;
amazonCatalog / complete_sync;
amazonCatalog / fail_sync;
```

Request shape:

```ts
{
  eventType: "amazon/sync_requested",
  requestId: string,
  requestType: "listings_delta",
  requestedBy: string,
  source: "amazon-listings-page",
  marketplaceId: string,
  mode: "sample" | "full" | "jan_probe",
  janCodes?: string[],
  skus?: string[],
  createdAtMs: number
}
```

## 8. API Read Strategy

### 8.1 Baby Step: JAN Probe

Start with a small read-only probe for selected local listings/JANs:

1. For each JAN, call Catalog Items `searchCatalogItems` with identifier type JAN/EAN as appropriate.
2. Store all ASIN matches, product types, summaries, images, relationships.
3. For candidate local SKUs, call Listings Items `getListingsItem`.
4. Store seller listing state if present; record 404/missing otherwise.
5. Render delta rows.

This directly addresses the current uncertainty: "we have a listing visible in Amazon search, but no working listing."

### 8.2 Later: Seller Listing Search

Once credentials and schema are proven:

1. Call `searchListingsItems` for the seller and marketplace.
2. Include `summaries,attributes,issues,offers,fulfillmentAvailability,relationships,productTypes`.
3. Page through results if available.
4. Store chunks into replayed Amazon shadow state.

This should become the Amazon equivalent of the Shopify shadow catalog.

### 8.3 Later: Product Type Definition Cache

For product types observed in catalog/listings:

1. Fetch Product Type Definitions.
2. Cache schemas/checksums by marketplace and product type.
3. Use them for validation/diff only at first.
4. Use them for writes only after the projection is stable.

## 9. Delta Classifications

The `/amazon-listings` route should group exceptions rather than dumping one giant table.

Proposed groups:

- `No Sync`: local listing is marked `no_sync`; no Amazon listing expected.
- `Local Only`: local listing is intended for Amazon but no catalog match and no seller listing found.
- `Catalog Match Only`: Amazon catalog ASIN exists for the JAN, but seller listing is missing or inactive.
- `Amazon Only`: seller listing exists but no local listing/item maps to its SKU/JAN.
- `Ambiguous Catalog Match`: a JAN maps to multiple plausible ASINs.
- `Seller Listing Issue`: Amazon reports listing issues.
- `Not Buyable`: seller listing exists but not buyable/discoverable, or has no fulfillment availability.
- `Offer Difference`: projected price differs from Amazon offer.
- `Inventory Difference`: projected available stock differs from Amazon fulfillment availability.
- `Image Difference`: projected image set differs from observed Amazon image/catalog state.
- `Product Data Difference`: title, brand, bullets, description, product type, or browse node differs.
- `Variation Difference`: local variants and Amazon relationships/options do not align.

Rows should include:

- local image thumbnail
- local handle/listing link
- JAN
- subtype
- projected SKU
- observed SKU
- ASIN
- issue summary
- suggested next action

## 10. UI Proposal

Add route:

- `/amazon-listings`

Initial controls:

- Marketplace selector, default from environment/config.
- "Probe selected JANs" input.
- "Run sample audit" button.
- Later: "Full refresh" button.

Initial tables:

- Summary counts by classification.
- Per-classification collapsible tables, default collapsed.
- Row detail expands to show:
  - local projection JSON subset
  - observed Amazon projection JSON subset
  - raw issue messages
  - links to local listing and item history

No sync buttons in v1.

## 11. Why Not Write Listings First?

Amazon listing writes are more constrained than Shopify listing writes:

- Listing payloads depend on product type definitions.
- Accepted submissions can still fail asynchronously.
- Catalog identity and seller listing state are separate concepts.
- Variations/relationships need explicit modeling.
- Bulk writes now require `JSON_LISTINGS_FEED`, not legacy feeds.

The cheapest safe first step is to establish a read-only observed Amazon shadow state and use it to understand the mismatch surface.

## 12. Implementation Plan

### Phase 1: Design And Credentials Probe

1. Confirm Amazon seller account, marketplace ID, seller ID, LWA client ID/secret, and refresh token.
2. Add a local script that exchanges refresh token for LWA access token.
3. Add a read-only script that searches Catalog Items by JAN and prints compact results.
4. Do not write Firestore yet.

### Phase 2: Replayable Read-Only Shadow State

1. Add `amazonCatalog` Redux slice.
2. Add `request_amazon_catalog_sync`.
3. Add backend worker path in `sync-dispatcher.cjs`.
4. Write replay actions into `broadcast`.
5. Add tests for chunk replay and idempotent request folding.

### Phase 3: `/amazon-listings`

1. Build local Amazon projection from current listings/items.
2. Build observed Amazon projection from `amazonCatalog`.
3. Render grouped deltas.
4. Add copy/export for tables.

### Phase 4: Validation Preview

1. Use Product Type Definitions for likely product types.
2. Add local validation of projected payloads.
3. Optionally call Listings Items validation preview for selected rows.
4. Surface validation issues without persisting any listing writes.

### Phase 5: Controlled Writes

Only after phases 1-4:

1. Add single-SKU sync request.
2. Use Listings Items `patchListingsItem` or `putListingsItem` for one listing at a time.
3. Record raw accepted/invalid response facts.
4. Re-read listing after write to capture asynchronous issue state.
5. Consider `JSON_LISTINGS_FEED` only for bulk operations after single-SKU writes are proven.

## 13. First Baby Step

The first implementation step is:

> Add a read-only `scripts/amazon-catalog-probe.ts` that accepts one or more JAN codes, calls Catalog Items search by identifier, and prints ASIN/title/product type/image/relationship summaries without writing Firestore.

This is intentionally smaller than `/amazon-listings`.

It proves:

- credentials
- marketplace ID
- identifier type for our JANs
- whether the search-visible item is catalog-only or seller-listing-backed
- which fields Amazon returns for our stationery/catalog cases

Once that works, the next step is to make those probe results replayable in `broadcast`.

### 13.1 Local Probe Usage

Required credentials:

```sh
AMAZON_LWA_CLIENT_ID=...
AMAZON_LWA_CLIENT_SECRET=...
AMAZON_LWA_REFRESH_TOKEN=...
AMAZON_MARKETPLACE_ID=...
```

Aliases also accepted:

```sh
AMAZON_SP_API_CLIENT_ID=...
AMAZON_SP_API_CLIENT_SECRET=...
AMAZON_SP_API_REFRESH_TOKEN=...
AMAZON_SP_API_MARKETPLACE_ID=...
```

Run:

```sh
npm run amazon:catalog:probe -- --env-file .env.amazon --jan 4542804151626
```

Useful options:

```sh
npm run amazon:catalog:probe -- --env-file .env.amazon --check-token
npm run amazon:catalog:probe -- --env-file .env.amazon --jan-file /tmp/jans.txt
npm run amazon:catalog:probe -- --env-file .env.amazon --jan 4542804151626 --json
```

To preserve raw API responses into replayable local state for `/amazon-listings`:

```sh
npm run amazon:catalog:probe -- --env-file .env.amazon --jan 4542804131499 --seller-listings --persist-broadcast
```

The script:

- exchanges the LWA refresh token for an access token
- calls SP-API Catalog Items `searchCatalogItems`
- defaults to the EU SP-API endpoint
- prints compact ASIN/title/brand/product type/image/identifier summaries
- writes nothing to Firestore or `broadcast` unless `--persist-broadcast` is passed

## 14. Sources Reviewed

- Amazon SP-API overview: `https://developer.amazonservices.com/`
- SP-API connection/authentication: `https://developer-docs.amazon.com/sp-api/docs/connecting-to-the-selling-partner-api`
- Private app self-authorization: `https://developer-docs.amazon.com/sp-api/docs/self-authorization`
- SigV4/IAM no longer required announcement: `https://developer-docs.amazon.com/sp-api/changelog/sp-api-will-no-longer-require-aws-iam-or-aws-signature-version-4`
- Manage product listings guide: `https://developer-docs.amazon.com/sp-api/docs/manage-product-listings-guide`
- Listings Items API reference: `https://developer-docs.amazon.com/sp-api/reference/listings-items-v2021-08-01`
- Listings Items API use cases: `https://developer-docs.amazon.com/sp-api/docs/listings-items-api`
- `searchListingsItems`: `https://developer-docs.amazon.com/sp-api/reference/searchlistingsitems`
- `getListingsItem`: `https://developer-docs.amazon.com/sp-api/reference/getlistingsitem`
- `patchListingsItem`: `https://developer-docs.amazon.com/sp-api/reference/patchlistingsitem`
- Catalog Items `searchCatalogItems`: `https://developer-docs.amazon.com/sp-api/reference/searchcatalogitems`
- Product Type Definitions API: `https://developer-docs.amazon.com/sp-api/reference/product-type-definitions-v2020-09-01`
- Listings feed type values: `https://developer-docs.amazon.com/sp-api/docs/listings-feed-type-values`
