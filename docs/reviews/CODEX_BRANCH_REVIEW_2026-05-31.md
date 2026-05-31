# Branch Review: fractional-sales/order-summary attempt

Date: 2026-05-31

Branch reviewed: `wip/fractional-sales-order-summary-attempt`

Compared against: `main` (`92a1c74`)

Head reviewed: `774d500`

Scope: reviewed the full branch diff at a code-review level, with extra attention on actions written to `broadcast`, replay determinism, `Date.now()` usage, and whether remediation actions persist computed values instead of source facts.

## Findings

### P1: Stock-order receipt remediation actions persist computed unit costs

Several user-facing remediation flows write `unitCostJpy` and `unitCostEur` directly into broadcast actions, and the reducer treats those values as authoritative ledger facts on replay.

Examples:

- `src/routes/order-exceptions/+page.svelte:339-349` broadcasts `create_stock_order_receipt` with `unitCostJpy`, computed `unitCostEur`, `receivedAt`, COO, and weight.
- `src/routes/order-exceptions/+page.svelte:404-424` broadcasts `bulk_import_items` for a newly-created unmatched inventory row with a nested `stockOrder` object containing `unitCostJpy`, computed `unitCostEur`, `receivedAt`, and `orderedQty`.
- `src/routes/unpriced/+page.svelte:924-945` has the same `bulk_import_items` stock-order payload for after-the-fact inventory creation.
- `src/lib/inventory.ts:374-383` defines `create_stock_order_receipt` as requiring `unitCostJpy` and `unitCostEur`.
- `src/lib/inventory.ts:4096-4138` writes those payload values directly into the cost ledger.
- `src/lib/inventory.ts:2953-2972` and `src/lib/inventory.ts:2974-2986` write nested `bulk_import_items.stockOrder.unitCostJpy/unitCostEur` directly into receipt lots.

This violates the rule that broadcast should contain source facts and user choices, not computed results. The EUR value is especially fragile because it is derived from order payment metadata (`paidAmount`, `paidCurrency`, `valueOfOrderJpy`). If that metadata is later corrected, replayed receipt-remediation actions keep stale EUR values instead of following the corrected order. The JPY value can also go stale if the stock-order cost interpretation changes.

Recommended fix:

- Change these actions to carry only the durable user decision and stable identifiers: `orderId`, `itemKey` or JAN/subtype, qty, note, and optionally explicit metadata fields that the user actually typed.
- In the reducer, derive `unitCostJpy`, `unitCostEur`, and received date from `stockOrderRegistry` and the order's cost rows at replay time.
- If a user truly overrides cost manually, make that an explicit manual override action/mode rather than reusing the auto-remediation path.

### P1: Broadcast receipt dates still have current-time fallbacks

Two stock-order remediation paths still fall back to wall-clock time for receipt dates that become persisted broadcast payload:

- `src/routes/order-exceptions/+page.svelte:290-297` falls back to `new Date().toISOString().slice(0, 10)` when neither proposed nor current stock-order date is available.
- `src/routes/unpriced/+page.svelte:846-848` returns `Date.now()` when `row.orderDate` is missing.

These are not just UI timestamps. They feed `receivedAt` in broadcasted stock-order receipt creation (`src/routes/order-exceptions/+page.svelte:339-349`, `src/routes/unpriced/+page.svelte:924-945`). That means the same user decision can replay differently depending on the day it was committed.

Recommended fix:

- Do not permit these remediations without a deterministic order date.
- Derive receipt date in the reducer from stock-order metadata where possible.
- If the date is genuinely missing, require an explicit user-entered date and store that as a source fact.

### P1: Subtype replacement/merge moves order references and ledgers, but sale ledger identity remains implicit

Subtype resolution rewrites order line item keys:

- `src/lib/inventory.ts:3187-3227` rewrites `order.items`, Shopify facts, and Etsy facts from old key to new key.
- `src/lib/inventory.ts:5277-5338` uses that rewrite for `replace_subtype`.
- `src/lib/inventory.ts:5340-5395` uses it for subtype merge.

Cost ledger sale rows, however, are only plain rows on the source item's ledger (`recordSale` at `src/lib/inventory.ts:1413-1445`). They do not carry an order id, order line id, or source action id that would let a later subtype resolution prove which sale should move. The new replacement/merge code compensates by moving whole ledgers and ignoring some archive/recount rows (`src/lib/inventory.ts:1228-1291`, `src/lib/inventory.ts:1293-1325`), but that is still a heuristic.

The risk is that after a subtype correction, the order now points at the replacement key while historical sale ledger entries may have been generated under the pre-correction key. If old and new subtypes have different cost basis, inventory value and cost issues can diverge from the visible order history.

Recommended fix:

- Sale ledger entries should carry stable provenance: order id, platform line id where available, source action id, and original item key.
- Subtype replacement/merge should migrate or re-resolve sale ledger entries by provenance rather than by whole-ledger heuristics.
- Add replay tests for a subtype replacement after a sale, with different source/target costs, verifying both visible order items and cost ledger value move together.

### P2: Manual cost-ledger edit actions identify rows using materialized ledger coordinates

The cost-ledger editor writes refs built from materialized ledger row data:

