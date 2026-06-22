# Cumulative Inventory Received Value Fix - Jun 22, 2026

## Summary

The Order Value Summary on `/unpriced` must reconcile cumulative stock-order value
against cumulative value of inventory received. Repricing old zero-cost stock can
change current inventory value, but it is not a new receipt of inventory value.

Commit `5f4c562` changed `totalCumulativeValues()` to count the increase in
running inventory value caused by a receipt. That made the summary count the
repricing of old zero-cost on-hand stock as new cumulative received value. On the
Jun 22 production backup plus the six post-backup production actions, this added
JPY 3,440 to Order 2 and every later order summary row.

The fix keeps the current-value and recount-cost behavior, but restores
cumulative inventory received value to `receivedQty * unitCost`.

## Binary Search

The blast-radius tooling now captures the derived Order Value Summary in replay
dumps, in addition to stored Redux state.

Backup used:

```sh
/tmp/production-jun22-plus-tail-firestore-export.json
```

Mismatch vectors by commit:

| Commit | Result |
|---|---:|
| `3b6a30e` | `0, 9100, 0, 0, 0, 0` |
| `1f33676` | `0, 9100, 0, 0, 0, 0` |
| `b39e6a9` | `0, 9100, 0, 0, 0, 0` |
| `5f4c562` | `0, 12540, 3440, 3440, 3440, 3440` |
| current before fix | `0, 12540, 3440, 3440, 3440, 3440` |
| current after fix | `0, 9100, 0, 0, 0, 0` |

First bad commit: `5f4c562 Track recount accounting impacts`.

## Blast Radius

Command:

```sh
bun scripts/inventory-replay-dump.ts diff \
  /tmp/order-summary-current-after-format.json \
  /tmp/order-summary-after-cumulative-fix.json \
  --out /tmp/cumulative-inventory-fix-blast-radius.md \
  --detail-limit 50
```

Report:

```sh
/tmp/cumulative-inventory-fix-blast-radius.md
```

Full Redux leaf diff artifact:

```sh
/tmp/cumulative-inventory-fix-blast-radius.full-state-diff.json
```

Order Value Summary impact:

| Order | Cumulative inventory JPY before -> after | Mismatch before -> after |
|---|---:|---:|
| Order 2 | `292509 -> 289069` | `12540 -> 9100` |
| Order 3 | `506839 -> 503399` | `3440 -> 0` |
| Order 4 | `708779 -> 705339` | `3440 -> 0` |
| Order 5 | `1009792 -> 1006352` | `3440 -> 0` |
| Order 6 | `1194572 -> 1191132` | `3440 -> 0` |

Cost and inventory state impact:

| Surface | Impact |
|---|---:|
| `inventory.idToItem` | 0 keys changed |
| `inventory.costLedger` | 0 keys changed |
| Materialized open inventory value | JPY 0 / EUR 0 |
| Average cost changes | 0 items |
| Received cost-basis changes | 0 items |
| Item history changes | 0 keys |
| Listing variant label changes | 0 |

The report shows 32 Redux leaf diffs in `photos` and listing image references.
A same-code replay control produced the same 32 diffs with no code change; these
are synthetic photo IDs and synthetic `mediaMetadata.creationTime` values
generated during replay, not an effect of the valuation fix.

Control command:

```sh
bun scripts/inventory-replay-dump.ts diff \
  /tmp/order-summary-after-cumulative-fix.json \
  /tmp/order-summary-after-cumulative-fix-repeat.json \
  --out /tmp/cumulative-inventory-fix-repeat-control.md \
  --detail-limit 20
```

Control result:

| Surface | Result |
|---|---:|
| Order Value Summary rows changed | 0 |
| Mismatch vector | `0, 9100, 0, 0, 0, 0` both runs |
| Cost ledger changes | 0 |
| Current inventory value change | 0 |
| Synthetic photo/listing leaf diffs | 32 |

## Affected Accounting

The JPY 3,440 derived-accounting delta came from ten repriced zero-cost cases:

| Item key | Before cumulative JPY | After cumulative JPY | Delta |
|---|---:|---:|---:|
| `4542804114232Blue` | 780 | 1473.333 | 693.333 |
| `4542804114232Cream` | 780 | 1408.333 | 628.333 |
| `4542804108606Bear` | 1040 | 1430 | 390 |
| `4542804080872Blue` | 780 | 1105 | 325 |
| `4542804109153Green` | 780 | 1095.714 | 315.714 |
| `4542804080872Red` | 780 | 1040 | 260 |
| `4542804108637Beige` | 520 | 780 | 260 |
| `4542804112832Cherry` | 780 | 1040 | 260 |
| `4542804109153Red` | 780 | 1030.714 | 250.714 |
| `4542804113693` | 1950 | 2006.875 | 56.875 |

Those deltas are the values that should not have been added to cumulative
received inventory value.
