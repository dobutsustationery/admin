# Review: Etsy Order Sync Implementation

Reviewing branch `design/etsy-order-sync` against
`docs/design/ETSY_ORDER_SYNC_DESIGN.md`.

Three passes:

- **Pass 1** — initial implementation (`905442e`..`39b2881`).
- **Pass 2** — Gemini's response in `b17c625`
  ("Address Etsy Order Sync review findings: security, authoritative
  reconciliation, and temporal bindings"), summarised in
  `GEMINI_ETSY_RESPONSE.md`.
- **Pass 3** — `b180477`
  ("Address remaining Etsy Order Sync review findings: fix
  double-deduction, expand unit tests, and refine mapper format")
  followed by `5580dcc` ("WIP Gemini on etsy"). Summarised in §5
  below.

Test status after pass 3 on `design/etsy-order-sync` HEAD
(`5580dcc`): **`bun run test` → 296 passed, 1 skipped** across 48
files. `tests/unit/etsy-history.test.ts` has grown from 7 to 12
cases; the Shopify regression test in `tests/shopify-sync.test.ts`
is still in place.

## 1. Pass-1 findings, status after pass 2

| # | Finding | Status |
| --- | --- | --- |
| §2.1 | HMAC fails open + placeholder algorithm | **fixed** |
| §2.2 | `etsy-setup.ts --apply` is a no-op + OAuth doesn't persist | **fixed** |
| §2.3 | No authoritative reconciliation (Codex F1) | **fixed** |
| §2.4 | Non-atomic webhook dedupe (Codex F4) | **fixed** (race only; durability still open per Shopify F4 follow-up) |
| §2.5 | `Date.now()` instead of server timestamps (Codex F2) | **fixed** |
| §2.6 | Reconcile poller doesn't paginate (Codex F5) | **fixed** (offset-based) |
| §2.7 | `rewriteOrderItemKeyReferences` / `retype_item` ignore `etsyFacts` | **fixed** |
| §2.8 | Etsy variation/title fallback mapper unimplemented | partial — see §2.1 below |
| §2.9 | Refund handling absent | **partial + new bug** — see §2.2 below |
| §2.10 | `etsy_unrecognized_topic` dispatched but not defined | **fixed** |
| §2.11 | `mapSkuToItemKey` regex shipped a Shopify behavior change | **reverted** + regression test added |
| §2.12 | Test coverage shallow | **partially expanded** (4 new unit cases) |

### 1.1 What pass 2 actually did

**HMAC verification (§2.1)** — `verifyEtsyWebhookSignature`
(`functions/shared/etsy-order-logic.cjs:16-47`) now follows Etsy v3's
`webhookId.webhookTimestamp.rawBody` canonical string, decodes the
`whsec_<base64>` secret, and uses `timingSafeEqual`. The webhook handler
(`functions/index.js:1314-1333`) returns `400` if either header is
missing and `401` if the HMAC fails — the commented-out 401 from pass 1
is now uncommented and live. The default `ETSY_SHARED_SECRET` was
updated to `whsec_dGVzdF9zZWNyZXQ=` so the e2e harness still works.
The e2e test (`017-etsy-sync.spec.ts`) was updated to match.

**Authoritative reconciliation (§2.3)** —
`applyEtsyOrderReconciliation` (`inventory.ts:1389-1495`) is rewritten
in the same shape as Shopify's pass-4 fix:

- Builds `newFacts: Record<string, ShopifyLineFact>` from the payload.
- Replaces `order.etsyFacts!.lines = newFacts;` so removed transactions
  drop out.
- Carries forward `oldFact` verbatim into `newFacts` when resolution
  fails (the `missing_historical_binding` carry-forward from Shopify
  §3.1).
- Computes `shipped` adjustments from a `netDiffMap` (new impact minus
  old impact per key) — algebraically equivalent to Shopify's diff loop
  but cleaner. Removed transactions decrement `shipped` correctly via
  the "subtract old" pass.

`ShopifyLineFact` fields `rawSku`, `entityId`, and `manualEntityId` are
now populated on Etsy facts too. Verified by the new test
"handles authoritative reconciliation: removes deleted transactions".

**Atomic dedupe (§2.4) + server timestamps (§2.5)** —
`functions/index.js:1343-1354` switches to `eventRef.create()` and
catches `code === 6` (ALREADY_EXISTS). Both webhook and reconcile poller
drop the `atMs` argument, so `writeBroadcastAction` falls into its
serverTimestamp default. Mirrors the Shopify pass-4 fix exactly.

**Pagination (§2.6)** — `fetchChangedReceipts`
(`etsy-order-logic.cjs:56-121`) loops with `offset += limit` until the
last page returns fewer than `limit` results. Etsy v3 does not use
`Link` headers, so offset-based pagination is the correct shape. A
small concurrency-5 chunk is added for the per-receipt
`/transactions` fan-out.

**Temporal bindings (§2.7)** — `rewriteOrderItemKeyReferences`
(`inventory.ts:937-952`) now iterates `etsyFacts.lines` as well. The
`retype_item` reducer (`inventory.ts:1867-1885`) gets the same
`etsyFacts` loop with the same `manualEntityId` back-fill condition
(`fact.itemKey === itemKey || (fact.itemKey === newItemKey &&
!fact.manualEntityId)`) used for Shopify in pass 3. New test
"integrates with temporal bindings: renames follow Etsy facts" exercises
the rename + reconciliation flow.

**`etsy_unrecognized_topic` action (§2.10)** —
`inventory.ts:225-228` now exports the action so dispatched broadcasts
match a defined type. There is no reducer `addCase` (same as
`shopify_unrecognized_topic`), which is fine — both are diagnostic.

**Mapper regex revert (§2.11)** — `inventory.ts:830` is back to
`/^\d+/` and an explicit Shopify regression test
"regression: resolves non-numeric SKUs correctly for Shopify" was
added in `tests/shopify-sync.test.ts`.

**Setup tool (§2.2)** — `scripts/etsy-setup.ts:140-200` actually calls
`POST /v3/application/shops/{shop_id}/webhooks` per topic and persists
the returned `shared_secret`. The OAuth exchange flow now writes
`ETSY_ACCESS_TOKEN` to `.env` for the `local` env via a new
`updateEnvFile` helper. Non-local envs still print the value for the
operator to paste — reasonable.

## 2. Concerns remaining after pass 2

### 2.1 Etsy fallback mapper resolves but the happy path is untested

`mapSkuToItemKey` (`inventory.ts:849-868`) gained an Etsy branch:

```ts
if (lineItem.listing_id || lineItem.variations) {
  if (normalizedSku) return normalizedSku as InventoryItemKey;
  const title = String(lineItem.title || "").trim();
  const janMatch = title.match(/\b\d{13}\b/);
  if (janMatch) {
    const jan = janMatch[0];
    let subtype = "";
    if (lineItem.variations) {
      subtype = lineItem.variations.map((v: any) => v.formatted_value).join(" / ");
    }
    return makeInventoryItemKey(jan, subtype);
  }
}
```

Two limitations to flag:

- **`\b\d{13}\b` only matches 13-digit JANs.** Shorter EAN-8 / UPC-12
  codes won't match. Etsy listings titled with a 12- or 14-digit JAN
  fall through to "return null" → exception. Not necessarily a bug, but
  worth a comment if 13 is the project standard.
- **Subtype concatenation uses `" / "` literally.** Inventory items
  whose subtype was created via the admin UI typically use a single
  string ("Blue", "L"). A two-variation Etsy listing produces
  "Blue / L" as the subtype, which won't match unless someone
  pre-creates the inventory item with that exact subtype. The new test
  "resolves items using fallback mapper (title/variations)" only
  asserts that the *exception* mentions the expected key
  (`1234567890123Blue`); there is no test where the fallback
  successfully resolves to an existing inventory item. The mechanism
  is "reachable" but the format question (single vs multi-variation,
  separator) is not pinned down.

This is the gap Etsy's design doc §10 flagged as the open question;
fixing the mapper to match the convention used by inventory creation
should be a follow-up.

### 2.2 New refund-status bug double-deducts shipped (regression)

`applyEtsyOrderReconciliation` now sets both `cancelled` and `refunded`
to `tx.quantity` when `rawReceipt.status === "refunded"`
(`inventory.ts:1441-1453`):

```ts
const isCancelled =
  rawReceipt.status === "canceled" ||
  rawReceipt.status === "cancelled" ||
  rawReceipt.status === "refunded";              // <-- triggers cancelled
…
newFacts[lineItemID] = {
  …
  cancelled: isCancelled || isUnpaid ? tx.quantity : 0,
  refunded:
    rawReceipt.status === "refunded" ||           // <-- also triggers refunded
    rawReceipt.status === "partially_refunded"
      ? tx.quantity : 0,
};
```

`syncOrderItemsFromFacts` and the `netDiffMap` loop both compute
`impact = placed - cancelled - refunded`. For a "refunded" receipt
`impact = qty - qty - qty = -qty`. Probed with the existing reducer
on a paid → refunded transition for `quantity = 5`:

```
[after paid]              shipped = 5
[after refunded]          shipped = -5     ← should be 0
[after partially_refunded] shipped = 0     ← should be partial, not 0
```

The `cancelled` clause should not include `"refunded"` — refunded
status should be expressed via `refunded: tx.quantity` only. As the
probe also shows, `"partially_refunded"` is handled as a full refund
because Etsy doesn't expose per-transaction refund amounts in the
fields the code reads — strictly worse than the pass-1 behaviour
(impact frozen at the placed value), and still nowhere near correct
without the actual refund total. The new unit-test set covers
"canceled" but not either refund status, which is why this snuck
through.

This is the highest-priority residual issue.

### 2.3 `partially_refunded` math is impossible without per-transaction refund data

Even after fixing §2.2, `partially_refunded` as currently coded would
zero out the line. Etsy v3 does provide refund objects on the receipt
(`receipt.refunds` per-transaction), but the reducer never reads them.
A genuine fix would either:

- Sum each transaction's refund amount from `receipt.refunds[].amount`
  (or whatever the v3 schema names it) and convert to a unit count, or
- Treat `partially_refunded` as "no impact change" until proper data
  is wired in (closer to today's pre-pass-1 behaviour).

The design doc's §7 "refunded transactions reduce impact" is still
not fully satisfiable without that data path.

### 2.4 Webhook dedupe is atomic but still not safely retryable

Same caveat that already applies on the Shopify side: if
`writeBroadcastAction()` throws after `eventRef.create()` succeeds
(`functions/index.js:1346-1371`), the webhook is permanently marked
processed without ever broadcasting. Codex F4's "outbox / retry-safe"
recommendation is open for both Shopify and Etsy.

### 2.5 Test coverage is better but still has gaps

Added in pass 2: removes deleted transactions; rename follows facts;
duplicate-create idempotency; fallback mapper exception path;
missing-historical-binding exception. Still missing:

- Happy-path test where the **fallback mapper resolves to a known
  inventory item** (would pin §2.1's variation-format question).
- Test for `status === "refunded"` (would catch §2.2).
- Test for `status === "partially_refunded"` (would catch §2.3).
- Test that `manualEntityId` survives an authoritative Etsy
  reconciliation (mirrors Shopify F1+F3).
- Test that a delayed `etsy_order_updated` with an *older*
  `updated_timestamp` than the current `reconciledTimestamp` is
  ignored (Shopify has the equivalent test).

### 2.6 Smaller residuals (carried over from pass 1)

- `OrderInfo.etsyFacts` still has no `refunds` map. Etsy doesn't have
  a per-refund webhook in this implementation, so today there is
  nothing to dedupe against. If/when refund webhooks are added the
  type must change.
- `getOrCreateOrder` still routes by `orderID.startsWith("etsy:")` —
  load-bearing string contract. Works; worth a constant.
- Pagination loop in `fetchChangedReceipts` has no upper bound; a
  pathological API response could spin forever. Defensive cap (or
  trust Etsy) — minor.
- Default secret `whsec_dGVzdF9zZWNyZXQ=` is hard-coded in
  `getEtsyConfig` for the emulator. Useful for tests, but worth a
  comment that it must be overridden in production.

## 3. Design adherence at a glance (post pass 2)

| Design item | Status |
| --- | --- |
| Raw payload broadcast actions (`etsy_order_*`) | Implemented |
| Webhook signature verification | Implemented + enforced |
| Event-level dedupe (`etsy_order_events/{eventId}`) | Atomic via `.create()` |
| Reconciliation poller with persistent cursor | Implemented + paginated |
| Per-receipt `reconciledTimestamp` ordering | Implemented |
| Mapping by SKU first, fallback to subtype/variation | Reachable, format-ambiguous (§2.1) |
| Cancelled receipts produce zero impact | Implemented |
| Refunded transactions reduce impact | **Partial + new bug** (§2.2, §2.3) |
| Webhook setup tool registers webhooks | Implemented |
| OAuth setup tool persists tokens | Implemented (local), prints (other envs) |
| Temporal binding integration (rename/retype follows) | Implemented |
| Authoritative ground-truth reconciliation | Implemented |
| Server-side broadcast timestamps | Implemented |

## 4. Recommendation

Pass 2 closed everything that was a security or correctness blocker in
pass 1 — HMAC, atomic dedupe, server timestamps, authoritative
rebuild, temporal-binding integration, and the spurious Shopify regex
change. The integration is no longer a "shallow port"; it now matches
the Shopify side everywhere except refunds.

Suggested follow-ups, in priority order:

1. **§2.2 — fix the `"refunded"` double-deduct.** Drop `"refunded"`
   from the `isCancelled` clause; keep it only on the `refunded` field.
   Add a regression test for paid → refunded.
2. **§2.3 — `partially_refunded`.** Either wire in real per-transaction
   refund amounts from `receipt.refunds`, or revert
   `partially_refunded` to no-op until data is available.
3. **§2.1 — fallback mapper format.** Decide whether multi-variation
   subtypes are joined with `" / "` or some other separator, ensure
   inventory creation uses the same convention, and add a happy-path
   test.
4. **Codex F4 durability** — make webhook dedupe + broadcast
   retry-safe (shared follow-up with Shopify, not Etsy-specific).
5. **Test gaps from §2.5** so future regressions in refund handling,
   ordering, and manualEntityId-through-reconciliation surface in CI.

Items 1 and 2 are the only correctness blockers remaining; the rest
are completeness / robustness work.

## 5. Pass 3 status (`b180477` + `5580dcc`)

Pass 3 is two commits:

- **`b180477`** — direct response to the §2 concerns from pass 2.
  `src/lib/inventory.ts` +12/-12, `tests/unit/etsy-history.test.ts`
  +243 net, plus a 634-line edit to this review file.
- **`5580dcc`** — small follow-ups: design-doc clarifications, a
  pagination safety cap, a comment on the default emulator secret.

### 5.1 Each pass-2 concern, post pass 3

| # | Concern | Status after pass 3 | Where |
| --- | --- | --- | --- |
| §2.1 | Fallback mapper variation joiner / format ambiguity | **Resolved.** Variations now joined with a single space `" "`; convention documented in design doc §7.1; happy-path test added. | `inventory.ts:864-867`; `docs/design/ETSY_ORDER_SYNC_DESIGN.md` §7.1; `etsy-history.test.ts` "resolves items using fallback mapper - happy path" |
| §2.2 | `"refunded"` double-deducts shipped | **Fixed.** `isCancelled` clause now `=== "canceled" \|\| === "cancelled"` only; `refunded` field unchanged for `status === "refunded"`. Net impact for a refunded receipt is `placed - 0 - qty = 0` instead of `placed - qty - qty = -qty`. Regression test added. | `inventory.ts:1432-1441`; `etsy-history.test.ts` "handles full refunds correctly (authoritative fix)" |
| §2.3 | `partially_refunded` impossible to compute without per-tx data | **Addressed conservatively (per design).** `partially_refunded` no longer triggers `refunded: tx.quantity`. The line keeps full `placed` impact until per-transaction refund data is wired in. Design doc §7 now explicitly documents the "no impact change" semantics. Test asserts the conservative behaviour. | `inventory.ts:1441`; design doc §7 paragraph on Partial refunds; `etsy-history.test.ts` "handles partial refunds conservatively (no impact change yet)" |
| §2.4 | Webhook dedupe atomic but not retry-safe (Codex F4) | **Still open** for both Shopify and Etsy. `eventRef.create()` is followed by `writeBroadcastAction()` with no compensating retry; if the broadcast throws, the webhook is permanently marked processed. | `functions/index.js:1346-1371` (Etsy), `functions/index.js:1122-1147` (Shopify) — unchanged shape |
| §2.5 | Five test gaps (refunded, partially_refunded, manualEntityId, out-of-order, fallback happy path) | **All five filled.** | `tests/unit/etsy-history.test.ts:325-559` |
| §2.6 | Smaller residuals: refunds map; orderID.startsWith routing; pagination upper bound; default secret comment | **Two of four addressed.** Pagination loop now caps at `MAX_PAGES = 100`. Default emulator secret now has explicit "MUST be overridden in production" comment. `OrderInfo.etsyFacts.refunds` map remains unbuilt (no Etsy refund-webhook wiring yet, so still safe to defer). `getOrCreateOrder` still routes by `orderID.startsWith("etsy:")` — no constant extracted. | `etsy-order-logic.cjs:65-69`; `functions/index.js:64-66` |

### 5.2 New observations during this pass

- **Test count moved 280 → 296.** Verified locally: `bun run test → 48
  files passed, 1 skipped, 296 tests, 1 skipped`. The +16 includes the
  +5 new etsy-history cases plus unrelated growth on the
  `codex/live-event-subtype-space-keys` work that has since merged to
  main (live event import, audit pages, `update_field`/
  `split_inventory_item` canonicalisation regression test).
- **Design doc and code now agree on partial refunds.**
  `ETSY_ORDER_SYNC_DESIGN.md` was previously silent on the difference
  between "refunded" and "partially_refunded"; pass 3 added explicit
  bullets distinguishing full refunds (zero impact), partial refunds
  (full impact, conservative), unpaid (zero impact). Anyone reading
  only the design doc will now form the same mental model the code
  implements.
- **Fallback mapper format is now contractual, not just empirical.**
  Design doc §7.1 says "multiple variations are joined by a single
  space". Code matches. The pre-requisite that inventory items must be
  created with that exact subtype string is also now documented —
  important because the system has no automatic creation of inventory
  items from Etsy listings; an unmatched fallback still raises an
  exception, by design.
- **Pass-3 pagination cap is defensive, not load-bearing.** The
  `MAX_PAGES = 100` guard would silently truncate at 5,000 receipts
  per poll cycle. Worth a `console.warn` (or an exception) if hit so
  it isn't a quiet data-loss path; today the loop just exits on the
  cap with no signal.

### 5.3 What is still genuinely open after pass 3

In priority order:

1. **§2.4 — webhook outbox / retry-safe dedupe.** Single biggest
   correctness gap remaining on either marketplace integration. A
   broadcast-write failure after a successful `eventRef.create()`
   silently drops the webhook. Recommended shape: write
   `etsy_order_events/{eventId}` as `{ status: "received", payload:
   ... }` first, attempt the broadcast, then mark
   `status: "processed"`; a periodic reaper retries `received` rows.
   This is a Shopify-shared follow-up.
2. **§2.3 follow-up — wire in per-transaction refund quantities.**
   Etsy v3 receipts carry `refunds[]` per-transaction. When/if those
   are read, the conservative "no impact change" can be replaced with
   a precise unit count, and the `partially_refunded` test should be
   strengthened to cover the partial case.
3. **§5.2 final point — pagination cap should be loud.** Add a
   `console.warn` (or surface in monitoring) when `MAX_PAGES` is hit;
   silent truncation is worse than throwing.
4. **§2.6 leftovers — `orderID.startsWith("etsy:")` constant + Etsy
   refunds map** when the time comes for refund webhooks.

The integration is now genuinely production-credible for non-refund
flows. Refund correctness is the only domain area still bounded by
"good enough for now, acknowledged in design".
