# Review: Etsy Order Sync Implementation

Reviewing branch `design/etsy-order-sync` against
`docs/design/ETSY_ORDER_SYNC_DESIGN.md`.

Branch range: `main..HEAD` (commits `905442e` through `39b2881`).

Files touched:

- `docs/design/ETSY_ORDER_SYNC_DESIGN.md` (new design doc)
- `ETSY_SETUP.md` (new, user-facing setup guide)
- `scripts/etsy-setup.ts` (OAuth + webhook setup tool)
- `functions/index.js` (webhook + reconcile poller)
- `functions/shared/etsy-order-logic.cjs` (HMAC + receipt fetch)
- `src/lib/inventory.ts` (actions, reducer, exceptions)
- `src/lib/shopify-sync-model.ts`, `src/lib/sync-queue-slice.ts`
  (extend domain enum)
- `src/routes/sync-status/+page.svelte` (Etsy exceptions UI)
- `tests/unit/etsy-history.test.ts` (new, 2 cases)
- `e2e/017-etsy-sync/017-etsy-sync.spec.ts` (new, 1 case)

Test status: **`bun run test` → 274 passed, 1 skipped**, including the 2 new
Etsy unit tests.

## 1. Summary

The branch lays in the obvious scaffolding — actions, reducer, HMAC helper,
webhook function, schedule poller, exceptions UI, an OAuth helper, and a
short design doc. The happy path works: a webhook payload with a numeric
SKU on a known item produces an `etsy_order_created` broadcast that the
reducer applies to `idToItem.shipped`. Cancellation via `receipt.updated`
with status `"canceled"` correctly drives `shipped` back to zero.

That said, the implementation is essentially a **shallow port of the
pre-pass-4 Shopify reducer**. Every correctness fix that landed in
`codex/temporal-key-bindings-design` (Codex Findings 1–5 plus the
temporal-binding integration) is **absent here**. In a few places it also
violates the design doc itself, and one place (HMAC verification) is a
straight security hole.

## 2. Findings

### 2.1 HMAC verification fails open  ⚠️ security

`functions/index.js:1313-1324`:

```ts
if (!etsyOrderLogic.verifyEtsyWebhookSignature(req.rawBody, signature, config.sharedSecret)) {
  logger.error("Etsy HMAC verification failed", { topic, webhookId });
  // In production, you might want to return 401.
  // For now, let's log and proceed or return 401 if we are sure about the secret.
  // return res.status(401).send("Unauthorized");
}
```

The 401 return is commented out. Any caller who knows the webhook URL can
forge an Etsy payload and have it dispatched into the broadcast log — no
signature required. The design doc explicitly requires "Verify Etsy
webhook signature (using the shared secret)" as step 1.

The E2E test `017-etsy-sync.spec.ts` does compute a real HMAC, so the
security gap isn't exercised, but uncomment-or-not is a one-line
production blocker.

Additional concern: `verifyEtsyWebhookSignature` only uses
`HMAC-SHA256(secret, body)` (`etsy-order-logic.cjs:19-23`). A comment in
the same file admits the function is "a placeholder for the exact Etsy v3
signature verification logic." Etsy v3 typically signs with a webhook
*secret* per webhook (not the app shared secret) and may include the URL
or timestamp in the canonical string. Worth confirming against current
Etsy docs before relying on it.

### 2.2 `scripts/etsy-setup.ts --apply` is a no-op

`scripts/etsy-setup.ts:142-157`:

```ts
console.log("\nChecking existing Etsy webhooks...");
// GET /v3/application/webhooks
// (This is a simplified placeholder for the actual Etsy v3 Webhook API)

if (apply) {
  console.log("\nRegistering webhooks...");
  for (const topic of DEFAULT_TOPICS) {
    console.log(`Registering ${topic}...`);
    // POST /v3/application/webhooks
  }
  console.log("\nRegistration complete.");
}
```

There is no `fetch()` call. The "Registration complete." line will print
even though nothing is registered. `ETSY_SETUP.md` step 4 instructs users
to run this command and treats the output as success.

OAuth exchange in the same file (lines 117-123) only `console.log`s the
token; it doesn't write to the `.env` file. Both gaps mean the
documented setup flow does not actually configure a working integration.

### 2.3 Etsy reducer does not adopt authoritative reconciliation
(Codex Finding 1 regression)

