# Branch Impact Report: `analysis/jun-04-broadcast-cleanup` vs `main`

Generated 2026-06-15 from the June 11 production backup. Supersedes
[BRANCH_IMPACT_JUN_14_2026.md](./BRANCH_IMPACT_JUN_14_2026.md) — the branch has
since gained the archive-sweep re-derivation, its empty-item edge fix, and the
read-only oversold surface.

Command:

```sh
npm run blast-radius -- compare --base main --head working-tree \
  --backup ../production-backup-jun-11 --name main-vs-branch-jun-15
```

Both replays used the same action log (`41771 -> 41771`, 0 replay errors).
Artifacts: `.blastradius/runs/main-vs-branch-jun-15/`.

## Totals

| Metric | Main | Branch | Delta |
|---|---:|---:|---:|
| inventoryItems | 1306 | 1306 | +0 |
| costLedgerKeys | 1305 | 1305 | +0 |
| orders | 99 | 99 | +0 |
| orderLines | 2057 | 2072 | +15 |
| stockOrders | 6 | 6 | +0 |
| historyKeys | 1542 | 1487 | -55 |
| missingCountryOfOrigin | 398 | 398 | +0 |
| missingWeight | 398 | 398 | +0 |
| hiddenExceptions | 0 | 0 | +0 |

Changed top-level sections: `idToItem`, `costLedger`, `idToHistory`,
`keyIdentity`, `orderIdToOrder`, `salesEvents`, `archivedInventoryState`,
`hiddenInventoryState`, `stockOrderRegistry`, `shopifyExceptions`. Unchanged:
`archivedInventoryDate`, `etsyExceptions`, `shopifyUrlToDriveUrl`, `initialized`.

## Item identity migration

The branch normalizes single-variant Shopify-imported keys from `JAN + subtype`
to bare `JAN` where the JAN is unambiguous: **143 keys added, 143 removed**
(mirrored in the cost ledger). Example: `4542804113471` loses its
`Default` subtype and `amifa-berry-cherry-wall-stickers-…` handle. The bare
keys also let previously-unmatched Shopify order lines bind, which is the source
of the `orderLines +15` and `shopifyExceptions 2 -> 0`.

## Visible on-hand changes (9 existing keys, 7 qty)

| Key | Qty m -> b | Shipped | On hand m -> b | Delta |
|---|---:|---:|---:|---:|
| `4589469849758` Gacha Blind Mystery Box | 10 -> 17 | 17 | **-7 -> 0** | +7 |
| `4542804080773Cream` Bag Shopping Botanical | 12 -> 18 | 18 | **-6 -> 0** | +6 |
| `4991685190055Pink` Iwako Maiko Eraser | 5 -> 10 | 8 | -3 -> 2 | +5 |
| `4991685190055White` Iwako Maiko Eraser | 5 -> 10 | 4 | 1 -> 6 | +5 |
| `4991685201126Black` Iwako Lucky Cat Eraser | 5 -> 10 | 6 | -1 -> 4 | +5 |
| `4991685201126White` Iwako Lucky Cat Eraser | 5 -> 10 | 8 | -3 -> 2 | +5 |
| `4542804149982Yellow` Amifa Chinoiserie A5 Notebook | 2 -> 4 | 4 | -2 -> 0 | +2 |

Plus two non-qty field changes: `4542804109153Red` cost rounds
`64.99999999999999 -> 65`, and `4542804113471` is the single-variant cleanup
(handle/subtype blanked).

**Reading:** every one of these was **negative on hand on `main`** (the old
last-write count let shipped exceed qty). The branch makes the cost ledger
authoritative and clamps visible on-hand at zero, so the negatives disappear
from the count. The two that clamp to exactly 0 (Gacha, Cream) are genuine
**oversells** and are now surfaced on `/unpriced` rather than hidden as negative
numbers (see [OVERSOLD_ITEMS.md](./OVERSOLD_ITEMS.md) and
[LIVE_EVENT_OVERTAKES.md](./LIVE_EVENT_OVERTAKES.md)). The four erasers
recovered to a positive count (found stock), which is correct.

## Cost ledger

`691` existing keys changed; entry deltas `+3316 / -1934`; **22** keys have a
materialised open-value change (valued with the cost engine — the blast-radius
tooling now uses the authoritative perpetual-weighted-average walk, not the old
FIFO approximation). Drivers:

- archive sweeps re-derived from the current ledger and the zero-qty archive
  markers now recorded for empty items (see
  [ARCHIVE_SWEEP_REDERIVE.md](./ARCHIVE_SWEEP_REDERIVE.md)) — most of the entry
  churn, almost all at zero value;
- `retype_item` now moving cost-ledger sale impact to the retyped subtype;
- cost-ledger-authoritative visible quantities and the single-variant key
  migration.

## Inventory value

Total on-hand inventory value, summed across every item via the cost engine:

| Currency | Main | Branch | Delta |
|---|---:|---:|---:|
| JPY | 821,725.25 | 817,012.65 | **-4,712.60** |
| EUR | 4,794.14 | 4,766.03 | **-28.11** |

The 22 in-both open-value movements (net -1,936 JPY) plus the 143-key migration
account for the total. The largest movements are **quantity** changes at stable
cost, not cost changes:

