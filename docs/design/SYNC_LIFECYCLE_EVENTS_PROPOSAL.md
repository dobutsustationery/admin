# Sync Lifecycle Events Proposal

> **Status: Proposed**  
> Goal: remove special-case sync status handling by standardizing event lifecycle semantics across domains (Shopify, Photos, Google, future domains).

## 1. Problem

Today, sync-related events are append-only (good) but lifecycle semantics are inconsistent:

- multiple naming schemes (`sync_*`, `image_transfer_*`, `listings_audit_*`, `auth_*`)
- mixed correlation keys (`requestId`, `requestEventId`)
- status derivation relies on string heuristics and exceptions

This causes:

- requests stuck in `processing` despite terminal events
- brittle UI logic (header queue, sync status page, route-specific listeners)
- replay behavior that depends on ad hoc mappings

## 2. Objectives

- One canonical lifecycle model for all sync requests.
- One canonical correlation key.
- Deterministic status derivation with minimal string matching.
- Backward compatibility for existing production event logs.

## 3. Canonical Event Contract

All sync events should include:

```ts
interface SyncLifecycleEventV1 {
  schemaVersion: 1;
  id?: string; // Firestore doc id (transport)
  domain: "shopify" | "photos" | "google" | "unknown";
  requestType: string; // e.g. "product_sync", "listings_audit", "image_transfer", "auth_refresh"
  phase:
    | "requested"
    | "claimed"
    | "api_call"
    | "completed"
    | "failed"
    | "partial_failed";
  eventType: string; // canonical: `${domain}/sync_${phase}`
  requestId: string; // canonical correlation id (required)
  requestEventId?: string; // optional debug metadata, never primary correlation
  creator?: string;
  requestedBy?: string;
  processor?: string;
  createdAtMs: number;
  payload?: Record<string, unknown>;
}
```

## 4. Canonical Lifecycle

Request lifecycle is always:

1. `*_requested`
2. optional `*_claimed`
3. zero+ `*_api_call`
4. one terminal: `*_completed` OR `*_failed` OR `*_partial_failed`

No other event names should be required for status derivation.

## 5. Correlation Rules

- Primary: `requestId` only.
- `requestEventId` may exist for traceability to request doc IDs.
- Consumer logic must never require `requestEventId` to find terminal events.

## 6. Status Derivation

Given all events with same `requestId`:

- terminal failure present -> `failed`
- terminal success present -> `success`
- claimed or api activity present -> `processing`
- requested only -> `queued`
- none -> not a request

This should use `phase` primarily (or canonicalized `eventType` as fallback).

## 7. Backward Compatibility

We already have production data using legacy names. We should keep a read-time adapter:

- `shopify/listings_audit_requested` -> `shopify/sync_requested` (`requestType = listings_audit`)
- `shopify/listings_audit_completed` -> `shopify/sync_completed`
- `shopify/listings_audit_failed` -> `shopify/sync_failed`
- photos/google legacy tails map to same lifecycle phases

Legacy rows remain immutable; no destructive rewrite needed.

## 8. Migration Plan

1. Introduce canonical normalization utility:
   - input: raw event
   - output: normalized lifecycle event shape
2. Switch all consumers (`syncQueue`, `shopifySync`, sync-status page, route listeners) to normalized shape.
3. Update producers to emit canonical `sync_*` names with explicit `requestType`.
4. Keep adapter until legacy producers are retired.
5. Add regression tests for each legacy alias.

## 9. Guardrails

- Validator in producer paths to require `requestId`, `domain`, `requestType`, `phase`.
- Metrics:
  - `unknown_event_type_count`
  - `uncorrelated_event_count`
  - `stuck_processing_count` (>N min without terminal event)
- Alerts on sustained stuck-processing growth.

## 10. Non-goals

- Rewriting historical Firestore rows.
- Building cross-request dedupe semantics in this proposal.
- Changing core event-sourcing append-only behavior.