`applyEtsyOrderReconciliation` (`inventory.ts:1389-1403`) uses the
**old** Shopify pattern — incremental `Math.max` for `placed` and
`cancelled`, and never removes transactions that disappear from the
payload:

```ts
if (!order.etsyFacts!.lines[tx.transaction_id]) {
  order.etsyFacts!.lines[tx.transaction_id] = { … };
} else {
  const fact = order.etsyFacts!.lines[tx.transaction_id];
  fact.placed = Math.max(fact.placed, tx.quantity);
  if (isCancelled) fact.cancelled = Math.max(fact.cancelled, tx.quantity);
}
```

This is exactly the bug Codex Finding 1 reproduced for Shopify and
Gemini fixed in pass 4 of the temporal-bindings work
(`applyOrderReconciliation` rebuilds `lines` from the payload as ground
truth). For Etsy:

- A receipt that goes from qty `5` to qty `3` will *not* drop `placed`
  back to 3.
- A receipt whose transaction list shrinks (Etsy lets sellers split or
  cancel transactions in some cases) will keep the removed transaction
  in `etsyFacts.lines` forever.

Since the diff loop relies on `currentInventoryImpact` derived from
`order.items` (which is rebuilt from facts), the resulting state drifts
in the same way Codex described for Shopify before the fix.

### 2.4 Webhook dedupe is non-atomic (Codex Finding 4 regression)

`functions/index.js:1335-1341`:

```ts
const eventRef = db.collection("etsy_order_events").doc(webhookId);
const eventSnap = await eventRef.get();
if (eventSnap.exists) { … return res.status(200).send("Duplicate"); }
await eventRef.set({ processedAt: FieldValue.serverTimestamp() });
```

Two concurrent deliveries can both observe "not exists" and both
proceed. The Shopify webhook was switched to atomic `eventRef.create()`
in pass 4. Etsy still uses `get()` + `set()`.

(Same caveat as Shopify: even atomic dedupe doesn't solve the
"broadcast write fails after dedupe commit → permanent skip" problem.
That follow-up applies here too, but it's a known Codex F4 follow-up,
not a regression.)

### 2.5 Function-side broadcasts use `Date.now()` instead of server time
(Codex Finding 2 regression)

`functions/index.js:1352-1359` (webhook):

```ts
await writeBroadcastAction({
  action: { type, payload: { raw: req.body.resource_data || req.body, topic } },
  creator: "etsy-webhook",
  atMs: Date.now(),
});
```

`functions/index.js:1392-1399` (poller): same pattern.

Pass 4 dropped `atMs` from the Shopify webhook + reconcile call sites so
that `writeBroadcastAction` defaults to `FieldValue.serverTimestamp()`.
The Etsy paths were added concurrently and still pass `Date.now()`,
re-introducing process-clock contamination of the broadcast log for the
Etsy domain.

### 2.6 Reconcile poller does not paginate (Codex Finding 5 regression)

`functions/shared/etsy-order-logic.cjs:49-52`:

```ts
const params = new URLSearchParams({
  min_last_modified_timestamp: String(lastModifiedTimestamp),
  limit: "50",
});
```

There is no Link/`next_offset` follow, and `etsyOrderReconcile`
unconditionally advances `lastReceiptModifiedTimestamp` to the highest
timestamp seen on this single page. If more than 50 receipts changed
since the last run, the remainder are silently skipped — same shape as
the Shopify F5 pre-fix bug. The Shopify poller now follows the
`Link` header; Etsy doesn't.

The poller also does an N+1 fetch (one extra `GET .../transactions` per
receipt, `etsy-order-logic.cjs:73-79`). Combined with no pagination and
no concurrency limit, a backlog of 50 receipts is 51 sequential HTTPS
calls. Acceptable, but inefficient.

### 2.7 Etsy facts are not integrated with temporal key bindings

The Shopify reducer carries `rawSku`, `entityId`, and `manualEntityId`
on each `ShopifyLineFact`. Etsy reuses the `ShopifyLineFact` type
(`inventory.ts:60-63`) but the Etsy reducer never sets any of those
fields:

```ts
order.etsyFacts!.lines[tx.transaction_id] = {
  itemKey: canonicalKey,
  placed: tx.quantity,
  cancelled: isCancelled ? tx.quantity : 0,
  refunded: 0,
};
```

Consequences:

