# Branch Review: fractional-sales/order-summary attempt

Date: 2026-05-31

Branch reviewed: `wip/fractional-sales-order-summary-attempt`

Compared against: `main` (`92a1c74`)

Head reviewed: current commit containing this review.

Scope: reviewed the branch diff at a code-review level, with extra attention on actions written to `broadcast`, replay determinism, `Date.now()` usage, and whether remediation actions persist computed values instead of source facts.

This branch has not shipped to production. The action contracts in this review intentionally assume no legacy/backward-compatibility support is required for newly introduced action shapes.

## Broadcast Re-check

Rechecked the branch-specific broadcast paths after the stable cost-ledger entry ref changes.

Cleaned and verified:

- `create_stock_order_receipt` now broadcasts only `orderId` and `itemKey`; the reducer derives qty, date, JPY cost, and EUR cost from stock-order registry facts.
- Stock-order inventory creation from `/order-exceptions` and `/unpriced` now broadcasts `bulk_import_items` with `stockOrder: { orderId, orderedQty }`; it no longer persists computed `unitCostJpy`, computed `unitCostEur`, or `receivedAt`.
- `reconstruct_stock_order_unmatched_receipt`, `reconstruct_stock_order_late_scan_receipt`, and `mark_stock_order_row_not_received` now identify the order/item/JAN plus the operator note; qty and cost facts are derived at replay time.
- `fix_stock_order` now omits `costInterpretation` for auto column selection. A present `costInterpretation` means the user made a manual override.
- `costInterpretationMode` has been removed from the new action contract.
- `set_cost_ledger_entries_ignored` and `set_cost_ledger_entry_qty` now target stable ledger-entry IDs. They no longer persist materialized `at`/`seq`, row qty, or unit costs inside the row reference.
- Shopify/Etsy reconciliation pollers no longer fall back to appending non-idempotent broadcast documents when external version fields are missing; they use deterministic payload-hash document IDs.

Commands run during the re-check:

- `git diff --unified=80 main...HEAD -- 'src/**/*.svelte' 'src/**/*.ts' 'functions/**/*.js' 'functions/**/*.cjs'`
- Targeted searches for `broadcast(`, `writeBroadcastAction`, `writeBroadcastActionOnce`, `Date.now()`, `unitCostJpy`, `unitCostEur`, `receivedAt`, `costInterpretation`, and `costInterpretationMode`.
- `npm run check`
- `npx vitest run tests/unit/cost-ledger-reducer.test.ts tests/unit/order-exceptions.test.ts tests/unit/cost-engine.test.ts tests/unit/inventory-value.test.ts`
- Pre-commit hook for the current commit: `npm run ci`, `npm run check`, and `CI=1 vitest run --coverage` passed.

## Remaining Findings

### P2: Subtype remediation broadcasts are fire-and-forget

The subtype exception payloads are source-fact oriented and do not persist computed cost values, but the route still reports success immediately after calling `broadcast(...)`:

- `src/routes/subtype-exceptions/+page.svelte:174-180` has an unawaited `broadcastAction`.
- `src/routes/subtype-exceptions/+page.svelte:183-229` uses it for split, merge, and subtype replacement remediations.

This is the same reliability issue that was fixed on `/order-exceptions`: a failed Firestore write can still show a success message.

Recommended fix:

- Make the subtype remediation helper async and await `broadcast`.
- Keep pending UI state until the write resolves.
- Report the Firestore error in `statusMessage` on failure.

### P2: Sale ledger rows still lack durable sale provenance

Subtype replacement and merge actions now move order references and cost ledgers together. Sale ledger rows now receive deterministic IDs whose source parts include order/action context where available, but those rows still do not carry structured sale provenance fields:

- `src/lib/inventory.ts:1420-1462` creates sale ledger rows with date, seq, qty, archive flag, optional audit fields, and a deterministic ID, but no separate order id, platform line id, source action id, or original item key fields.
- `src/lib/inventory.ts:5383-5445` handles `replace_subtype` by moving whole ledger state from source to target.

The reducer behavior is coherent for the cases covered so far, but the data model still makes subtype correction rely on whole-ledger movement rather than sale-row provenance.

Recommended fix:

- Add sale provenance to newly generated sale rows: source action id, order id, platform line id where available, and original item key.
- Make subtype correction use that provenance when moving or reconciling sales.
- Because this branch has not shipped, define the clean sale-row shape directly instead of adding legacy compatibility.

## Resolved Findings From Previous Review

### Resolved: Stock-order receipt remediation persisted computed unit costs

Previous issue: stock-order receipt remediation wrote `unitCostJpy`, computed `unitCostEur`, `receivedAt`, COO, and weight into broadcast actions.

