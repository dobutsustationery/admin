# Idempotent Order Reconciliation Design

> Status: Proposed
> Scope: Shopify and Etsy scheduled order reconciliation pollers

## Problem

The scheduled Shopify and Etsy reconciliation pollers currently append a new
`broadcast` action every time an external order or receipt is returned by the
remote API. This happens even when the returned external record is byte-for-byte
the same business version that was already recorded.

The reducer is mostly protected from incorrect inventory impact because it
compares external update timestamps and treats stale reconciliation actions as
no-ops. That protects derived state, but it does not protect the event log. The
log still grows every 15 minutes with duplicate raw facts.

In the May 16 to May 25 production backups:

- `broadcast` grew by `6,071` actions.
- `5,190` were `etsy_order_reconciled`.
- `866` were `shopify_order_reconciled`.
- The Etsy growth was only 6 unique receipt versions repeated hundreds of
  times.
- The Shopify growth was 1 unique order version repeated hundreds of times.

This makes backups larger, slows replay, and obscures the meaningful tail of the
event log.

## Goals

- Preserve raw external order/receipt facts as replayable broadcast actions.
- Keep webhook and reconciliation reducers as the source of business semantics.
- Stop scheduled reconciliation from appending duplicate external record
  versions.
- Keep the fix robust against inclusive cursor APIs and stale API responses.
- Make duplicate prevention observable and easy to audit.

## Non-goals

- Do not change how order facts are interpreted by reducers.
- Do not collapse distinct versions of the same external order or receipt.
- Do not remove historical duplicate actions as part of the first code change.
- Do not use reducer-derived state to decide whether to write poller facts.

## Proposed Approach

Make reconciliation writes idempotent at the Firestore write boundary.

Instead of always calling `broadcast.add(...)`, reconciliation pollers should
write each external record version to a deterministic `broadcast` document ID.
If that document already exists, the poller skips writing another copy.

The deterministic ID should be derived from:

- source system,
- action type,
- external record ID,
- external record version timestamp.

Suggested keys:

```text
shopify_order_reconciled:{shopifyOrderId}:{updated_at}
etsy_order_reconciled:{receiptId}:{updated_timestamp || create_timestamp}
```

These are not business reducers keys. They are only persistence keys that make
the append log idempotent for automatic pollers.

Manual/user actions should continue to use generated Firestore IDs. Webhook
actions can keep their existing event-level dedupe behavior unless we find a
similar growth problem there.

## Write Semantics

Add a helper for deterministic broadcast writes:

```ts
async function writeBroadcastActionOnce({
  action,
  creator,
  documentId,
}) {
  const ref = db.collection(BROADCAST_COLLECTION).doc(documentId);
  try {
    await ref.create({
      ...action,
      creator,
      timestamp: FieldValue.serverTimestamp(),
    });
    return { written: true };
  } catch (error) {
    if (isAlreadyExists(error)) {
      return { written: false, reason: "already_exists" };
    }
    throw error;
  }
}
```

Use `create()` rather than `set()` so an existing raw fact is never overwritten.
The first writer wins, later poller attempts skip the duplicate version.

## Shopify Details

For each order returned by `shopifyOrderReconcile`:

1. Read `order.id` or `order.admin_graphql_api_id` as the external order ID.
2. Read `order.updated_at` as the external version timestamp.
3. If either value is missing, fall back to the current generated-ID append path
   and log a warning. Missing version data should not silently drop facts.
4. Otherwise write:

```json
{
  "type": "shopify_order_reconciled",
  "payload": { "raw": order, "topic": "reconcile" },
  "creator": "shopify-reconcile-poller"
}
```

to:

```text
broadcast/shopify_order_reconciled:{orderId}:{updated_at}
```

Continue advancing the Shopify cursor from the maximum `updated_at` returned by
the API. Deterministic IDs are still needed because Shopify cursor results can
be inclusive or stale.

## Etsy Details

For each receipt returned by `etsyOrderReconcile`:

1. Read `receipt.receipt_id` as the external receipt ID.
2. Read `receipt.updated_timestamp || receipt.create_timestamp` as the external
   version timestamp.
3. If either value is missing, fall back to the current generated-ID append path
   and log a warning.
4. Otherwise write:

```json
{
  "type": "etsy_order_reconciled",
  "payload": { "raw": receipt, "topic": "reconcile" },
  "creator": "etsy-reconcile-poller"
}
```

to:

```text
broadcast/etsy_order_reconciled:{receiptId}:{versionTimestamp}
```

Continue advancing `lastReceiptModifiedTimestamp` from the maximum external
version timestamp returned by the API. Deterministic IDs are still needed
because Etsy's `min_last_modified_timestamp` behavior can include records at the
cursor boundary.

## Observability

Each poller run should log:

- fetched record count,
- newly written reconciliation action count,
- skipped duplicate count,
- missing-key fallback count.

This should be function logs only. We should not write a `broadcast` action just
to say that another `broadcast` action was skipped.

## Historical Duplicate Cleanup

The implementation should first stop new growth. Historical cleanup should be a
separate maintenance operation after the idempotent writer has been deployed and
observed.

A cleanup script can safely identify duplicate reconciliation facts by:

```text
type + external record ID + external version timestamp
```

For each duplicate set:

1. Keep the earliest broadcast action by `timestamp`.
2. Delete later duplicate actions of the same version.
3. Produce a dry-run report before deleting anything.

This cleanup is expected to be safe because the reducer already treats later
copies of the same external version as no-ops. It should still be done
separately so the production event-log mutation is explicit and reviewable.

## Rollout Plan

1. Add `writeBroadcastActionOnce`.
2. Update only `shopifyOrderReconcile` and `etsyOrderReconcile` to use
   deterministic document IDs.
3. Add tests around the deterministic ID construction and duplicate skip path.
4. Deploy functions.
5. Verify after at least two 15-minute poller intervals:
   - duplicate skip count is nonzero for unchanged records,
   - `broadcast` count does not grow for unchanged external versions,
   - new/changed external order versions still create new actions.
6. Decide separately whether to run historical duplicate cleanup.

## Test Plan

- Unit-test document ID generation:
  - Shopify order ID plus `updated_at`.
  - Etsy receipt ID plus `updated_timestamp`.
  - Etsy fallback to `create_timestamp`.
- Unit-test duplicate handling:
  - first `create()` writes,
  - second `create()` for same deterministic ID is skipped,
  - non-`already_exists` failures still throw.
- Add or update function tests for:
  - repeated Shopify poller result writes only one broadcast action,
  - repeated Etsy poller result writes only one broadcast action,
  - changed external timestamp writes a second action.
- Replay existing production backup before and after code change to confirm
  reducer state is unchanged.

## Open Questions

- Whether webhook writes should also move to deterministic IDs based on external
  event IDs. Current evidence points to scheduled pollers as the growth source,
  so webhook changes are intentionally out of scope.
- Whether deterministic IDs should be human-readable as proposed or hashed to
  avoid unusual characters. Shopify ISO timestamps contain `:` and Etsy integer
  timestamps do not; Firestore document IDs allow colons, so readable IDs are
  preferable unless an operational issue appears.
