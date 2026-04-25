# Shopify Order Sync Review

Compared `main...HEAD` and reviewed the design docs, Firebase functions, reducer changes, tests, and E2E coverage.

Files reviewed:

- `docs/design/SHOPIFY_ORDER_SYNC_DESIGN.md`
- `docs/design/SHOPIFY_ORDER_SYNC_IMPLEMENTATION_PLAN.md`
- `functions/index.js`
- `functions/shared/shopify-order-logic.cjs`
- `src/lib/inventory.ts`
- `src/routes/sync-status/+page.svelte`
- `scripts/shopify-order-sync-dry-run.ts`
- `tests/shopify-sync.test.ts`
- `e2e/016-shopify-sync/016-shopify-sync.spec.ts`
- `e2e/016-shopify-sync/016-shopify-cli.spec.ts`

Validation performed:

- Ran `npm exec -- vitest run tests/shopify-sync.test.ts` and confirmed the added unit tests pass.
- Ran targeted `vite-node` reducer repros for reconciliation edge cases and delayed webhook scenarios.
- Rechecked PR #113 CI after the Google live-test secrets were refreshed. `Vitest Unit Tests`, `Playwright E2E Tests`, `Vitest Live Contracts`, and `Playwright Live E2E` are all passing as of 2026-04-25.
- The previous live CI failures were stale `invalid_grant` failures from Google OAuth refresh-token exchange and do not change the findings below.

## Findings

### 1. Reconciliation is not actually a ground-truth reset for quantity decreases or removed lines

Severity: High

Where:

- `src/lib/inventory.ts:705-791`
- `src/lib/inventory.ts:447-458`

Problem:

- `applyOrderReconciliation()` computes the current inventory diff from the raw order payload, but it does not replace the order facts with the reconciled state.
- Existing `shopifyFacts.lines` entries are only updated with `Math.max(...)` for `placed`, `cancelled`, and `refunded` (`src/lib/inventory.ts:723-738`).
- Facts for lines that disappeared from Shopify are never removed.
- After the diff is applied, `syncOrderItemsFromFacts()` rebuilds `order.items` from the stale facts map, so the order state drifts back to the older quantities/lines.

Concrete failures:

- If an order was created with quantity `5` and a later reconciliation says the current quantity is `3`, `shipped` is corrected to `3` but `order.items` remains `5`.
- If an order originally had line `A=5` and `B=2`, and reconciliation later returns only `A=3`, `shipped` for `B` is reset to `0` but `order.items` still contains `B=2`.

Impact:

- The reducer violates the design doc claim that `shopify_order_reconciled` is “ground truth”.
- Subsequent reconciliations and local order views use corrupted prior state because `currentInventoryImpact` is derived from `order.items`.
- This will silently misstate synced order contents even when shipped counts briefly look correct.

Recommended fix:

- Treat reconciliation as a full overwrite of the Shopify-derived facts for that order.
- Rebuild `shopifyFacts.lines` from the reconciled payload instead of mutating prior facts with `Math.max(...)`.
- Remove facts for lines absent from the reconciled payload before calling `syncOrderItemsFromFacts()`.

### 2. Function-side broadcast actions are writing non-server timestamps, which breaks the timestamp invariant and pollutes ordering semantics

Severity: High

Where:

- `functions/index.js:348-353`
- `src/lib/redux-firestore.ts:168-173`
- `src/lib/inventory.ts:521-526`
- `src/lib/inventory.ts:648-650`

Problem:

- The function helper `writeBroadcastAction()` writes `timestamp: new Date(atMs)`, and its Shopify call sites pass `Date.now()`.
- That means the order-sync branch is stamping broadcast actions with the Cloud Functions process clock, not a Firestore server-generated timestamp.
- The normal frontend broadcast path already uses `serverTimestamp()` (`src/lib/redux-firestore.ts:168-173`), so this branch introduces an inconsistent timestamp source for the same broadcast log.
- `shopify_order_created` and `shopify_refund_created` decide whether a later reconciliation should suppress them by comparing `order.shopifyFacts.reconciledTimestamp` with `action.timestamp`.
- In this branch, `action.timestamp` is therefore not only the wrong semantic timestamp for freshness decisions, it is also not server-side.
- A delayed webhook therefore looks newer than a prior reconciliation even when the Shopify payload itself is older.

Repro I verified:

- Reconcile an order to quantity `3` using `updated_at = 2024-01-02`.
- Deliver a delayed `orders/create` webhook for the same line with `created_at = 2024-01-01`, but with a later broadcast timestamp.
- The reducer changes the order back to quantity `5`.

Impact:

- The branch violates the project invariant that action timestamps should be server-generated.
- Broadcast ordering now depends on app-server clock values for this code path, while other broadcast writers rely on Firestore server time.
- Retry storms, webhook delays, or replayed historical webhooks can regress reconciled state.
- This breaks the branch’s core promise that reconciliation heals missed or late webhooks.

Recommended fix:

- Change `writeBroadcastAction()` to write `timestamp: FieldValue.serverTimestamp()` and stop accepting or propagating `atMs` for action ordering.
- Audit other function-side action/sync writers that set `createdAt`/`timestamp` from `new Date()` or `Date.now()` and move authoritative ordering fields to Firestore server timestamps as well.
- Use Shopify payload timestamps for freshness decisions:
  - `orders/create` should use `raw.created_at`.
  - `refunds/create` should use the refund’s event timestamp from Shopify payload metadata.
  - `orders/cancelled` should use the Shopify cancellation timestamp, not Firestore ingest time.
