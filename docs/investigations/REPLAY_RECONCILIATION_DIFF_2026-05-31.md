# Replay Reconciliation Difference Investigation: 2026-05-31

## Context

After restoring the May 27 production backup into the local Firestore emulator,
the operator reconciled stock order costs and applied all visible remediations.
The goal was to verify that the emulator action log is sufficient to reproduce
the same state from replay, and to compare that replay to the clean baseline
captured earlier the same day.

No reducer or UI code was changed for this investigation. The comparison uses
the action log currently in the emulator and pure replay through
`scripts/inventory-replay-dump.ts`.

## Artifacts

| Artifact | Path |
|---|---|
| May 27 backup replay dump | `/private/tmp/admin2-baseline-may27-replay.json` |
| Current emulator action export | `/private/tmp/admin2-current-emulator-actions-20260531/firestore-export.json` |
| Current emulator replay dump | `/private/tmp/admin2-current-emulator-replay.json` |
| Diff: May 27 backup replay to current replay | `/private/tmp/admin2-may27-to-current-replay-diff.md` |
| Earlier clean baseline directory | `/private/tmp/admin2-clean-baseline-20260531-094552` |
| Diff: earlier clean baseline replay to current replay | `/private/tmp/admin2-clean-baseline-to-current-replay-diff.md` |

## Replay Result

Current emulator replay completed cleanly:

| Metric | Value |
|---|---:|
| Broadcast actions | 37,360 |
| Replay errors | 0 |
| Console logs | 1,092 |
| Console warnings | 21 |
| Console errors | 0 |

The May 27 backup had 37,316 broadcast actions. The current emulator has 44
additional actions.

| Added action type | Count |
|---|---:|
| `bulk_import_items` | 1 |
| `fix_stock_order` | 6 |
| `reconstruct_stock_order_late_scan_receipt` | 12 |
| `replace_subtype` | 1 |
| `resolve_subtype_exception` | 9 |
| `set_cost_ledger_entries_ignored` | 4 |
| `set_cost_ledger_entry_qty` | 11 |

This is consistent with the operator work performed during reconciliation:
stock order cost imports, late scan receipt reconstruction, manual ledger
quantity corrections, ignored ledger rows, subtype cleanup, and one new
inventory item.

## Diff From May 27 Backup Replay

| Metric | May 27 replay | Current replay | Delta |
|---|---:|---:|---:|
| Inventory items | 1,317 | 1,308 | -9 |
| History keys | 1,553 | 1,544 | -9 |
| Cost ledger keys | 1,316 | 1,307 | -9 |
| Missing country of origin | 402 | 399 | -3 |
| Missing weight | 443 | 399 | -44 |
| Orders | 92 | 92 | 0 |
| Order lines | 2,006 | 2,006 | 0 |
| Stock orders | 6 | 6 | 0 |

The reduction in item/history/cost-ledger keys comes from subtype remediations
that merge or replace item keys. The drop in missing weights comes from cost
imports with `fixWeights` enabled.

## Diff From Earlier Clean Baseline

The earlier clean baseline was captured at `2026-05-31T13:45:52.672Z` from
`/private/tmp/admin2-clean-baseline-20260531-094552`. Compared to that replay,
the current replay is not identical.

| Metric | Clean baseline | Current replay | Delta |
|---|---:|---:|---:|
| Broadcast actions | 37,361 | 37,360 | -1 |
| Inventory items | 1,304 | 1,308 | +4 |
| History keys | 1,540 | 1,544 | +4 |
| Cost ledger keys | 1,303 | 1,307 | +4 |
| Missing country of origin | 396 | 399 | +3 |
| Missing weight | 396 | 399 | +3 |
| Orders | 92 | 92 | 0 |
| Order lines | 2,006 | 2,006 | 0 |
| Stock orders | 6 | 6 | 0 |

Both replays had zero errors and the same console counts. The differences
therefore look like different operator remediation choices, not hidden replay
drift.

## Differences To Investigate

### 1. Different subtype decisions for `4580424665406`

Clean baseline:

- `resolve_subtype_exception`
- mode: `merge_subtypes_to_bare`

Current replay:

- `resolve_subtype_exception`
- mode: `split_bare_to_subtypes`
- allocations: `Antique: 0`, `Round/strips: 0`

Impact:

- Current replay preserves subtyped rows where the clean baseline collapsed them.
- This contributes to the current replay having more inventory/history/cost
  ledger keys.

Question:

- Which remediation is intended for this JAN after reconciliation?

### 2. Different subtype decisions for `4580424666014`

Clean baseline:

- `resolve_subtype_exception`
- mode: `merge_subtypes_to_bare`

Current replay:

- `resolve_subtype_exception`
- mode: `split_bare_to_subtypes`
- allocations: `Birds: 0`, `Cats: 0`

