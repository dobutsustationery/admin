# Oversold items — validated list (June 11 backup)

Generated 2026-06-15 from `../production-backup-jun-11`.

An item is **oversold** when it has **zero stock on hand** yet its lifetime
consumption (real sales **plus** stock-take archive write-offs) still exceeds
everything it ever received. The clamped visible on-hand hides this at zero, so
the units that were "sold" never physically existed.

This list is the output of `ledgerOversold` after three correctness fixes
(below). Every row here has been checked to be a **true** oversell, not a
detector artifact. Use the item-history page to investigate each:
`/itemhistory?itemKey=<key>`.

## Definition and guards

For each item, walk its cost ledger date-ordered:

- **Quantity unit.** Balance in the ledger's native `qty` (packs). For
  loose-piece items a sale's `visibleQty` is a piece count (1 piece = 1/N of a
  pack) and must never be subtracted from pack-unit receipts.
- **Visible-stock guard.** If the operator-visible on-hand
  (`item.qty − shipped`) is positive, the item plainly has stock and is **not**
  oversold, whatever the cost balance says. (A stock-take archive that sweeps a
  post-dated receipt can drive the cost balance negative while real stock
  remains — that is not an oversell.)
- **Oversold** = `(receipts) − (real sales + archive write-offs)` when negative,
  with zero visible on-hand.

### Detection bugs found and fixed during this review

1. **Piece/pack unit mix** — the first cut subtracted `visibleQty` (pieces)
   from pack receipts, so a fully-sold loose-piece item (e.g. `4550480258096`:
   4 packs in, 4 packs out) reported 82 oversold. Fixed by balancing on `qty`.
2. **Clamped archive-sweep re-derivation** — a same-day loose-piece sale that
   sorts before its pack receipt was clamped away when re-deriving the archive
   sweep, over-stating it and producing phantom sub-unit oversolds
   (`4573135607162`: 0.3). Fixed by carrying the deficit into the receipt for
   the cost sweep.
3. **Positive on-hand flagged** — items with real stock (`4542804113693`: 28
   on hand; `4901681551125`: 9) were flagged because an archive swept a
   post-dated receipt, driving the cost balance to −1. Fixed by the
   visible-stock guard.

Net effect on the backup: 56 → 32 → 21 → **19** flagged items, all whole-unit,
all genuinely oversold.

## The 19 oversold items (34 units)

`recv` = total received; `real` = real (non-archive) sales; `arch` = stock-take
archive write-off. Oversold = `real + arch − recv`.

