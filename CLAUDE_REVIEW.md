# Review: Temporal Key Bindings & Order Sync Implementation

Reviewing `codex/temporal-key-bindings-design` against
`docs/design/TEMPORAL_KEY_BINDINGS_DESIGN.md` and (folded in by Gemini)
`CODEX_ORDER_SYNC_REVIEW.md`.

Four review passes:

- **Pass 1** — initial implementation through `f534d1f`.
- **Pass 2** — `3cb2703` (pending writes, resolver outcome, manual retype).
- **Pass 3** — `252fa5b` (reconciliation safety, phantom-entity guard,
  retype back-fill).
- **Pass 4** — `c277c46` ("Authoritative reconciliation and robust order
  sync refinements"). This pass folds in fixes for the five **Findings**
  raised in `CODEX_ORDER_SYNC_REVIEW.md` *and* tightens up §3.1 / §3.2 from
  pass 3.

Test status after pass 4: **`bun run test` → 272 passed, 1 skipped**, with
23 cases in `tests/shopify-sync.test.ts`. Full inventory.ts diff is +135/-89
since pass 3.

## 1. What pass 4 changed

### 1.1 Authoritative reconciliation (Finding 1)

`applyOrderReconciliation` (`inventory.ts:1108-1198`) now treats the Shopify
payload as ground truth for `shopifyFacts.lines`:

- Builds a fresh `newFacts: Record<string, ShopifyLineFact>` instead of
  mutating `oldFacts` with `Math.max(...)`.
- Lines absent from the payload are simply not in `newFacts`; the rebuild
  overwrites `order.shopifyFacts!.lines = newFacts;` so they disappear.
- `manualEntityId` is explicitly carried from `oldFact` into `newFacts` so
  user retypes survive an authoritative rebuild.
- For lines that resolve, `placed`/`cancelled`/`refunded` come straight from
  the payload — no `Math.max`, so quantities can decrease.

Verified by the new test `handles authoritative reconciliation: quantity
decrease and line removal (Finding 1)` which goes from `keyA=5, keyB=2` to
`keyA=3, keyB removed`.

### 1.2 Refund idempotency across reconciliation (Finding 3)

`inventory.ts:1198-1203` adds:

```ts
if (rawOrder.refunds) {
  rawOrder.refunds.forEach((r: any) => {
    order.shopifyFacts!.refunds[String(r.id)] = true;
  });
}
```

So when reconciliation rebuilds `fact.refunded` from `li.refund_quantity`,
it also marks the refund IDs as processed. A delayed
`shopify_refund_created` for the same id short-circuits via the existing
`order.shopifyFacts.refunds[refundID]` check and does not re-deduct
inventory. New test `handles authoritative reconciliation: refund
idempotency (Finding 3)` covers this end-to-end.

### 1.3 Atomic webhook dedupe (Finding 4)

`functions/index.js:1109-1118`:

```ts
try {
  await eventRef.create({ processedAt: FieldValue.serverTimestamp() });
} catch (e) {
  if (e.code === 6 || e.message?.includes("already exists")) {
    logger.info("Duplicate webhook received", { webhookId });
    return res.status(200).send("Duplicate");
  }
  throw e;
}
```

Replaces the prior `get()` then `set()` pattern. Two concurrent deliveries
can no longer both observe "not exists" and both proceed.

Caveat: this only addresses the **race-condition** half of Finding 4. The
**durability** half ("only mark the webhook processed after the broadcast
action has been durably written") is not addressed — `eventRef.create()`
still happens before `writeBroadcastAction()`. If `writeBroadcastAction()`
throws, the dedupe doc is already committed, and the next retry of the
same webhook id is treated as a duplicate. The Codex review's
recommendation for an outbox/pending pattern is still open.

### 1.4 Server timestamps for function-side broadcasts (Finding 2)

`writeBroadcastAction` (`functions/index.js:348-360`) now defaults to
`FieldValue.serverTimestamp()` when `atMs` is undefined. The Shopify
webhook (`functions/index.js:1135-1140`) and reconcile poller
(`functions/index.js:1196-1202`) drop the `atMs` argument, so they get
server timestamps.

Caveat: the `shopifyCatalog/{begin_sync,apply_sync_chunk,complete_sync,
fail_sync}` writers (`functions/index.js:638-708`) **still** pass
`atMs: startMs` / `nextAtMs` / `Date.now()`. Codex's recommendation was to
"stop accepting or propagating atMs for action ordering"; Gemini kept the
parameter and only converted the order-sync call sites. The catalog-sync
path is outside the temporal-bindings scope, but the inconsistency stands
— other broadcast writers still set their own clock for ordering purposes.

For the `isReconciledLater` and `reconciledTimestamp >= timestamp`
freshness gates, both branches already used Shopify payload timestamps
(via `Date.parse(rawOrder.created_at || updated_at)`), so the bug Codex
reproduced ("delayed webhook reverts reconciliation") was really about
the function clock contaminating ordering during replay, not the
freshness comparison itself. Switching the order-sync path to server
timestamps fixes the production reproduction.

### 1.5 Reconcile poller pagination (Finding 5)

`functions/index.js:1170-1220`:

```ts
let endpoint = `…/orders.json?limit=250&…`;
while (endpoint) {
  const response = await fetch(endpoint, { headers });
  …
  for (const order of orders) { await writeBroadcastAction({ … }); }
  endpoint = shopifyCore.parseNextLink(response.headers.get("Link"));
}
if (nextCursor !== lastCursor) {
  await stateRef.set({ lastOrderUpdatedAtCursor: nextCursor, lastRunAt: Date.now() }, { merge: true });
}
```

Pages through the full result set via the Link header, advances the
cursor only after all pages succeed, and only writes the cursor if it
actually moved.

Limitations:
- Mid-pagination failure throws; nothing is retried. The cursor stays
  put, so the next run starts over from the original cursor — but it
  re-broadcasts orders 1..N before reaching the failing page. Since
  `shopify_order_reconciled` is now an authoritative reset, the
  re-broadcasts are idempotent. Acceptable.
- No timeout/throttle bound on `while (endpoint)`. A very large delta
  could exceed the scheduled-function runtime budget. Not addressed; not
  a regression.
- Codex's secondary suggestion ("If the list endpoint is not the full
  canonical order shape, fetch each order's full state before
  broadcasting") is **not** implemented. The poller still rebroadcasts
  the list payload directly. As long as
  `/admin/api/<v>/orders.json?limit=250` includes `refunds` and
  `refund_line_items`, the authoritative-rebuild logic works. Worth
  documenting as an assumption; if Shopify ever truncates either field
  on the list endpoint, reconciliation would silently zero out refunds.

### 1.6 §3.1 carry-forward now uses prior impact, not new payload qty

`inventory.ts:1175-1186` switches the carry-forward calculation from
`li.quantity - li.refund_quantity` to
`oldFact.placed - oldFact.cancelled - oldFact.refunded`:

```ts
const previousImpact =
  oldFact.placed - oldFact.cancelled - oldFact.refunded;
itemQtyMap[canonicalKey] =
  (itemQtyMap[canonicalKey] || 0) + previousImpact;
```

This fully closes pass 3's §3.1 caveat: even if the new payload's
quantity differs from the recorded fact, the diff loop sees the *exact*
prior impact and does not mutate shipped. Verified by the new test
`carries forward prior impact for unresolved lines even if payload
quantity changed (§3.1)`.

The fact itself is also preserved verbatim (`newFacts[lineItemID] =
oldFact;`) so subsequent reconciliations have something to work with.

### 1.7 `retype_item` is now idempotent on order.items (§3.2)

`inventory.ts:1565-1601` rewrites the items mutation as a surgical move:

```ts
const oldItemIdx = order.items.findIndex((i) => i.itemKey === itemKey);
if (oldItemIdx !== -1) {
  const moveQty = Math.min(order.items[oldItemIdx].qty, qty);
  order.items[oldItemIdx].qty -= moveQty;
  if (order.items[oldItemIdx].qty === 0) order.items.splice(oldItemIdx, 1);
  // …add to new key, update shipped, both gated by oldItemIdx !== -1
}
```

A second dispatch with the same payload finds `oldItemIdx === -1` and
no-ops. The `shipped` adjustment moved inside the same gate so it can't
double-count either. The new test `ensures retype_item is idempotent on
order.items (§3.2)` covers the double-dispatch case I flagged in pass 3.
That latent bug is now closed.

## 2. Status of the original concerns

| Concern | P1 | P2 | P3 | P4 |
| --- | --- | --- | --- | --- |
| §2.1 Pending writes | open | fixed | — | — |
| §2.2 Resolver outcome | open | fixed | — | — |
| §2.3 Manual retype durability | open | fixed | — | — |
| §3.1 Reconciliation mutates on missing binding | — | open | partial | fixed |
| §3.2 Retype non-idempotent on order.items | — | — | flagged | fixed |
| §3.3 Pending → confirmed retype lifecycle | — | open | back-fill | — |
| §3.4 Explicit merge action | — | deferred | deferred | deferred |
| §3.5 Stored fact follows later rename | — | open (test) | covered | — |
| §3.6 Type-safety casts | — | deferred | deferred | deferred |
| Codex F1 Authoritative reconciliation | — | — | — | fixed |
| Codex F2 Server timestamps for function broadcasts | — | — | — | fixed (order paths) |
| Codex F3 Refund idempotency | — | — | — | fixed |
| Codex F4 Atomic dedupe | — | — | — | partial (atomic, not durable) |
| Codex F5 Poller pagination | — | — | — | fixed |

## 3. Concerns remaining after pass 4

### 3.1 Webhook dedupe is atomic but still not safely retryable

If `writeBroadcastAction()` throws after `eventRef.create()` succeeds, the
webhook is permanently marked processed without ever broadcasting. Codex
F4 explicitly called this out and recommended an outbox/pending pattern.
Pass 4 only fixed the concurrent-delivery race. Suggested follow-up:
either (a) move `eventRef.create()` to *after* the broadcast write, or
(b) record a pending row and confirm only after the broadcast commits.

### 3.2 Catalog-sync writers still use the function clock

`shopifyCatalog/begin_sync`, `apply_sync_chunk`, `complete_sync`, and
`fail_sync` still pass `atMs: Date.now()` (or `startMs + i`). Codex F2's
recommendation was a blanket "stop accepting or propagating atMs". The
order-sync paths (the focus of this branch) are clean, but the catalog
path remains inconsistent. Out of scope for temporal bindings, but a
worthwhile follow-up since the same broadcast log is shared.

### 3.3 Reconciliation depends on `rawOrder.refunds` being populated

The Finding 3 fix requires the payload to carry a complete `refunds`
array. The list-endpoint poller and webhook payloads both include it
today, but if Shopify ever truncates it (or a different ingestion path
sends a stripped payload), refund webhooks delivered after that
reconciliation would re-deduct inventory. Worth either an assertion in
the poller (pull the full order if `refunds` is missing) or a comment
documenting the assumption.

### 3.4 No regression test for the pre-existing `shopify_order_created`
freshness path

The authoritative rebuild only applies in `applyOrderReconciliation`.
`shopify_order_created` still uses the old `Math.max(fact.placed, qty)`
logic. That is correct — order_created should only ever introduce or
grow lines — but the test suite has no case where a webhook arrives,
reconciliation overwrites it, and a delayed `orders/create` retry then
arrives. Today the `isReconciledLater` gate handles it, but a regression
guard would make the contract explicit.

### 3.5 Merge case still under-modelled (§3.4)

Forward lookups remain correct, but `entityIdByCurrentKey` is 1:1 after
a silent merge via `update_field`/`rename_subtype`. Gemini explicitly
defers again. Recommend filing a follow-up for an explicit
`merge_inventory_items` action with surviving-entity intent.

### 3.6 Pending-window `manualEntityId` (cosmetic, prior-pass)

For the dispatching client, a `retype_item` at `atMs == 0` still
records `fact.itemKey = newItemKey` without `manualEntityId`, until cold
reload. A subsequent reconciliation in that window relies on the
legacy `fact.itemKey !== resolvedKey && fact.rawSku === rawSku`
heuristic. Not a regression — this was the §3.3 caveat I flagged in
pass 3 and it stands.

### 3.7 Type-safety casts (§3.6)

`(action as any).id` and `(action as any).timestamp` casts remain.
Deferred again.

## 4. Design adherence at a glance (post pass 4)

| Design item | Status |
| --- | --- |
| `KeyBindingInterval` shape, three-map index | Implemented |
| `entityId = "${docId}:${originalKey}"` | Implemented |
| Bind / rename / close helpers with pending-write guards | Implemented |
| Resolver returning `outcome` | Implemented |
| `effectiveAtMs` from order business time | Implemented |
| Binding updates on listed key-changing actions | Implemented |
| `OrderLineFact` carries raw, resolved, manual override | Implemented |
| Rename rewrites order facts and inventory references | Implemented |
| Missing-binding exceptions on Shopify lines | Implemented |
| Reconciliation preserves shipped on missing binding | Implemented (now uses prior fact impact) |
| Manual retype durable across reconciliation | Implemented (preserved through authoritative rebuild) |
| `retype_item` idempotent on `order.items`, `shipped`, `shopifyFacts` | Implemented |
| Pending-write / replay determinism | Guarded |
| Reconciliation is authoritative ground truth (Codex F1) | Implemented |
| Function-side broadcast actions use server timestamps (Codex F2) | Order paths only |
| Refund idempotency survives reconciliation (Codex F3) | Implemented |
| Atomic, retry-safe webhook dedupe (Codex F4) | Atomic; not retry-safe |
| Reconcile poller paginates to completion (Codex F5) | Implemented |
| Explicit merge actions, surviving entity recorded (§3.4) | Still deferred |

## 5. Tests after pass 4

Persisted from pass 3:

- Retype regression for `4901681382316` → `4901681382316Standard`
- Chained rename `A→B→C` with key reuse
- Manual retype preserved across reconciliation
- Refund applied to renamed current key
- Records exception when no historical binding interval exists
- Guards against pending writes with `atMs=0`
- §3.1 missing-binding does not mutate shipped (initial qty match)
- §3.3 retype_item pending → confirmed lifecycle
- §3.5 stored line facts updated on later rename

Added in pass 4:

- `carries forward prior impact for unresolved lines even if payload
  quantity changed (§3.1)` — closes the qty-mismatch caveat I flagged in
  pass 3
- `ensures retype_item is idempotent on order.items (§3.2)` — closes the
  double-dispatch non-idempotency I flagged in pass 3
- `handles authoritative reconciliation: quantity decrease and line
  removal (Finding 1)` — Codex F1 regression
- `handles authoritative reconciliation: refund idempotency (Finding 3)`
  — Codex F3 regression

Still missing (low priority):

- Webhook-failure-between-dedupe-and-broadcast (§3.1 above) — would need
  function-level harness, not Vitest.
- Multi-page reconciliation poller (Finding 5) — same, function-level.
- Reconciliation payload missing the `refunds` array (§3.3 above) —
  small Vitest case.
- `shopify_order_created` retry after reconciliation (§3.4 above).

## 6. Recommendation

After four rounds the temporal-key-bindings work plus the folded-in
order-sync hardening covers the design's core semantics, and the major
correctness concerns from both review streams (mine and Codex's) are
addressed. All 272 unit tests pass.

Suggested follow-ups, in priority order:

1. **Codex F4 durability** — make webhook dedupe + broadcast retry-safe
   (move `eventRef.create()` after the broadcast, or use an outbox row).
   This is the only remaining "high severity" Codex item that is not
   fully fixed.
2. **§3.4 explicit merge action** — design called for one; still
   deferred.
3. **Codex F2 catalog-sync timestamps** — extend the server-timestamp
   default to the remaining `writeBroadcastAction` callers so the
   broadcast log has uniform ordering semantics.
4. **§3.3 reconciliation refund-array assumption** — assert or
   document, optionally fall back to a per-order fetch when the array is
   missing.
5. **§3.6 / §3.7 type-safety polish** — drop `(action as any)` casts by
   threading `TimestampedPayloadAction` through the affected reducers.

This is in good shape to merge as the foundational layer for both
temporal binding correctness and authoritative Shopify reconciliation.
