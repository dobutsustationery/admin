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

## Blast radius

Reproducer:

```sh
npm run blast-radius -- compare --base HEAD --head working-tree \
  --backup ../production-backup-jun-11 --name archive-sweep-rederive
```

Both replays used the same action log (`41771 -> 41771`, 0 replay errors).

| Metric | Before | After | Delta |
|---|---:|---:|---:|
| inventoryItems | 1306 | 1306 | +0 |
| costLedgerKeys | 1305 | 1305 | +0 |
| orders / orderLines | 99 / 2072 | 99 / 2072 | +0 |
| historyKeys | 1487 | 1487 | +0 |
| **idToItem keys changed** | – | **1** | **+1** |

Exactly one item changed; nothing else moved.

| Key | On hand before -> after | Delta |
|---|---:|---:|
| `4902778185650` | 10 -> 0 | -10 |

Stored `costLedger` entries are byte-identical before and after (the change is
in the derived walk, not in persisted data), so `costLedger` shows 0 changed
keys and 0 entry deltas. The item's re-walked valuation correctly drops to 0:
before the fix it contributed ~2,827 JPY (10 × ¥282.70) of phantom on-hand
value.

## Edge case left as-is

If an item had exactly 0 on hand when its archive replayed, `recordSale` skips
writing a zero-quantity archive entry, so there is no archive marker to sweep a
later-restored pre-archive receipt. This is rare (it requires a post-archive
audit action to raise a previously-zero item's pre-archive on-hand) and is noted
here rather than fixed, to keep the change surgical.

## Verification

- `tests/unit/cost-engine.test.ts`: re-derived sweep, divergence reporting, and
  ignored-archive handling; the existing recount/carry tests are unchanged.
- Full unit suite + `bun run check` pass.
- `scripts/trace-cost-ledger.ts <backup> 4902778185650` shows `qty=0` after the
  fix and `archiveSweepDivergences` reports `recordedQty 3 -> sweptQty 13`.