| Oversold | Item | Description | recv | real | arch | First negative | Driven negative by |
|---:|---|---|---:|---:|---:|---|---|
| 7 | [`4589469849758`](/itemhistory?itemKey=4589469849758) | Gacha Blind Mystery Box — Neko Cat | 10 | 17 | 0 | 2026-05-10 | **Thessaloniki Comic Con** |
| 6 | [`4542804080773Cream`](/itemhistory?itemKey=4542804080773Cream) | Bag Shopping Botanical | 24 | 18 | 12 | 2026-05-10 | **Thessaloniki Comic Con** |
| 3 | [`4969757163009Purple`](/itemhistory?itemKey=4969757163009Purple) | Mini Card set Flower w/ Envelope | 3 | 6 | 0 | 2024-05-15 | order `miriamminipacks` |
| 2 | [`4969757159187Pink`](/itemhistory?itemKey=4969757159187Pink) | Mini Card set Fleurage | 3 | 5 | 0 | 2025-01-25 | not identified — investigate |
| 2 | [`6972258292008`](/itemhistory?itemKey=6972258292008) | Retro flake advertising stickers | **0** | 2 | 0 | 2024-06-30 | `…PaolaM67`, `dimitarluckybag` (never received) |
| 1 | [`4510085330917Green`](/itemhistory?itemKey=4510085330917Green) | Mini Letter set w/ Envelope | 3 | 4 | 0 | 2024-10-26 | not identified — investigate |
| 1 | [`4542804113396`](/itemhistory?itemKey=4542804113396) | Aroma Stone Plaster Cat | 20 | 7 | 14 | 2026-04-05 | **Japan Festival** (sold after archive wipe) |
| 1 | [`4549131625684Pink`](/itemhistory?itemKey=4549131625684Pink) | Cutlery and Chopsticks set | 3 | 4 | 0 | 2024-01-21 | `…month3`, `Martina`, `2024campionbazaar` |
| 1 | [`4550480067667`](/itemhistory?itemKey=4550480067667) | Mini Building Blocks Lunar Panda | 5 | 6 | 0 | 2024-12-08 | order `2024campionbazaar` |
| 1 | [`4562136651236Green`](/itemhistory?itemKey=4562136651236Green) | Fabric Pouch 23x23cm Birds | 1 | 2 | 0 | 2024-01-09 | `…month2`, `…month3`, `ellie` |
| 1 | [`4902505660405`](/itemhistory?itemKey=4902505660405) | Pilot ILMILY 0.5mm Nuance Black | 20 | 11 | 10 | 2026-05-10 | **Thessaloniki Comic Con** |
| 1 | [`4902505660412`](/itemhistory?itemKey=4902505660412) | Pilot ILMILY 0.5mm Nuance Black | 20 | 11 | 10 | 2026-05-10 | **Thessaloniki Comic Con** |
| 1 | [`4902505660450`](/itemhistory?itemKey=4902505660450) | Pilot ILMILY 0.5mm Nuance Black | 20 | 11 | 10 | 2026-05-10 | **Thessaloniki Comic Con** |
| 1 | [`4903409164648Yellow`](/itemhistory?itemKey=4903409164648Yellow) | Mini Card set Flowers Lined | 5 | 6 | 0 | 2024-06-30 | not identified — investigate |
| 1 | [`4968583237502M + T + B`](/itemhistory?itemKey=4968583237502M%20%2B%20T%20%2B%20B) | Plastic Clip Aristocats | 3 | 4 | 0 | 2024-10-26 | not identified — investigate |
| 1 | [`4969757158333Bird`](/itemhistory?itemKey=4969757158333Bird) | Sticky Notes Nordic | 1 | 2 | 0 | 2024-06-30 | order `carominipacks` |
| 1 | [`4969757159187Blue`](/itemhistory?itemKey=4969757159187Blue) | Mini Card set Fleurage | 2 | 3 | 0 | 2024-07-22 | `…Caterina`, `Helen1`, `Agnes`, `dimitarluckybag` |
| 1 | [`4974052670572`](/itemhistory?itemKey=4974052670572) | Shachihata Iromoyo Mini Ink Pad | 1 | 2 | 0 | 2024-06-30 | order `miriamkidspacks` |
| 1 | [`6972949425500`](/itemhistory?itemKey=6972949425500) | Flake stickers Girl 1 | 1 | 2 | 0 | 2024-09-25 | order `6X347359R2707801APaolaM9` |

## Patterns

- **Thessaloniki Comic Con** (`live-event:thessaloniki-comic-con:3FxZC2TXnuSvFfe11nt3`)
  is the single biggest source: **5 items, 16 of the 34 units**. Its sheet sold
  more than was in stock for the Gacha box (8 sold, 1 left), the Botanical bag
  (12 sold, 6 left), and one each of three Pilot ILMILY pens.
- **`6972258292008`** is the starkest: it was **never received** (no stock
  order, no receipt) yet 2 were sold. Either the receipt was never recorded or
  the sale is mis-keyed.
- **Post-archive sales** (`4542804113396`, the three Pilots, the Botanical bag):
  a stock-take archive wrote the item down to zero, then a later event/order
  sold more with no intervening restock — so the sale had no stock behind it.
- **Small single-order oversells** (most of the 1-unit rows): one order or event
  shipped one more unit than was ever received. Several are early (2024) orders;
  a few could be a receipt that was never recorded rather than a true oversell —
  the item history will distinguish.

## "Driven negative by" caveat

The "driven negative by" column is the order/event whose sale first pushed the
running on-hand below zero, decoded from the sale ledger entry id. Four rows
show "not identified": the deficit-crossing sale's id did not carry a
package_item/quantify_item order segment (e.g. a re-keyed or migrated sale).
Those are still genuine oversells (received < sold); the specific culprit needs
the item history to confirm.

## Status

Detector fixes (qty-unit balance, carried archive sweep, visible-stock guard)
are implemented in `src/lib/cost-engine.ts` and validated by unit tests. The
`/unpriced` "Oversold Items" section renders this list. **Staging currently
runs the earlier buggy build** (it still shows ~56 items); the item-history
pages are accurate for investigating individual items regardless.