| Key | On hand m -> b | Open value JPY m -> b | Δ |
|---|---:|---:|---:|
| `4542804112917` Amifa Origami Paper Sakura | 17 -> 6 | 1105 -> 390 | -715 |
| `4542804109153Green` Amifa Panda Envelopes | 9 -> 9 | 585 -> 0 | -585 |
| `4952270242597` Furukawa Hedgehog Sticky Notes | 9 -> 8 | 1908 -> 1696 | -212 |
| `4542804112832Cherry` Amifa Fruit Mini Card Set | 9 -> 6 | 585 -> 390 | -195 |
| `4952270287086` Furukawa Neko Cat Stationery | 8 -> 7 | 1552 -> 1358 | -194 |

(The remaining 17 are ±65 — single units of ¥65 items moving in/out.)

## Average cost changes

Two different "cost change" questions, reported separately:

**Final on-hand average** (cost of units currently in stock) — **1 item** changes:

| Key | On hand m -> b | Avg JPY m -> b | Avg EUR m -> b |
|---|---:|---:|---:|
| `4542804109153Green` Amifa Panda Envelopes | 9 -> 9 | 65 -> 0 | 0.3851 -> 0 |

**Within-ledger received cost basis** (qty-weighted unit cost of all received
lots, regardless of what is still on hand) — **5 items** change. This catches
per-lot unit-cost moves that the final open average masks: e.g.
`4542804108637Beige`'s recount lot goes ¥0 -> ¥65 on the branch, but its open
position still blends to ¥65 on both sides (main reaches ¥65 via the archive
carry), so only the received-basis metric sees it.

| Key | Recv qty m -> b | Avg recv JPY m -> b | Avg recv EUR m -> b |
|---|---:|---:|---:|
| `4542804109153Green` Amifa Panda Envelopes | 29 -> 15 | 51.55 -> 0 | 0.3054 -> 0 |
| `4542804108637Pink` Amifa Pétale Floral Stickers | 12 -> 14 | 43.33 -> 18.57 | 0.2567 -> 0.11 |
| `4542804108637Beige` Amifa Pétale Floral Stickers | 18 -> 14 | 28.89 -> 46.43 | 0.1712 -> 0.2751 |
| `4542804108637Yellow` Amifa Pétale Floral Stickers | 14 -> 16 | 37.14 -> 24.38 | 0.2201 -> 0.1444 |
| `4542804109153Red` Amifa Panda Envelopes | 30 -> 24 | 36.83 -> 32.5 | 0.2182 -> 0.1926 |

Both are the Amifa Order 2 family (zeroed-quantity stock order whose cost lots
move between bare-JAN and subtyped keys and whose recount lots get costed
differently). All 143 single-variant key migrations carried their cost across
intact (0 changes on either metric).

## History churn

`historyKeys 1542 -> 1487` (-55); 1399 keys changed, +2415 / -3409 entries. The
churn is expected from replaying the same actions under changed semantics:

- "Subtype update ignored (identical)" no-op entries are no longer emitted for
  many Shopify-import cases (the bulk of the removals);
- archive history lines now report cost-ledger-authoritative quantities (e.g.
  `Archived … (Qty: 2 -> Qty: 1)` as negatives are resolved);
- 143 single-variant key migrations move history from subtyped to bare keys.

## Orders

`orderLines +15`: previously-unmatched Shopify bare SKUs now bind to the single
local item for their JAN (e.g. orders `shopify:13245121266046`,
`shopify:13082719355262`). `shopifyExceptions 2 -> 0` — both stored Shopify
binding exceptions are resolved.

## What changed since the Jun 14 report

The replayed-state deltas above are largely the same shape as Jun 14 (key
normalization + cost-ledger-authoritative quantities + Japan Festival recount).
New on the branch since then, and reflected here:

- **Archive sweep re-derivation + empty-item marker** — archive sales now sweep
  the re-derived pre-archive on-hand and record a marker even at qty 0; this
  corrected ten items to 0 and is the bulk of the cost-ledger entry churn.
- **Oversold surface (read-only)** — `ledgerOversold` + the `/unpriced`
  "Oversold Items" split (needs-attention vs historical). Detection only; it
  does **not** change replayed state, so it contributes nothing to this diff.
- **Over-take detection** — `scripts/find-live-event-overtakes.ts` and its
  investigation doc; analysis only.

## Review notes

Expected / intentional:

- Single-variant Shopify bare SKUs attach to the one local item; orders and
  exceptions follow.
- Negative on-hand from oversells is clamped to 0 and surfaced as an oversold
  exception instead of a silent negative count.
- Archive sweeps and retype moves are now cost-ledger-authoritative.

Worth a reviewer's eye:

- Inventory value falls **-4,712.60 JPY / -28.11 EUR**, almost entirely from
  on-hand quantity corrections (oversell clamps, the Japan Festival recount, the
  key migration). Only **1** item's final on-hand average cost moves
  (`4542804109153Green`, 65 -> 0), but **5** items' within-ledger received cost
  basis moves (the Amifa Order 2 family) — see Average cost changes.
- The Amifa Order 2 stock-order cost exceptions remain the one open stock-order
  review item carried over from the Jun 14 report.