- Keep Firestore server timestamps for persistence ordering/audit, and Shopify payload timestamps for business-event freshness decisions.

### 3. Delayed refund webhooks can be double-applied after reconciliation

Severity: High

Where:

- `src/lib/inventory.ts:645-677`
- `src/lib/inventory.ts:723-738`

Problem:

- Refund idempotency is tracked only in `order.shopifyFacts.refunds`.
- Reconciliation updates per-line refunded quantities, but it never reconstructs the processed refund ID set.
- If reconciliation already reflects a refund and the original `refunds/create` webhook arrives later, the reducer treats it as a brand-new refund and subtracts inventory again.

Repro I verified:

- Create order `5`.
- Reconcile to `3` via `refund_quantity = 2`.
- Deliver delayed refund webhook for `2`.
- Result becomes `1`, not `3`.

Impact:

- The most likely recovery path for a missed refund webhook is exactly the case that corrupts inventory.
- This is a correctness issue, not just an observability issue.

Recommended fix:

- Either make reconciliation authoritative enough that later refund webhooks older than the reconciliation are ignored, or reconstruct durable refund identity from Shopify refund objects during reconciliation.
- Do not rely on line totals alone plus a separate ad hoc refund ID map.

### 4. Webhook dedupe and dispatch are not atomic, so events can be lost or duplicated under failure/concurrency

Severity: High

Where:

- `functions/index.js:1091-1128`

Problem:

- Raw persistence, dedupe lookup, dedupe write, and broadcast write happen as separate operations.
- The code writes `shopify_order_events/{webhookId}` before `writeBroadcastAction()`.
- If the broadcast write fails after the dedupe doc is written, a retry is classified as a duplicate and the webhook is permanently skipped.
- The `get()` then `set()` dedupe flow is also race-prone: two concurrent deliveries can both observe “not exists” and both proceed.

Impact:

- The system does not actually provide the event-level idempotency described in the design doc.
- Failures in the narrow window after `eventRef.set()` become silent data loss.

Recommended fix:

- Make dedupe creation atomic with a create-only write or transaction.
- Only mark the webhook processed after the broadcast action has been durably written, or persist a pending/outbox record that can be retried safely.

### 5. The reconciliation poller is incomplete and can skip orders when more than 50 changed since the last cursor

Severity: High

Where:

- `functions/index.js:1157-1191`

Problem:

- The poller requests exactly one page of `/orders.json` with `limit=50`.
- It never follows pagination.
- It advances `lastOrderUpdatedAtCursor` to the greatest `updated_at` from that partial page.

Impact:

- If more than 50 orders changed between runs, the remainder are not processed in that run.
- Advancing the cursor from a partial page means some changed orders can be skipped permanently.
- This is especially risky because the design positions reconciliation as the safety net for missed webhooks.

Missing implementation:

- The design also says “For each order, fetch the full current state.” The current poller does not do that extra fetch; it only rebroadcasts the list response payload.

Recommended fix:

- Page through the full result set before advancing the cursor.
- Advance the cursor only after the entire page stream has been processed safely.
- If the list endpoint is not the full canonical order shape you need, fetch each order’s full state before broadcasting `shopify_order_reconciled`.

### 6. Test coverage misses the actual failure modes introduced by the implementation

Severity: Medium

Where:

- `tests/shopify-sync.test.ts:192-310`
- `e2e/016-shopify-sync/016-shopify-sync.spec.ts:107-135`

Problem:

- Unit coverage exercises:
  - duplicate create
  - full cancellation
  - refund by refund ID
  - reconciliation where quantity stays constant and only `refund_quantity` changes
  - an “older than reconciliation” case that manually injects an older action timestamp
- It does not cover:
  - quantity decrease without refund
  - removed lines during reconciliation
  - delayed refund after reconciliation
  - real production timestamp behavior, where the function writes `Date.now()` as the action timestamp
  - multi-page reconciliation
  - webhook failure between dedupe and broadcast

Impact:

- The current test suite passes while the main correctness bugs above remain present.
- The “older than reconciliation” unit test currently validates a condition that production does not satisfy.

Recommended fix:

- Add reducer tests for quantity reduction, line removal, delayed refund after reconciliation, and reconciliation overwriting old facts.
- Add function-level tests for dedupe failure windows and multi-page reconcile.
- Make at least one integration test use the same timestamp semantics the Firebase function actually writes.

## Design / Implementation Mismatch Summary

The branch moved toward the documented “raw facts” approach, but the implementation does not yet uphold the design’s core guarantees:

- Function-side broadcast writes are not using Firestore server timestamps.
- Reconciliation is not a true ground-truth reset.
- Delayed webhook handling is based on Firestore ingest time instead of Shopify event time.
- Dedupe is not durable enough to prevent loss on partial failure.
- The reconcile poller is not complete enough to serve as a recovery mechanism under load.

## Suggested Acceptance Criteria Before Merge

- Reconciliation fully replaces Shopify-derived order facts.
- Function-side action writes use Firestore server timestamps, not `new Date()`/`Date.now()`.
- All freshness comparisons use Shopify event timestamps, not broadcast arrival time.
- Refund idempotency survives reconciliation.
- Webhook dedupe + broadcast is made atomic or safely retryable.
- Reconciliation paginates through all changed orders before advancing the cursor.
- Tests cover quantity reductions, removed lines, delayed refunds, and pagination.