Current state:

- `src/lib/inventory.ts:372-375` defines `create_stock_order_receipt` as `{ orderId, itemKey }`.
- `src/routes/order-exceptions/+page.svelte:303-306` broadcasts only that shape.
- `src/lib/inventory.ts:4133-4184` derives qty, cost, EUR cost, and receipt date from stock-order registry facts during replay.

### Resolved: Stock-order create-inventory actions persisted computed costs/dates

Previous issue: creating inventory from unmatched order rows persisted computed stock-order costs and dates in nested `bulk_import_items.stockOrder`.

Current state:

- `src/lib/inventory.ts:377-389` defines nested `stockOrder` as `{ orderId, orderedQty? }`.
- `src/routes/order-exceptions/+page.svelte:358-373` broadcasts only item source fields plus `orderId` and `orderedQty`.
- `src/routes/unpriced/+page.svelte:897-913` does the same for after-the-fact remediation.

### Resolved: Broadcast receipt dates had current-time fallbacks

Previous issue: stock-order remediation paths used current-date or `Date.now()` fallbacks that became persisted receipt dates.

Current state:

- The UI no longer sends `receivedAt` in stock-order receipt remediation actions.
- The reducer derives stock-order receipt dates from `stockOrderRegistry`.
- The remaining `Date.now()` in `src/routes/order-exceptions/+page.svelte:570` is for the local scan-batch audit cache timestamp, not a broadcast action.

### Resolved: Auto `fix_stock_order` persisted a cost interpretation snapshot

Previous issue: auto column selection could persist `costInterpretation`, making a computed UI guess look authoritative.

Current state:

- `src/routes/order-exceptions/+page.svelte:384-395` only includes `costInterpretation` when `manualOverride` is true.
- `src/lib/inventory.ts:415-430` documents that absent `costInterpretation` means auto-reconcile on replay.
- `src/lib/root-reducer.ts:1484-1490` passes the interpretation directly; absent means recompute.
- `costInterpretationMode` has been removed rather than supported as a legacy mode.

### Resolved: Order-exception remediation broadcasts were fire-and-forget

Previous issue: critical `/order-exceptions` actions used an unawaited broadcast helper.

Current state:

- `src/routes/order-exceptions/+page.svelte:245-260` awaits `broadcast`.
- `src/routes/order-exceptions/+page.svelte:309`, `src/routes/order-exceptions/+page.svelte:359`, and `src/routes/order-exceptions/+page.svelte:383` use the awaited helper for receipt creation, inventory creation, and stock-order fix commit.

### Resolved: Cost-ledger editor actions identified rows by materialized coordinates

Previous issue: cost-ledger editor actions identified rows by materialized `kind`/`at`/`seq` plus optional cost metadata. Replaying after reducer changes could make a manual edit miss its row or attach to the wrong equivalent-looking row.

Current state:

- Ledger rows now get deterministic `id` values at creation time.
- `src/routes/cost-ledger-editor/+page.svelte:98-103` builds refs containing only `{ id }`.
- `src/routes/cost-ledger-editor/+page.svelte:123-131` persists only that ref in `set_cost_ledger_entries_ignored`.
- `src/routes/cost-ledger-editor/+page.svelte:176-184` persists only that ref in `set_cost_ledger_entry_qty`.
- `src/lib/inventory.ts:326-328` defines `CostLedgerEntryRef` as `{ id: string }`.
- `src/lib/inventory.ts:2016-2018` matches refs only by `entry.id`.
- Adjustment rows now target receipts by stable entry ID instead of by `at`/`seq`.

### Resolved: Reconciliation pollers had a non-idempotent fallback

Previous issue: Shopify/Etsy reconcile pollers fell back to `writeBroadcastAction(...)` when required external version fields were missing.

Current state:

- `functions/shared/reconcile-broadcast-id.cjs:9-14` provides a deterministic payload hash.
- `functions/shared/reconcile-broadcast-id.cjs:17-40` always returns a deterministic document ID.
- `functions/index.js:1251-1266` and `functions/index.js:1488-1502` always use `writeBroadcastActionOnce`.

## Notes Outside The Branch Re-check

A broad repository search still finds older broadcast paths that use wall-clock timestamps or fire-and-forget writes, for example live/archive/photo/sync request flows. Those are outside the branch-specific stock-order remediation changes reviewed here. The branch-specific bad payloads identified in the previous review have been removed.

## Suggested Acceptance Gates Before Merge

1. Await subtype exception remediation broadcasts and surface failures.
2. Add sale provenance to new sale ledger entries so subtype corrections do not depend on whole-ledger movement.
3. Run the full pre-merge suite:
   - `npm run check`
   - `npm run ci`
   - `npm run test`
