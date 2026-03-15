# Shopify Listings MVP Timestamp Comparison

> **Status: Proposed**  
> Scope: extend `/shopify-listings` presence audit to compare "last updated" timestamps for handles present on both sides.

## 1. Goal

For handles present in both Admin and Shopify, classify by timestamp:

- `in_sync` (within tolerance window)
- `local_ahead`
- `shopify_ahead`
- `unknown` (missing/unreliable timestamp)

This is an MVP timestamp check only (no deep content diff).

## 2. Current State

- Shopify listings audit function returns handle presence data.
- UI compares presence (`admin_only`, `shopify_only`, `both`) on `/shopify-listings`.
- Local listing model has `listing.lastUpdated`.
- Timestamp handling has been remediated:
  - root reducer normalizes incoming events once into canonical `timestamp` (server shape) and `_timestamp` (ms)
  - reducers consume normalized event time (`_timestamp`) rather than `Date.now()`
  - internal reducer-composed actions inherit the same normalized timestamp pair

## 3. Timestamp Reliability (Current System)

`listing.lastUpdated` is now event-time based (from normalized `_timestamp`) in listing mutation paths, so it is suitable for MVP drift comparison.

Remaining caveat is on Shopify semantics, not local timestamp integrity:

- Shopify `Product.updatedAt` can advance for inventory-related changes and other product mutations, not only fields we consider "listing content".

## 4. Data Needed for Timestamp MVP

### Shopify side (required)

From Admin GraphQL (preferred) include `updatedAt` per handle:

- query `products { handle updatedAt }`
- output map:

```ts
shopifyByHandle: Record<string, { updatedAtIso: string; updatedAtMs: number }>;
```

### Admin side (required)

Use `listing.lastUpdated` from replayed state as local comparison timestamp.

## 5. Recommended MVP Approach

### Single-phase MVP (now reliable enough)

1. Extend backend listings audit payload to include Shopify `updated_at`.
2. On frontend, for `both` rows:
   - use `adminTs = listing.lastUpdated`
   - use `shopifyTs = updatedAtMs`
   - classify with skew tolerance `SKEW_MS = 5_000`:
     - both missing -> `unknown`
     - abs(adminTs - shopifyTs) <= SKEW_MS -> `in_sync`
     - adminTs > shopifyTs + SKEW_MS -> `local_ahead`
     - shopifyTs > adminTs + SKEW_MS -> `shopify_ahead`
3. Label this as **timestamp comparison** (not deep content diff) in UI.

## 6. UI Changes

For `both` rows, add:

- `Admin Updated`
- `Shopify Updated`
- `Drift` badge: `in_sync | local_ahead | shopify_ahead | unknown`

Filters:

- `Both In Sync`
- `Both Drifted`
- `Out of Sync` includes `admin_only`, `shopify_only`, and drifted `both` rows

## 7. Complexity Estimate

- **MVP:** Low-to-medium (0.5-1 day)
  - backend payload extension + frontend compare + UI columns

## 8. Risks

- False drift signals due to Shopify `updatedAt` semantics (can include changes outside our desired sync surface).
- Timezone/string parsing inconsistencies (must normalize to UTC ms).
- Large payload if including unnecessary Shopify fields (keep fields minimal).

## 9. Acceptance Criteria (MVP)

- For every `both` handle, UI shows admin + Shopify timestamp and drift badge.
- `shopify/listings_audit_completed` payload includes:
  - `shopifyHandles: string[]`
  - `shopifyByHandle: Record<handle, { updatedAtIso: string; updatedAtMs: number }>`
- Presence-only rows (`admin_only`, `shopify_only`) unchanged.
- Timestamp comparison uses consistent UTC epoch ms normalization.
- UI indicates that comparison is timestamp-only, not deep content sync.