- `src/routes/cost-ledger-editor/+page.svelte:98-118` builds refs from `kind`, `at`, `seq`, qty, costs, source, and order id.
- `src/routes/cost-ledger-editor/+page.svelte:138-147` persists those refs in `set_cost_ledger_entries_ignored`.
- `src/routes/cost-ledger-editor/+page.svelte:191-199` persists one ref in `set_cost_ledger_entry_qty`.
- `src/lib/inventory.ts:3831-3891` and `src/lib/inventory.ts:3892-3961` apply the refs on replay, with a loose fallback if exact matching fails.

This is understandable as an editor implementation, but it is still replay-fragile. `seq`, cost, and even effective qty can change when upstream reducer behavior changes. The loose fallback reduces failure risk but increases the risk of applying the manual edit to the wrong row after replay changes.

Recommended fix:

- Give receipt rows a stable ledger-entry id when they are first created, preferably based on source action id plus a source-local row id.
- For derived ledger rows, include enough provenance to recreate the id deterministically.
- Store manual edits against that stable id. Treat materialized refs as display/debug context only.

### P2: `fix_stock_order` persists an auto cost interpretation snapshot

The stock-order commit action includes the pasted TSV and may also include `costInterpretation`:

- `src/routes/order-exceptions/+page.svelte:432-453`
- `src/lib/inventory.ts:425-456`

The reducer currently protects the intended behavior:

- `src/lib/root-reducer.ts:1474-1491` uses the supplied interpretation only when `costInterpretationMode === "manual"` or for legacy actions without a mode.
- `src/lib/root-reducer.ts:1505-1535` recomputes the stock-order rows from TSV and current metadata before applying ephemeral `apply_stock_order_costs`.

That means the current code is mostly aligned with the desired model. The risk is naming/shape: an `auto` action still stores a field named `costInterpretation`, which looks authoritative and could easily be misused later.

Recommended fix:

- Prefer omitting `costInterpretation` entirely for auto mode, or rename it to something clearly non-authoritative such as `observedCostInterpretation`.
- Keep a regression test asserting that changing auto column-selection code changes replay results for auto actions but not for manual override actions.

### P2: Some important order-exception broadcasts are fire-and-forget

`order-exceptions` has both awaited and unawaited broadcast helpers:

- `src/routes/order-exceptions/+page.svelte:246-253` calls `broadcast(...)` without awaiting or catching failures.
- `src/routes/order-exceptions/+page.svelte:255-270` has the safer awaited helper.
- `src/routes/order-exceptions/+page.svelte:404-430` uses the unawaited helper for create-inventory.
- `src/routes/order-exceptions/+page.svelte:432-455` uses the unawaited helper for committing a stock-order fix.

These flows report success immediately even if the Firestore write later fails. For low-risk UI toggles this is tolerable; for irreversible remediation actions it is a shortcut that can mislead the operator.

Recommended fix:

- Use the awaited helper for all stock-order, cost, subtype, and inventory remediation actions.
- Keep pending UI state until the write resolves.

### P3: Idempotent polling has a non-idempotent fallback for missing external version keys

The branch adds deterministic broadcast document ids for reconcile pollers:

- `functions/shared/reconcile-broadcast-id.cjs:7-23`
- `functions/index.js:390-405`
- `functions/index.js:1252-1276`
- `functions/index.js:1500-1524`

This is the right direction and should stop most no-op broadcast growth. However, if Shopify or Etsy data lacks the required id/version timestamp, the code falls back to `writeBroadcastAction(...)`, which appends a new broadcast document.

That fallback may be rare, but it is the exact failure mode that makes `broadcast` grow without bound.

Recommended fix:

- Track and alert on `missingKeyFallbackCount`.
- Prefer skipping and logging malformed reconcile rows over appending non-idempotent actions.
- If skipping is too aggressive, derive a deterministic fallback id from the full raw payload hash.

## Positive Notes

- The central `fix_stock_order` reducer path does not persist `apply_stock_order_costs`; it recomputes from raw TSV and order metadata, then dispatches the computed apply action only ephemerally (`src/lib/root-reducer.ts:1505-1540`). That is the right shape.
- `reconstruct_stock_order_unmatched_receipt` and `reconstruct_stock_order_late_scan_receipt` are closer to the desired model: their broadcast payloads identify the order/item and user note, while the reducer derives costs from `stockOrderRegistry` (`src/lib/inventory.ts:3962-4059`, `src/lib/inventory.ts:4164-4265`).
- The branch has substantial focused test coverage around cost ledger behavior, stock-order parsing, subtype exceptions, and order exceptions.
- Reducer-side `Date.now()` usage is guarded by the existing `check-no-date-now-in-reducers` script; the remaining date concerns above are UI broadcast payload construction, not reducer calls.

## Suggested Acceptance Gates Before Merge

1. Replace stock-order remediation payload costs with reducer-derived costs.
2. Remove `Date.now()` / current-date fallbacks from any broadcasted stock-order receipt date.
3. Add tests showing auto `fix_stock_order` actions replay from raw TSV and current parsing logic, while manual overrides remain fixed.
4. Add tests for created inventory from unmatched rows proving replay derives cost from order facts rather than persisted computed values.
5. Add subtype replacement/merge tests that include sales before and after replacement and verify order rows, shipped qty, sale ledger rows, and inventory value stay aligned.
6. Make critical remediation broadcasts awaited.