- **`rewriteOrderItemKeyReferences` ignores etsyFacts**
  (`inventory.ts:908-914`). Only `order.shopifyFacts.lines` is rewritten
  on rename. After `rename_subtype` / `update_field` / `fix_jancode`,
  `etsyFacts.lines[*].itemKey` keeps the old key. A subsequent Etsy
  reconciliation will then redirect the order line back to the (now
  empty) old key, undoing the rename's effect on Etsy-derived
  `order.items`.
- **`retype_item` ignores etsyFacts** (`inventory.ts:1816-1825` only
  iterates `order.shopifyFacts.lines`). A user-applied retype on an
  Etsy order line will not be propagated, and the next reconciliation
  reverts it.
- **No `manualEntityId` semantics for Etsy retypes**, so even if the
  shopifyFacts logic were extended, there's no override field to lean
  on.

This is a real correctness gap, not a stylistic one — every binding-aware
guarantee the Shopify side now has is missing from the Etsy side.

### 2.8 Subtype/variation extraction for Etsy is unimplemented

The design doc, §4 "Source of Truth and Keys":

> Remote Line Key Preference:
>   1. `sku` on the transaction object.
>   2. Fallback to JAN/subtype extraction from the listing title or
>      variation properties (performed by the reducer).

`mapSkuToItemKey` (`inventory.ts:824-847`) implements step 1 but its
"fallback" only looks for Shopify-style `properties` array entries
named `JAN`/`barcode`. Etsy transactions don't carry that shape — they
have `variations`, `product_data`, and the listing title. The reducer
therefore returns `null` for any Etsy transaction whose `sku` field is
empty or non-numeric, and records "Unknown SKU: " (often with an empty
string in the message — `inventory.ts:1407-1409`) as an exception.

For shops that rely on Etsy variations to encode subtype, this means
the integration silently sends every transaction to the exception list.

### 2.9 Etsy reducer has no refund handling, even at the receipt level

The design's §7 "Quantity Semantics" says:

> `inventoryImpact = sum(transaction.quantity)` for all non-cancelled
> transactions in a valid receipt.
> Cancelled receipts (e.g., status "cancelled" or refunded transactions)
> will result in a zero or reduced inventory impact.

The reducer only checks `rawReceipt.status` for `"canceled"` /
`"cancelled"` (`inventory.ts:1385-1386`). Other Etsy status values that
should reduce impact — `"refunded"`, `"partially_refunded"`, transaction
`is_overdue` / `is_paid` flags, or per-transaction refund records — are
not handled. There is no equivalent of `shopify_refund_created` for
Etsy.

The fact carries a `refunded` field that is hard-coded to `0`. The
poller fetches `transactions` but not `refunds`.

Combined with §2.3, this means an Etsy receipt that gets refunded
(without being fully cancelled) will keep its inventory impact applied.

### 2.10 `etsy_unrecognized_topic` is dispatched but not defined

`functions/index.js:1344`:

```ts
let type = "etsy_unrecognized_topic";
if (topic === "receipt.created") type = "etsy_order_created";
else if (topic === "receipt.updated") type = "etsy_order_updated";
```

But there's no `createAction("etsy_unrecognized_topic")` in
`inventory.ts` (Shopify has the equivalent at line 211). Any non-receipt
event type therefore writes a broadcast action that no reducer handles.
It won't crash — it will just sit in the log with no effect — but the
diagnostics-style action that Shopify defined explicitly is missing.

### 2.11 `mapSkuToItemKey` regex change is a Shopify behavior change too

Commit `aad939d` tightens
`/^\d+/.test(sku)` → `/^\d+$/.test(sku)`
(`inventory.ts:830`). The intent (per the new comment) is "Most SKUs are
JAN codes (13 digits)." This is more correct on its own, but it changes
precedence on the **Shopify** side: a Shopify line with SKU
`"4901681382316Standard"` *and* a `JAN` property used to return the SKU
verbatim; it now falls through to the property fallback and returns
`<JAN-property> + variantTitle`.

The existing Shopify tests still pass (none of them stack SKU + JAN
property simultaneously), but in production this could re-route an
order line to a different inventory key. A regression test for the
mixed case would document the intended behaviour. At minimum the diff
deserves a callout in the commit message — right now it ships under a
"Complete Etsy Order Sync" subject line.

### 2.12 Test coverage is shallow

`tests/unit/etsy-history.test.ts` has two cases: created+reconciled
happy path, and full-receipt cancellation. Missing:

- Unknown SKU → exception recorded, shipped untouched.
- `missing_historical_binding` (Etsy line resolved at a time before its
  binding existed).
