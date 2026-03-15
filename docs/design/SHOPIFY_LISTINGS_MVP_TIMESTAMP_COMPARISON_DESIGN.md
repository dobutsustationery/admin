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

- Shopify listings audit function returns handle list only.
- UI compares presence (`admin_only`, `shopify_only`, `both`).
- Local listing model has `listing.lastUpdated`.

## 3. Important Reliability Caveat (Current System)

`listing.lastUpdated` is not consistently a true mutation timestamp in all reducer paths today:

- some reducer updates use `Date.now()` in reducer execution
- replay/hydration can make timestamps reflect replay time instead of original mutation time

This means naive comparison against Shopify `updated_at` can be misleading.

## 4. Data Needed for Timestamp MVP

### Shopify side

From Admin REST `products.json`, include `updated_at` per handle:

- request `fields=id,handle,updated_at`
- output map:

```ts
shopifyByHandle: Record<string, { updatedAtIso: string; updatedAtMs: number }>;
```

### Admin side

Preferred (accurate): derive `lastLocalMutationAtMs` from broadcast action timestamps for listing-affecting actions.

Fallback (quick, lower confidence): `listing.lastUpdated`.

## 5. Recommended MVP Approach

### Phase A (smallest lift, medium confidence)

1. Extend backend listings audit payload to include Shopify `updated_at`.
2. On frontend, for `both` rows:
   - use `adminTs = listing.lastUpdated || 0`
   - use `shopifyTs = updatedAtMs || 0`
   - classify with skew tolerance `SKEW_MS = 60_000`:
     - both missing -> `unknown`
     - abs(adminTs - shopifyTs) <= SKEW_MS -> `in_sync`
     - adminTs > shopifyTs + SKEW_MS -> `local_ahead`
     - shopifyTs > adminTs + SKEW_MS -> `shopify_ahead`
3. Label this as **timestamp heuristic** in UI.

### Phase B (properly reliable)

Replace `adminTs` source with event-derived mutation timestamps:

- derive per-handle max timestamp from broadcast actions that affect listing sync fields
- remove dependence on reducer `Date.now()`

This aligns with `SHOPIFY_LISTING_SYNC_AUDIT_DESIGN`.

## 6. UI Changes

For `both` rows, add:

- `Admin Updated`
- `Shopify Updated`
- `Drift` badge: `in_sync | local_ahead | shopify_ahead | unknown`

Optional filters:

- `Both In Sync`
- `Both Drifted`

## 7. Complexity Estimate

- **Phase A:** Low-to-medium (0.5-1 day)
  - backend payload extension + frontend compare + UI columns
- **Phase B:** Medium (1-2 days)
  - event-derived admin mutation timestamp path + tests

## 8. Risks

- False drift signals while local timestamp source remains reducer-time-based.
- Timezone/string parsing inconsistencies (must normalize to UTC ms).
- Large payload if including unnecessary Shopify fields (keep fields minimal).

## 9. Acceptance Criteria (Phase A)

- For every `both` handle, UI shows admin + Shopify timestamp and drift badge.
- Presence-only rows (`admin_only`, `shopify_only`) unchanged.
- Timestamp comparison uses consistent UTC epoch ms normalization.
- UI indicates that comparison is timestamp-only, not deep content sync.