Impact:

- Same category as `4580424665406`: current keeps subtype keys where clean
  baseline merged them.

Question:

- Which state matches the operator intent?

### 3. Different historical order move quantities

`4542804103199`:

| Replay | Mode | Order move |
|---|---|---|
| Clean baseline | split bare to subtypes | `ellie`, subtype `Sewing`, qty `1` |
| Current replay | split bare to subtypes | `ellie`, subtype `Sewing`, qty `3` |

`4980299065828`:

| Replay | Mode | Order move |
|---|---|---|
| Clean baseline | split bare to subtypes | `dimitarluckybag`, subtype `Lilac`, qty `1` |
| Current replay | split bare to subtypes | `dimitarluckybag`, subtype `Lilac`, qty `3` |

Impact:

- The current actions record a larger historical order move than the clean
  baseline. That may be an operator choice, or it may reflect that the subtype
  exception UI is now surfacing a different candidate quantity.

Question:

- Are the `qty: 3` order moves correct for these historical orders?

### 4. `4901680123187` was recreated differently

Clean baseline:

- `bulk_import_items` created `4901680123187` under stock order
  `1n9UN6ZpGWeY-FYG_wpUd4rN7dQWzIlur`.
- Final item had `qty: 2`.
- There were additional ignored ledger actions for this item.

Current replay:

- `bulk_import_items` created `4901680123187` under stock order
  `1eK9UoCJrEkRTg3gyg7pNYRkQh2DdXmxK`.
- Final item has `qty: 1`.
- No matching extra ignore/unignore sequence exists in the current action set.

Impact:

- This is the most concrete data difference between the clean baseline and the
  current reconciliation.
- It explains one changed `idToItem` row: creation date, timestamp, and qty all
  differ.

Question:

- Which stock order should own `4901680123187`, and should the received quantity
  be 1 or 2?

### 5. Manual cost ledger edit actions are cleaner in the current replay

The clean baseline contains `set_cost_ledger_entry_qty` and
`set_cost_ledger_entries_ignored` actions whose summarized ledger refs were
missing or effectively empty. The current replay contains explicit ledger entry
refs for the comparable manual adjustments.

Examples present only in current replay:

| Item | Action | Current ref present |
|---|---|---|
| `4542804070354Yellow` | qty set to 5 | yes |
| `4542804070354Black` | qty set to 5 | yes |
| `4542804105780Blue` | qty set to 10 | yes |
| `4542804105780Grey` | qty set to 10 | yes |
| `4542804105957Blue` | qty set to 5 | yes |
| `4542804105957Cream` | qty set to 5 | yes |
| `4902778185650` | ignored qty-correction row | yes |
| `4542804081961` | ignored receipt row | yes |
| `4542804108606Rabbit` | ignored qty-correction row | yes |
| `4542804109153Green` | ignored visible-qty-increase row | yes |

Impact:

- This is expected after the persisted broadcast action cleanup: the current
  actions are more replayable and better auditable.
- It also means the earlier clean baseline is not a perfect target for
  byte-for-byte action comparison after the action-shape fixes.

Question:

- None unless a specific edited item still shows an unresolved cost issue.

### 6. Extra current manual edits for later stock orders

Current replay has manual quantity edits not present in the earlier clean
baseline:

| Item | Qty | Note |
|---|---:|---|
| `4542804149982Yellow` | 4 | `4 4 and 4` |
| `4991685190055White` | 10 | `20 recv'ed` |
| `4991685190055Pink` | 10 | `20 recv'ed 10 ea` |
| `4991685201126Black` | 10 | `20 recv'ed, 10ea` |
| `4991685201126White` | 10 | `20 recv'ed, 10ea` |

Impact:

- These account for part of the current replay differing from the earlier
  snapshot. They appear to be operator-entered reconciliation choices for later
  orders.

Question:

- Confirm these are intended remediations before treating the clean baseline as
  stale.

## Conclusion

The current emulator action log replays without errors. The current state is
reproducible from broadcast actions.

The current replay differs from the earlier clean baseline, but the differences
are explainable as changed remediation choices and cleaner persisted action
refs. The main items needing human review are:

1. Whether `4580424665406` and `4580424666014` should be split or merged.
2. Whether the historical order move quantity should be `3` rather than `1` for
   `4542804103199` and `4980299065828`.
3. Whether `4901680123187` belongs to stock order
   `1eK9UoCJrEkRTg3gyg7pNYRkQh2DdXmxK` with qty `1`, or to
   `1n9UN6ZpGWeY-FYG_wpUd4rN7dQWzIlur` with qty `2`.
4. Whether the later manual quantity edits for `4542804149982`,
   `4991685190055`, and `4991685201126` are intended final reconciliations.