- Key reuse and chained renames on Etsy orders.
- `retype_item` of an Etsy line — would surface §2.7.
- Removed transaction in a later reconciliation — would surface §2.3.
- Per-transaction refund → would surface §2.9.
- Idempotent re-dispatch of `etsy_order_created` (Shopify has this
  test; Etsy doesn't).

The single E2E in `017-etsy-sync.spec.ts` only tests the unknown-SKU
exception path.

### 2.13 Smaller items

- `OrderInfo.etsyFacts.refunds` is omitted from the type compared to
  `shopifyFacts` (`inventory.ts:60-63`). If/when refund support lands,
  the type must change.
- `getOrCreateOrder` (`inventory.ts:919-947`) decides Etsy vs Shopify
  by the `etsy:` prefix on the order id. Works, but it's a
  string-shape contract that's now load-bearing in the reducer.
- The exception message
  ``Unknown SKU: ${rawSku} (Transaction: ${tx.transaction_id})``
  often interpolates an empty string for `rawSku` because Etsy
  transactions frequently lack a `sku` field. Showing the
  `listing_id` and/or variation title would be more actionable.
- `ETSY_SETUP.md` step 5 says
  `npm test tests/unit/etsy-history.test.ts` — the project uses Bun
  (`bun run test`) per CLAUDE.md.

## 3. Design adherence at a glance

| Design item | Status |
| --- | --- |
| Raw payload broadcast actions (`etsy_order_*`) | Implemented |
| Webhook signature verification | Implemented but **fails open** (§2.1) |
| Event-level dedupe (`etsy_order_events/{eventId}`) | Implemented but **non-atomic** (§2.4) |
| Reconciliation poller with persistent cursor | Implemented but **single-page** (§2.6) |
| Per-receipt `reconciledTimestamp` ordering | Implemented |
| Mapping by SKU first, fallback to subtype/variation | **Fallback unimplemented for Etsy** (§2.8) |
| Cancelled receipts produce zero impact | Implemented (receipt-level only) |
| Refunded transactions reduce impact | **Not implemented** (§2.9) |
| Webhook setup tool registers webhooks | **Placeholder only** (§2.2) |
| OAuth setup tool persists tokens | Prints to stdout only (§2.2) |
| Temporal binding integration (rename/retype follows) | **Not implemented** (§2.7) |
| Authoritative ground-truth reconciliation | **Not adopted** (§2.3) |
| Server-side broadcast timestamps | **Not adopted** (§2.5) |

## 4. Recommendation

The branch ships the *shape* of an Etsy integration but it does not yet
meet the design's own contract or the production correctness bar that
the Shopify side recently reached. Suggested order of operations:

1. **Enable HMAC enforcement** (uncomment the 401 return) and confirm
   the v3 signature canonical string against current Etsy docs (§2.1).
2. **Adopt authoritative reconciliation** for `applyEtsyOrderReconciliation`
   the same way `applyOrderReconciliation` was rewritten in Codex F1
   pass — rebuild `etsyFacts.lines`, drop missing transactions, preserve
   any future `manualEntityId` (§2.3).
3. **Atomic dedupe + server timestamps** in `etsyOrderWebhook` and
   `etsyOrderReconcile` (mirror the Shopify fixes for Codex F2 + F4)
   (§2.4, §2.5).
4. **Pagination** in the poller (§2.6).
5. **Implement the Etsy fallback mapper** so transactions without a
   numeric SKU can resolve via variation/listing data (§2.8). Without
   this, a user shop relying on variations sees every transaction in
   the exception list.
6. **Wire `rewriteOrderItemKeyReferences` and `retype_item` to update
   `etsyFacts.lines`**, and decide whether `manualEntityId` should be
   tracked on Etsy facts too (§2.7).
7. **Refund/refunded-status handling** end-to-end (§2.9). At minimum,
   treat `status === "refunded"` and per-transaction
   `is_overdue / is_paid` consistently with the Shopify pattern.
8. **Make `--apply` and the OAuth flow actually configure the
   integration** rather than printing TODO comments (§2.2).
9. **Expand unit test coverage** to the missing cases in §2.12, and add
   at least one regression test for the mapper precedence change in
   §2.11.

Items 1, 2, 4, 5 are correctness blockers for any production rollout.
The rest are feature-completeness work that the design doc already
calls out, just not yet implemented.
