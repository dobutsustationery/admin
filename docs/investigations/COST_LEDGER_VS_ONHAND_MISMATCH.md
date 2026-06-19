# Item history: summary-card on-hand vs cost-ledger-bottom on-hand

Generated 2026-06-19. On a handful of items the **on-hand in the item-history
summary card** and the **on-hand at the bottom of the cost-ledger table** (same
page) disagreed. This documents what the two figures are, the mismatches it
caused, the root cause, the fix that resolved it (and a first attempt that
backfired), and how to re-run the report.

**Status: resolved.** `reconcileItemQtyFromCostLedger` now derives `item.qty`
from the perpetual cost-engine walk (`walkLedger`) instead of the clamping
visible walk, so the summary card equals the cost-ledger bottom for every item
(report below now returns 0 disagreements; e.g. `4542804080773Cream` 18→12,
on-hand 6→0). See "Resolution".

## The two figures

Both are on `src/routes/itemhistory/+page.svelte`:

- **Summary card** (`onHand(item)`, line ~194): `item.qty - item.shipped`.
  `item.qty` is set by `reconcileItemQtyFromCostLedger` =
  `item.shipped + walkLedgerForVisibleQty(ledger).onHand`, so the card shows the
  **visible** on-hand — a walk that **clamps at zero after every entry**
  (`inventory.ts::walkLedgerForVisibleQty`).
- **Bottom of the cost-ledger table** (`row.running.onHand`, lines ~36/380):
  `walkLedger(ledger).onHand` — the **perpetual cost-engine** walk
  (`cost-engine.ts::walkLedger`), which carries an oversell as `pendingSaleQty`,
  applies the archive zero-crossing carry, and tracks FIFO lots.

When an item is never oversold and has no archive/loose-piece complications the
two walks agree. They diverge on **oversell / reversal / archive** sequences.

## Mismatches before the fix (staging, 2026-06-18 backup)

7 of 1306 items. Δ = cost-ledger bottom − summary card.

| Key | Item | Qty | Shipped | Summary card (qty−shipped) | Cost-ledger bottom (walkLedger) | Δ |
|---|---|---:|---:|---:|---:|---:|
| 4589469849758 | Gacha Blind Mystery Box | 17 | 9 | 8 | **1** | −7 |
| 4542804080773Cream | Bag Shopping Botanical | 18 | 12 | 6 | **0** | −6 |
| 4542804117776Beige | Toile de Jouy A4 Folder | 16 | 2 | 14 | **13** | −1 |
| 4542804130904Swan | Zodiac Mini Letter Set | 23 | 1 | 22 | **21** | −1 |
| 4902505660405 | Pilot ILMILY Nuance Pen | 11 | 10 | 1 | **0** | −1 |
| 4902505660412 | Pilot ILMILY Nuance Pen | 11 | 10 | 1 | **0** | −1 |
| 4902505660450 | Pilot ILMILY Nuance Pen | 11 | 10 | 1 | **0** | −1 |

In every case the **summary card over-states** (the clamp lost over-consumed
units); the cost-ledger bottom is the lower, perpetual figure.

## Root cause

Worked example — Gacha (received **10**, never more), ledger:
```
R 10 → S 9 → S −9 (restore) → S 9 → S 8 → S −8 (restore)
```
- **Cost engine** (`walkLedger`): 10 → 1 → 10 → 1 → 0 (parks 7 as pending) →
  the −8 restore consumes the 7 pending and restores 1 → **1**. Correct
  (received 10, net sold 9).
- **Visible clamp** (`walkLedgerForVisibleQty`): 10 → 1 → 10 → 1 →
  `max(0, 1−8) = 0` (the over-consumed 7 is permanently lost) → restore `+8` →
  **8**. The reconciler then bakes 8 into `item.qty` (= 9 shipped + 8 = 17,
  though only 10 were ever received).

So the clamp inflates whenever a sale transiently exceeds on-hand and is later
reversed. (For the post-archive recount cases the archive sweep re-derivation
can over-sweep and the clamp masks that too — see ARCHIVE_SWEEP_REDERIVE.md.)

