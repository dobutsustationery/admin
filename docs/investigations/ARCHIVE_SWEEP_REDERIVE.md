# Archive sale sweep is re-derived from the current ledger

Generated 2026-06-14 from the June 11 production backup.

## Problem

`4902778185650` (Mechanical Pencil Mitsubishi Kurotoga 0.7mm Blue) was a
known false positive in
[BRANCH_IMPACT_JUN_14_2026.md](./BRANCH_IMPACT_JUN_14_2026.md): the branch
reconstructed it as **10 on hand** when the operator's account of the item is
that 20 units arrived and all of them were eventually sold, so it should be
**0**.

The action history is consistent with "20 in, 20 out":

| Date | Action | Effect |
|---|---|---|
| 2023-11-16 | `update_item` qty 20 | 20 received (Kanegan Order 1, ¥282.70) |
| 2023-11-17 | `update_field` qty 20→10 | qty-correction entry of **-10** on the lot |
| 2024-09 … 2025-04 | `package_item` / `quantify_item` | 7 units of recorded customer sales |
| 2025-05-02 | `archive_inventory` (Japan Festival) | archive stock-take wipe |
| 2026-06-04 | `set_cost_ledger_entries_ignored` | the -10 correction is **ignored** ("Count adjusted down in error") |

## Root cause: a derived value frozen into the ledger

The archive is a stock-take wipe: it sells the on-hand quantity. The
`archive_inventory` reducer computed that quantity with
`walkLedger(...).onHand` **at the moment the archive action replayed** and
recorded it as a fixed `qty` on the archive sale entry.

When the archive replayed (2025-05-02), the -10 correction was still active
(its ignore is a 2026-06-04 action, later in the log), so the archive's
on-hand was `20 - 10 - 7 = 3` and the archive sale was recorded as **qty 3**.

The later ignore restored the lot to 20 and re-walked the ledger for cost, but
the archive sale stayed frozen at 3. The final walk was therefore
`20 - 7 - 3 = 10` — ten phantom units. The fix the ledger needed was for the
archive to consume `20 - 7 = 13`, leaving 0.

This is a "facts vs. intent" violation: an archive is intent ("zero out
remaining as of this date"); the quantity it consumes is derived state and must
be recomputed on every walk, not snapshotted once. Any later action that
reinterprets a pre-archive receipt or sale (ignoring a row, correcting a
quantity, re-keying) silently desynced the frozen sweep.

## Fix

The archive sale's swept quantity is now **re-derived from the current
(post-audit) ledger** at materialisation time, in `effectiveLedgerEntries`
(`src/lib/cost-engine.ts`):

- `preArchiveOnHand` computes the on-hand of every effective, non-ignored entry
  created before the archive (`seq <` the archive's `seq`), with nested
  archives recursively sweeping their own pre-archive on-hand.
- `applyArchiveSweepQuantities` rewrites each archive sale entry's effective
  `qty` (and `visibleQty`) to that re-derived value.

Because both `walkLedger` (cost) and `walkLedgerForVisibleQty` (visible count)
consume the effective ledger, the corrected sweep flows through to cost,
valuation, and `reconcileItemQtyFromCostLedger` without changing either walk's
loop. The stored entry is left untouched, so the recorded snapshot remains the
"initially recorded" reference.

`archiveSweepDivergences` compares the recorded snapshot against the re-derived
sweep and lists every archive entry where they differ. The item-history page
and the cost-ledger editor render this as a warning ("swept N; M recorded at
archive time; the swept quantity changed because of a later audit action") so
the divergence is visible, not silent.

Importantly, the sweep consumes the **pre-archive** on-hand, not "all current
on-hand at the walk position". This preserves correctness when a sale is dated
after the archive (e.g. a mis-dated shipment): only the units that existed as of
the archive are swept, exactly as the original reducer intended.

### Archive of an already-empty item

For re-derivation to work, an archive must leave a marker even when the item is
already empty at archive time — otherwise a later audit action that raises the
item's pre-archive on-hand has nothing to sweep against and the units leak as
phantom on-hand. `recordSale` therefore now records a **zero-quantity archive
marker** for archived items (the non-archive zero-sale no-op skip is preserved).
`applyArchiveSweepQuantities` later re-derives that marker's quantity, so the
archive's "zero everything as of this date" intent survives any later
pre-archive change.

`hasPriorArchiveSale` (which classifies a later quantity increase as a
post-archive stock-take recount) is guarded to ignore these zero-quantity
markers: an archive that wiped no stock should not turn a subsequent restock
into a recount. This keeps recount classification identical to its prior
behaviour.

## Blast radius

Reproducer:

```sh
npm run blast-radius -- compare --base 646105b --head working-tree \
  --backup ../production-backup-jun-11 --name archive-sweep-with-edge-fix
```

Both replays used the same action log (`41771 -> 41771`, 0 replay errors).

| Metric | Before | After | Delta |
|---|---:|---:|---:|
| inventoryItems | 1306 | 1306 | +0 |
| orders / orderLines | 99 / 2072 | 99 / 2072 | +0 |
| **idToItem keys changed (qty)** | – | **10** | **+10** |
| costLedger keys changed | – | 777 | (entry churn, see below) |
| costLedger entry deltas | – | +1800 / -939 | zero-qty markers |
| costLedger open **value** changed | – | **0** | +0 |

Ten items have their visible on-hand corrected to **0**; no order, no open
**value**, and no cost-basis changes.

| Key | On hand before -> after |
|---|---:|
| `4902778185650` Mitsubishi Kurotoga 0.7mm Blue | 10 -> 0 |
| `4969757159187Blue` Mini Card set Fleurage | 2 -> 0 |
| `4542804119923Pink` Masking Take 30mm | 1 -> 0 |
| `4562136651236Green` Fabric Pouch 23x23cm | 1 -> 0 |
| `4562136651557Grey` Fabric Pouch 19x15.5cm | 1 -> 0 |
| `4580424665277` Letter set | 1 -> 0 |
| `4968583237502Marie` Plastic Clip Aristocats | 1 -> 0 |
| `4974052670381 / 404 / 619` Shachihata Iromoyo Mini Ink Pad | 1 -> 0 each |

**Cross-check against `main`.** All ten of these are exactly the items
[BRANCH_IMPACT_JUN_14_2026.md](./BRANCH_IMPACT_JUN_14_2026.md) recorded as
`0 -> 1/2` (and `4902778185650` as `0 -> 10`) — i.e. `main` had every one of
them at **0**, and the branch's cost-ledger-authoritative change had inflated
them. The nine `0 -> 1` items each carry a second `Discard Partial Inventory`
archive (May 3 2025) that was meant to zero the remainder; their frozen sweep
left it behind. This fix restores all ten to `main`'s correct **0**.

The `costLedger` entry churn (`+1800 / -939`) is the zero-quantity archive
markers now recorded for items that were already empty at the two archives;
`materialized open value changed: 0` confirms no item's cost basis or valuation
moved. The cost ledger is derived state re-materialised on every replay, so the
extra markers are not persisted to Firestore.

## Verification

- `tests/unit/cost-engine.test.ts`: re-derived sweep, divergence reporting, and
  ignored-archive handling; the existing recount/carry tests are unchanged.
- `tests/inventory.test.ts`: an item emptied by a pre-archive correction,
  archived, then restored by a later ignore is re-swept to 0 (the edge case).
- Full unit suite + `bun run check` pass.
- `scripts/trace-cost-ledger.ts <backup> 4902778185650` shows `qty=0` after the
  fix and `archiveSweepDivergences` reports `recordedQty 3 -> sweptQty 13`.
