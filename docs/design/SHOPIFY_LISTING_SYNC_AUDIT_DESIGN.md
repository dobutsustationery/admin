# Shopify Listing Sync Audit Design

> **Status: Proposed** - Timestamp-gated drift detection for local listings vs Shopify listings.

## 1. Problem

We currently have listing sync flows, but we do not have a reliable, low-cost way to answer:

- Is this listing in sync?
- Is local ahead of Shopify?
- Is Shopify ahead of local?
- Do we need a deep diff right now?

Without this, we either over-sync or miss drift.

## 2. Key Question: Does Shopify expose modified timestamps?

Yes.

- Shopify Admin GraphQL `Product` has `updatedAt`.
- Shopify Admin GraphQL `ProductVariant` has `updatedAt`.
- Shopify Admin GraphQL `Order` has `updatedAt` (relevant for order sync design).

This enables a timestamp-gated strategy.

References:

- https://shopify.dev/docs/api/admin-graphql/latest/objects/Product
- https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant
- https://shopify.dev/docs/api/admin-graphql/latest/objects/Order

## 3. Goals

- Cheap first-pass drift detection using timestamps.
- Deep compare only when timestamps indicate potential drift.
- Clear classification: `in_sync`, `local_ahead`, `shopify_ahead`, `diverged`.
- Deterministic state for UI badges and repair actions.

## 4. Non-goals

- Continuous full-content compare of all listings.
- Replacing the existing sync queue.
- Automatic merge conflict resolution in v1.

## 5. Proposed Data Model

Per listing handle, track audit metadata (can live in a dedicated Firestore doc or existing listing metadata envelope):

```ts
interface ListingSyncAuditState {
  handle: string;
  lastSuccessfulSyncAt?: number; // local time ms
  lastLocalMutationAt?: number; // derived from broadcast actions
  lastObservedShopifyUpdatedAt?: string; // ISO from Shopify Product.updatedAt
  lastDeepDiffAt?: number; // local time ms
  lastDeepDiffResult?: "in_sync" | "local_ahead" | "shopify_ahead" | "diverged";
  localFingerprint?: string; // canonical hash
  shopifyFingerprint?: string; // canonical hash
}
```

## 6. Detection Algorithm

### Phase A: Timestamp Gate (cheap)

For each handle:

1. Fetch Shopify product `updatedAt` (and optionally max variant `updatedAt`).
2. Read `lastSuccessfulSyncAt` and `lastLocalMutationAt`.
3. Decide if deep diff is required.

Deep diff required when any is true:

- `shopify.updatedAt > lastSuccessfulSyncAt`
- `lastLocalMutationAt > lastSuccessfulSyncAt`
- no prior successful sync/audit baseline

Otherwise mark `in_sync` without deep compare.

### Phase B: Deep Diff (only when needed)

Canonicalize both local and Shopify listing representations and hash them.

Fields to compare in v1:

- listing: `title`, `bodyHtml`, `productCategory`, `option1Name`
- images: canonical list by `position` (`url`, `position`, `altText`)
- variants by SKU: `price`, `option1Value`, `image`, linkage to handle

Then classify:

- hashes equal -> `in_sync`
- local changed since last sync, Shopify unchanged -> `local_ahead`
- Shopify changed since last sync, local unchanged -> `shopify_ahead`
- both changed -> `diverged`

## 7. Where to Source `lastLocalMutationAt`

Use broadcast action timestamps for listing-affecting actions, e.g.:

- `create_listing`
- `update_listing`
- listing image add/remove/reorder actions
- variant fields that Shopify sync writes (`price`, subtype/option fields, variant image)

Maintain a per-handle max timestamp reducer/selector.

## 8. Execution Model

- On-demand: from `/shopify-products` or `/listing-detail` ("Check Sync Status").
- Background: scheduled audit job (e.g. hourly/nightly) over recently touched handles.
- Post-sync hook: after successful sync completion event, update `lastSuccessfulSyncAt`.

## 9. UI Behavior

- Show sync badge per listing: `in sync`, `local ahead`, `shopify ahead`, `diverged`, `unknown`.
- Show timestamps in details panel:
  - last local edit
  - last Shopify update
  - last successful sync
- Offer action buttons:
  - `Sync local -> Shopify`
  - `Pull Shopify -> Local` (future)
  - `Open diff` (future)

## 10. Rollout Plan

1. Add audit state model + reducer/selectors.
2. Implement timestamp-only gate and status badge.
3. Implement deep diff fingerprinting.
4. Add scheduled audit job.
5. Add metrics/logging (counts by status).

## 11. Risks

- Timestamp skew/timezone issues: use ISO UTC from Shopify and normalize local timestamps.
- False positives from fields we intentionally ignore: keep compare schema explicit and versioned.
- Image URL normalization drift: normalize Drive/Shopify URLs before hashing.

