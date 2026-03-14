# Shopify Listings MVP Design

> **Status: Proposed + Implemented (MVP route)** - Presence audit by handle between Shopify and admin listings.

## 1. Problem

We need a quick way to identify listing drift at the handle level:

- exists only in admin
- exists only in Shopify
- exists in both

For MVP, this presence audit is enough. We do not need deep field diffs yet.

## 2. Scope (MVP)

New route: `/shopify-listings`

Capabilities:

- Trigger a backend fetch of Shopify product handles.
- Compare Shopify handles with local admin listing handles.
- Render a table with status:
  - `admin_only`
  - `shopify_only`
  - `both`
- Default display focuses on out-of-sync rows (`admin_only`, `shopify_only`) with optional toggle to include `both`.

## 3. Data Sources

### Admin side

- Local listing state from Redux/rehydrated broadcast:
  - `state.listings.handleToListing` keys

### Shopify side

- Backend Cloud Function worker reads Shopify Admin REST:
  - `GET /admin/api/{version}/products.json?limit=250&fields=id,handle&since_id=...`
- Iterate pagination by `since_id` until exhausted.
- Return unique handles.

## 4. Request/Response Flow

1. Route writes a request doc to:
   - `request_shopify_listing_audit/{autoId}`
2. Function trigger `shopifyListingAuditRequest` processes request.
3. Function writes result into `sync`:
   - success event: `shopify/listings_audit_completed`
   - failure event: `shopify/listings_audit_failed`
   - both include `requestId` to correlate with the route request.
4. Route listens for matching `sync.requestId` and updates table.

## 5. Event Payloads

### Request

```ts
{
  eventType: "shopify/listings_audit_requested",
  creator: string,
  requestedBy: string,
  source: "shopify-listings-page",
  createdAtMs: number
}
```

### Success

```ts
{
  eventType: "shopify/listings_audit_completed",
  requestId: string,
  creator: string,
  payload: {
    handleCount: number,
    shopifyHandles: string[]
  }
}
```

### Failure

```ts
{
  eventType: "shopify/listings_audit_failed",
  requestId: string,
  creator: string,
  payload: {
    errorCode: "shopify_listings_audit_failed",
    errorMessage: string
  }
}
```

## 6. Comparison Logic

- Normalize handles with `trim().toLowerCase()`.
- Build union of normalized handles from both sides.
- Classify each handle:
  - in admin only -> `admin_only`
  - in Shopify only -> `shopify_only`
  - in both -> `both`

## 7. Why This MVP

- Low implementation risk.
- No schema changes to listing models.
- Gives immediate operational value for sync auditing.
- Compatible with future deep-diff extension from `SHOPIFY_LISTING_SYNC_AUDIT_DESIGN`.

## 8. Follow-ups (post-MVP)

- Add per-handle deep diff and timestamp gating.
- Add links/actions from row to:
  - open local listing detail
  - trigger sync for missing side
- Persist latest audit snapshots for historical trend and metrics.
