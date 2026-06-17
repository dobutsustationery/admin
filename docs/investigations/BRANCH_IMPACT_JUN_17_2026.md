# Branch Impact Report: `analysis/jun-04-broadcast-cleanup` vs `main`

Generated 2026-06-17 from the June 11 production backup. HEAD `494f699`, main
`460e3cc`, **32 commits**. Supersedes
[BRANCH_IMPACT_JUN_15_2026.md](./BRANCH_IMPACT_JUN_15_2026.md) — adds the
zero-cost-merge re-pricing, the uncosted-remainder forward-move, and the
re-priced-¥0 cost-exception filter that landed since.

Command:

```sh
npm run blast-radius -- compare --base main --head working-tree \
  --backup ../production-backup-jun-11 --name main-vs-branch-jun-17
```

Both replays used the same action log (`41771 -> 41771`, 0 replay errors).
Artifacts: `.blastradius/runs/main-vs-branch-jun-17/`.

## What the branch changes (by theme)

- **Shopify listing identity** (`1c23aa4`, `3061bde`, `28171f6`, `55a6c84`,
  `ea5f468`) — single-variant `JAN+subtype` → bare-`JAN` normalization, bare-SKU
  order-line binding, and listing-mismatch reconciliation.
- **Cost ledger authoritative + retype** (`26b788f`, `e9d602d`) — cost ledger is
  authoritative for visible qty; retypes record cost-ledger sales.
- **Archive-sweep re-derivation** (`646105b`, `26cee8a`, `ef037b1`, `e4dec7b`,
  `18ca46c`, `8237a4e`, `3bc8f70`) — archive sales re-derive their sweep from the
  current ledger; markers recorded even for empty items; audit annotations
  surfaced in item history.
- **Oversold detection** (`cd3e4e5`, `ab2689a`, `4f57ddf`, `8b63dae`, `65b88db`,
  `808c132`) — read-only surfacing of items sold beyond receipts.
- **Zero-cost-merge** (`eea96a9`, `234290f`, `2c706d5`) — detect ¥0/priced blends;
  a priced receipt landing on uncosted on-hand adopts the incoming cost.
- **Uncosted-remainder move** (`a402baa`) — a restock onto a partially-consumed
  ¥0 creation lot moves the open remainder forward to the order date.
- **Re-priced-¥0 exception filter** (`494f699`) — `/unpriced` no longer flags ¥0
  scans the above already resolved to a correct basis.
- **Tooling / docs** (`41430ad`, `6cbee34`, `6fb1193`, `3a73651`, `43f46c8`,
  `0e0d575`, `ea5b3be`) — blast-radius tooling, staging reset tools, investigations.

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
| shopifyExceptions | 2 | 0 | -2 |

## Item identity migration

Single-variant Shopify-imported keys normalize from `JAN + subtype` to bare
`JAN` where the JAN is unambiguous: **143 keys added, 143 removed** (mirrored in
the cost ledger). The bare keys also let previously-unmatched Shopify order lines
bind — the source of `orderLines +15` and `shopifyExceptions 2 -> 0`. Aggregated
by JAN this nets to zero value; it is display/key churn, not value movement.

## Visible on-hand changes (11 keys, 7 qty)

| Key | Qty m -> b | Shipped | On hand m -> b | Δ |
|---|---:|---:|---:|---:|
| `4589469849758` Gacha Blind Mystery Box | 10 -> 17 | 17 | **-7 -> 0** | +7 |
| `4542804080773Cream` Bag Shopping Botanical | 12 -> 18 | 18 | **-6 -> 0** | +6 |
| `4991685190055Pink` Iwako Maiko Eraser | 5 -> 10 | 8 | -3 -> 2 | +5 |
| `4991685190055White` Iwako Maiko Eraser | 5 -> 10 | 4 | 1 -> 6 | +5 |
| `4991685201126Black` Iwako Lucky Cat Eraser | 5 -> 10 | 6 | -1 -> 4 | +5 |
| `4991685201126White` Iwako Lucky Cat Eraser | 5 -> 10 | 8 | -3 -> 2 | +5 |
| `4542804149982Yellow` Amifa Chinoiserie A5 Notebook | 2 -> 4 | 4 | -2 -> 0 | +2 |

**Reading:** all seven were **negative on hand on `main`** (last-write count let
shipped exceed qty). The branch makes the cost ledger authoritative and clamps
visible on-hand at zero. The two that clamp to exactly 0 (Gacha, Cream) are
genuine **oversells** now surfaced on `/unpriced` (see
[OVERSOLD_ITEMS.md](./OVERSOLD_ITEMS.md)); the four erasers recovered to a
positive count (found stock).

Plus four non-qty field changes: `4542804080872Blue` cost `45.88 -> 65` and
`4542804080872Red` cost `48.75 -> 65` (zero-cost-merge re-pricing — a ¥0 creation
lot adopting the priced basis), `4542804109153Red` cost rounds
`64.99999999999999 -> 65`, and `4542804113471` is the single-variant cleanup
(handle/subtype blanked).

## Cost ledger

`692` existing keys changed; entry deltas `+3331 / -1950`; **23** keys have a
materialised open-value change (valued with the perpetual weighted-average cost
engine). Drivers: archive sweeps re-derived from the current ledger and the
zero-qty archive markers (most of the entry churn, almost all at zero value);
`retype_item` moving cost-ledger sale impact to the retyped subtype; the
uncosted-remainder move splitting a ¥0 lot into a remove + re-add pair; and the
single-variant key migration.

## Inventory value

Total on-hand inventory value, summed across every item via the cost engine:

| Currency | Main | Branch | Delta |
|---|---:|---:|---:|
| JPY | 821,725.25 | 817,012.65 | **-4,712.60** |
| EUR | 4,794.14 | 4,766.03 | **-28.11** |

The largest movements are **quantity** changes at stable cost, not cost changes:

| Key | On hand m -> b | Open value JPY m -> b | Δ |
|---|---:|---:|---:|
| `4542804112917` Amifa Origami Paper Sakura | 17 -> 6 | 1105 -> 390 | -715 |
| `4542804109153Green` Amifa Panda Envelopes | 9 -> 9 | 585 -> 0 | -585 |
| `4952270242597` Furukawa Hedgehog Sticky Notes | 9 -> 8 | 1908 -> 1696 | -212 |
| `4542804112832Cherry` Amifa Fruit Mini Card Set | 9 -> 6 | 585 -> 390 | -195 |
| `4952270287086` Furukawa Neko Cat Stationery | 8 -> 7 | 1552 -> 1358 | -194 |

## Average cost changes

**Final on-hand average** (cost of units currently in stock) — **2 items**:

| Key | On hand m -> b | Avg JPY m -> b | Avg EUR m -> b |
|---|---:|---:|---:|
| `4542804108644Purple` Amifa Literary Stickers | 0 -> 0 | **0 -> 65** | 0 -> 0.3851 |
| `4542804109153Green` Amifa Panda Envelopes | 9 -> 9 | **65 -> 0** | 0.3851 -> 0 |

`Purple` 0 → ¥65 is the uncosted-remainder move pricing a previously-uncosted
position (a *correction*); `Green` 65 → 0 is the oversold/archive resolution.

**Within-ledger received cost basis** (qty-weighted unit cost of all received
lots) — **11 items**, all the Amifa zeroed-order family whose ¥0 creation lots,
recount lots, and moved/re-priced lots redistribute which lot carries the basis:

| Key | Recv qty m -> b | Avg recv JPY m -> b |
|---|---:|---:|
| `4542804108644Purple` Amifa Literary | 9 -> 9 | 0 -> 57.78 |
| `4542804109153Green` Amifa Panda | 29 -> 15 | 51.55 -> 0 |
| `4542804089301Pink` Amifa Wrapping Clear | 22 -> 22 | 65 -> 35.45 |
| `4542804108644Brown` Amifa Literary | 12 -> 12 | 65 -> 43.33 |
| `4542804108637Beige` Amifa Pétale | 18 -> 14 | 28.89 -> 46.43 |
| `4542804108644Blue` Amifa Literary | 18 -> 10 | 65 -> 52 |
| `4542804113693` Amifa Kawaii Pattern Sheet | 121 -> 91 | 32.23 -> 21.43 |
| `4542804108637Pink` Amifa Pétale | 12 -> 14 | 43.33 -> 37.14 |
| `4542804108637Yellow` Amifa Pétale | 14 -> 16 | 37.14 -> 32.5 |
| `4542804109153Red` Amifa Panda | 30 -> 24 | 36.83 -> 32.5 |
| `4542804089301Blue` Amifa Wrapping Clear | 34 -> 22 | 38.24 -> 35.45 |

These move *which lots* carry the basis; the final on-hand average for these
stays correct (¥65 where applicable), which is why only 2 items show a final-avg
change and inventory value moves only `-4,712.60` (quantity-driven). See
[INVENTORY_VALUE_DELTA_VS_55A6C84.md](./INVENTORY_VALUE_DELTA_VS_55A6C84.md) for
the date-by-date timeline.

## History churn

`historyKeys 1542 -> 1487` (-55); 1399 keys changed, +2415 / -3414 entries:
"Subtype update ignored (identical)" no-ops dropped for Shopify-import cases (the
bulk of removals), archive lines now reporting cost-ledger-authoritative
quantities, and the 143 single-variant key migrations moving history to bare keys.

## Orders

`orderLines +15`: previously-unmatched Shopify bare SKUs now bind to the single
local item for their JAN. `shopifyExceptions 2 -> 0` — both stored binding
exceptions resolved.

## New since the Jun 15 report

- **Zero-cost-merge re-pricing** (`234290f`) — a priced receipt landing on
  uncosted on-hand adopts the incoming cost instead of diluting toward ¥0
  (e.g. `4542804080872` Blue/Red → ¥65). Final-avg changes 1 → 2.
- **Uncosted-remainder move** (`a402baa`) — fixes the stranded ¥0 creation lot
  on partially-consumed zeroed-order subtypes (e.g. Amifa Pétale Pink/Yellow);
  received-basis changes 5 → 11; no inventory-value or quantity impact.
- **Re-priced-¥0 exception filter** (`494f699`) — `/unpriced` UI only; no
  replayed-state effect.

## Review notes

Expected / intentional:

- Single-variant bare-SKU attachment; orders and exceptions follow.
- Negative on-hand from oversells clamped to 0 and surfaced as oversold
  exceptions rather than silent negatives.
- Archive sweeps and retype moves are cost-ledger-authoritative.
- ¥0 creation lots adopt the priced basis (zero-cost-merge / move).

Worth a reviewer's eye:

- Inventory value falls **-4,712.60 JPY / -28.11 EUR**, almost entirely from
  on-hand quantity corrections; only **2** items' final on-hand average moves
  (one of which, `4542804108644Purple` 0 → 65, is a correction), and **11**
  items' within-ledger received basis shifts (the Amifa zeroed-order family).
- The Amifa Order 2 stock-order cost exceptions remain the one open stock-order
  review item; Beige's recount still over-matches that order (a known residual —
  the recount-attachment / "late scan" issue, not addressed by the move).