## Resolution

`reconcileItemQtyFromCostLedger` now sets `item.qty = item.shipped +
walkLedger(ledger).onHand` (the perpetual cost-engine walk) instead of
`walkLedgerForVisibleQty(ledger).onHand` (the clamping walk). Since the
cost-ledger bottom *is* `walkLedger`, `item.qty − shipped` now equals it by
construction — the two figures always agree.

Why this works where the first attempt (below) didn't: it changes **only the
displayed quantity**, using the **real** `walkLedger` (with its FIFO lots,
archive carry, and pending-sale handling) rather than re-implementing it. It does
**not** touch the visible-qty *reconciliation* (`applyQuantityCorrectionToReceipts`,
`increaseNewestReceiptToMatchVisibleQty`), so receipt booking is unchanged.

Effect:
- Resolves all mismatches (report returns 0). `4542804080773Cream` 18→12,
  on-hand 6→0; the other six likewise.
- Inventory **value unchanged** (valuation already used `walkLedger`).
- Isolated blast radius (jun-11 production): **2** item quantities (Toile Folder
  16→15, Zodiac Swan 23→22), 0 value change, value-neutral ledger churn; full
  branch-vs-main adds exactly these 2 to the existing impact (still −4,712.60 JPY).
- Items already consistent with `walkLedger` are untouched (`4969757160602`
  stays 20). All unit tests pass; no non-integer quantities produced.

Caveats to watch: `walkLedger` is in cost units, so a loose-piece item with a
partial-pack on-hand could yield a fractional `item.qty` (none observed in
staging/production); and `item.qty` now follows `walkLedger` while the receipt
reconciliation still uses `walkLedgerForVisibleQty`, so for an item where those
differ a later `update_item` could book a small (value-neutral) correction.

## First attempt — backfired, reverted (do not retry naively)

The first attempt instead gave `walkLedgerForVisibleQty` the same pending-sale
carry as `walkLedger` (parking over-consumption instead of clamping; archive
sweeps still zero without carry). It **backfired** and was reverted:

- It is **not equivalent to `walkLedger`** — `walkLedger` also carries FIFO
  lots, the archive carry, and restored-sale lots. Over the *same* ledger the
  partial replica still diverged (e.g. `walkLedger`=20 but the patched visible
  walk=0 for `4969757160602`).
- The pending carry only suits oversell-**reversal** (Gacha). For oversell-then-
  **restock** it parks the oversell and then cancels the *next real receipt*
  against it, **zeroing genuine stock**. Items that were already consistent broke
  (`4969757160602` 20→0, `4902850041522` 11→0).
- Because the same walk also drives the visible-qty *reconciliation*, it changed
  booked receipts catalog-wide: isolated blast radius **−14,803 JPY / −86.97
  EUR**, 8 item quantities, 28 cost-ledger keys.

That is why the fix targets `reconcileItemQtyFromCostLedger` (display only) with
the real `walkLedger`, not a re-implementation of the visible walk.

## How to run the report

The report replays a backup through the current code and lists every item where
`walkLedger(ledger).onHand` (cost-ledger bottom) ≠ `item.qty − item.shipped`
(summary card).

```sh
# 1. Get a fresh backup (staging or production):
npm run data:export -- --source staging --output ../staging-backup-jun-18
#    (or --source production --output ../production-backup-jun-18)

# 2. Run the report:
bun scripts/cost-ledger-vs-onhand.ts \
  --backup ../staging-backup-jun-18 \
  --out ../cost-ledger-vs-onhand.tsv
```

Output columns: `Key, JAN, Subtype, Description, Item qty, Shipped,
Summary-card on hand (qty-shipped), Cost-ledger bottom on hand (walkLedger),
Cost-ledger visible on hand (reconciler), Delta (cost-ledger - summary)`.

Script: `scripts/cost-ledger-vs-onhand.ts` (currently uncommitted on the branch).
The "Cost-ledger visible on hand (reconciler)" column equals the summary card in
all current mismatches — confirming the summary card follows the clamp walk and
it is `walkLedger` that diverges.
