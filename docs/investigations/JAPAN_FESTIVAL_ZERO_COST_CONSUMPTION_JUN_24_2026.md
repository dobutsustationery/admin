# Japan Festival Zero-Cost Consumption — Jun 24 2026

## Summary

The `/unpriced` route showed four `Recount Found Stock` rows even though each
row described a post-Japan-Festival recount that found fewer units than the
archive had swept. These were not physical found-stock cases.

The rows appeared because inventory-value accounting mixed two valuation
models:

- current inventory value uses the perpetual weighted-average cost engine
- cumulative sold value had been changed to consume all ordinary sales by FIFO

That made later normal sales after a real restock disagree with the current
weighted-average valuation. The visible discrepancies were small, but they were
real accounting residuals and they surfaced as misleading `Recount Found Stock`
exceptions.

## Fix

Inventory-value accounting now treats the Japan Festival/archive stocktake as a
special stocktake transition while keeping ordinary sales aligned with weighted
average valuation:

- stocktake shrinkage consumes zero-cost lots first, then priced lots
- ordinary sales consume zero-cost lots at zero value first
- ordinary nonzero-cost sales are valued at the running weighted average
- the internal lot queue is still mutated in FIFO order so later stocktake
  carry/recount logic sees the same surviving lots as the cost engine
- stocktake survivor-value restatements are counted only when they represent
  real value loss, without assigning fictional value to zero-cost stock

This keeps the invariant:

```text
Inventory Value + Cumulative Sold Inventory Value = Cumulative Inventory Value
```

for the affected post-festival/restock cases.

## Blast Radius

Formal blast-radius run:

```bash
npm run blast-radius -- compare \
  --base HEAD \
  --head working-tree \
  --backup /tmp/production-backup-jun-23-plus-delta.json \
  --name japan-festival-zero-cost-consumption-jun24
```

Artifacts:

- Report: `.blastradius/runs/japan-festival-zero-cost-consumption-jun24/report.md`
- Full state diff: `.blastradius/runs/japan-festival-zero-cost-consumption-jun24/report.full-state-diff.json`

Key results:

| Metric | Before | After |
|---|---:|---:|
| Actions | 41,975 | 41,975 |
| Inventory items | 1,297 | 1,297 |
| Cost ledger keys | 1,297 | 1,297 |
| Order value mismatch vector | `0, 9100, 0, 0, 0, 0` | `0, 9100, 0, 0, 0, 0` |
| Total on-hand inventory value JPY | 815,927.65 | 815,927.65 |
| Average cost changes | 0 | 0 |
| Received cost-basis changes | 0 | 0 |
| Current inventory-value residual JPY | -8 | 0 |
| Recount Found Stock rows | 4 | 0 |
| Recount accounting impact JPY | 7.65 | 0 |

The four removed `Recount Found Stock` rows were:

| Key | Found qty | Before impact JPY |
|---|---:|---:|
| `4542804109245Blue` | -5 | 2.77 |
| `4542804109276Beige` | -4 | 2.57 |
| `4542804109184Brown` | -5 | 2.31 |
| `4952270287321` | -4 | 0.00 |

No inventory, order, cost-ledger, average-cost, or received-cost-basis state
changed. The full Redux state diff only contains synthetic replay photo/listing
image identifier noise already seen in prior blast-radius runs.

## Validation

Focused tests:

```bash
bunx vitest run tests/unit/inventory-value.test.ts
```

Lightweight repo checks:

```bash
npm run ci
```

Both passed.
