# Branch Impact Report: `analysis/jun-04-broadcast-cleanup`

Generated on 2026-06-14 from the June 11 production backup.

Command:

```sh
npm run blast-radius -- compare --base main --head working-tree --backup ../production-backup-jun-11 --name main-to-current-working-tree-jun-11
```

Artifacts:

- Report: `.blastradius/runs/main-to-current-working-tree-jun-11/report.md`
- Base snapshot: `.blastradius/runs/main-to-current-working-tree-jun-11/460e3cc5d6a9.json`
- Head snapshot: `.blastradius/runs/main-to-current-working-tree-jun-11/working-tree.json`

The comparison is `main` commit `460e3cc5d6a9104b45787f3f2f7371b70d89d6e5` against the current working tree, which includes the open Japan Festival stocktake reconstruction fix.

Both replays used the same source action log:

- Backup: `../production-backup-jun-11/firestore-export.json`
- Actions: `41771 -> 41771`
- Replay errors: `0 -> 0`

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

## Top-Level State Sections

Changed:

- `archivedInventoryState`
- `hiddenInventoryState`
- `keyIdentity`
- `orderIdToOrder`
- `salesEvents`
- `shopifyExceptions`
- `stockOrderRegistry`
- `idToItem`
- `idToHistory`
- `costLedger`

Unchanged:

- `archivedInventoryDate`
- `etsyExceptions`
- `shopifyUrlToDriveUrl`
- `initialized`

## Item Identity Impact

The branch normalizes single-variant Shopify-imported inventory keys from `JAN + subtype` to bare `JAN` where the JAN is unambiguous.

| Category | Count |
|---|---:|
| item keys added | 143 |
| item keys removed | 143 |
| added keys that are bare JANs | 143 |
| removed keys that were subtyped | 143 |
| existing item records changed | 19 |

Examples:

| Main key | Branch key |
|---|---|
| `4902505451409Pastel` | `4902505451409` |
| `4977564720742Books` | `4977564720742` |
| `4560103149144Bear` | `4560103149144` |
| `4901681382316Standard` | `4901681382316` |
| `4520491375105Bird` | `4520491375105` |

The key migration is mostly a rename, but not perfectly neutral because the new bare keys also let previously unmatched Shopify order lines attach to inventory.

| Metric across migrated keys | Removed keys | Added keys | Delta |
|---|---:|---:|---:|
| qty | 1711 | 1714 | +3 |
| shipped | 304 | 320 | +16 |
| visible on hand | 1407 | 1394 | -13 |

## Visible Inventory Impact

Total visible on hand changed:

| Main | Branch | Delta |
|---:|---:|---:|
| 8081 | 8123 | +42 |

The 19 existing changed item records account for `+55` on hand; the 143 key migrations account for `-13`, for a net `+42`.

Visible on-hand changes for existing keys:

| Key | Qty | Shipped | On hand | Delta |
|---|---:|---:|---:|---:|
| `4902778185650` | 0 -> 10 | 0 -> 0 | 0 -> 10 | +10 |
| `4589469849758` | 10 -> 17 | 17 -> 17 | -7 -> 0 | +7 |
| `4542804080773Cream` | 12 -> 18 | 18 -> 18 | -6 -> 0 | +6 |
| `4991685190055Pink` | 5 -> 10 | 8 -> 8 | -3 -> 2 | +5 |
| `4991685190055White` | 5 -> 10 | 4 -> 4 | 1 -> 6 | +5 |
| `4991685201126Black` | 5 -> 10 | 6 -> 6 | -1 -> 4 | +5 |
| `4991685201126White` | 5 -> 10 | 8 -> 8 | -3 -> 2 | +5 |
| `4542804149982Yellow` | 2 -> 4 | 4 -> 4 | -2 -> 0 | +2 |
| `4969757159187Blue` | 0 -> 2 | 0 -> 0 | 0 -> 2 | +2 |
| `4542804119923Pink` | 0 -> 1 | 0 -> 0 | 0 -> 1 | +1 |
| `4562136651236Green` | 0 -> 1 | 0 -> 0 | 0 -> 1 | +1 |
| `4562136651557Grey` | 0 -> 1 | 0 -> 0 | 0 -> 1 | +1 |
| `4580424665277` | 0 -> 1 | 0 -> 0 | 0 -> 1 | +1 |
| `4968583237502Marie` | 0 -> 1 | 0 -> 0 | 0 -> 1 | +1 |
| `4974052670381` | 0 -> 1 | 0 -> 0 | 0 -> 1 | +1 |
| `4974052670404` | 0 -> 1 | 0 -> 0 | 0 -> 1 | +1 |
| `4974052670619` | 0 -> 1 | 0 -> 0 | 0 -> 1 | +1 |

Other existing item field changes:

- `4542804109153Red`: cost rounds from `64.99999999999999` to `65`.
- `4542804113471`: subtype changes from `Default` to blank and handle changes from `amifa-berry-cherry-wall-stickers-4542804113471` to blank. This is the intentional Shopify import cleanup for single-variant JANs.

## Order Impact

72 orders changed. Most changes are key substitutions from subtyped single-variant keys to bare JAN keys, with the same quantities.

Six orders gained lines, explaining the net `orderLines +15`:

| Order | Lines main -> branch | Added lines |
|---|---:|---|
| `shopify:13245121266046` | 0 -> 6 | `4902505660405`, `4902505660412`, `4902505660429`, `4902505660436`, `4902505660443`, `4902505660450` |
| `shopify:13082719355262` | 2 -> 4 | `4977564720827`, `4977564720742` |
| `shopify:13150305091966` | 1 -> 3 | `4902505673924`, `4902505660450` |
| `shopify:13191023821182` | 0 -> 2 | `4902505465628`, `4902505596698` |
| `shopify:13392027353470` | 1 -> 3 | `4901681413713` qty 2, `4902505451409` qty 1 |
| `shopify:13348110696830` | 7 -> 8 | `4977564690045` |

These are orders where main could not bind one or more Shopify bare SKUs to inventory, but the branch can bind them to an unambiguous single local item.

## Shopify Exceptions

`shopifyExceptions` changed from two orders to none.

Removed exceptions:

| Order | Removed missing bindings |
|---|---|
| `shopify:13150305091966` | `4902505673924`, `4902505660450` |
| `shopify:13082719355262` | `4977564720827`, `4977564720742` |

## Cost Ledger Impact

Cost ledger key migration mirrors the item key migration:

| Category | Count |
|---|---:|
| cost ledger keys added | 143 |
| cost ledger keys removed | 143 |
| existing cost ledger keys changed | 196 |
| entry deltas on existing changed keys | +1942 / -1421 |
| existing keys with materialized open state changed | 21 |

The added/removed ledger keys are the single-variant key normalization. The existing changed ledgers are mainly from:

- retype actions now moving cost-ledger sale impact from the original subtype to the retyped subtype,
- cost-ledger-authoritative visible quantities,
- Japan Festival stocktake reconstruction consuming reconstructed old stock before the recount.

Materialized open value changes among existing ledger keys:

| Key | Open qty | Open value JPY | Avg JPY |
|---|---:|---:|---:|
| `4542804128352Brown` | 13 -> 13 | 700 -> 0 | 53.85 -> 0 |
| `4542804112917` | 10 -> 0 | 650 -> 0 | 65 -> 0 |
| `4542804109153Green` | 9 -> 9 | 585 -> 0 | 65 -> 0 |
| `4542804109153Red` | 7 -> 7 | 455 -> 0 | 65 -> 0 |
| `4542804108637Yellow` | 5 -> 4 | 0 -> 260 | 0 -> 65 |
| `4952270242597` | 9 -> 8 | 1908 -> 1696 | 212 -> 212 |
| `4542804108637Beige` | 3 -> 3 | 0 -> 195 | 0 -> 65 |
| `4952270287086` | 8 -> 7 | 1552 -> 1358 | 194 -> 194 |
| `4542804108620Pink` | 8 -> 5 | 130 -> 0 | 16.25 -> 0 |
| `4542804108637Pink` | 2 -> 2 | 0 -> 130 | 0 -> 65 |
| `4542804085181Beige` | 3 -> 4 | 195 -> 260 | 65 -> 65 |

The generated report reports 21 existing keys with materialized open state changes; the table above lists the open-value changes. The remaining materialized changes are open-quantity or average-only changes with zero open value in the report table.

## Stock Order Registry Impact

One stock order changed:

`1efWnQHQ_sswyQI_Nf2957t5yJycZ0QQD` / Amifa Order 2.

Cost issues changed from `0 -> 5`:

| Issue | JAN | Qty |
|---|---|---:|
| late scan | `4542804108637Beige` | 6 |
| late scan | `4542804108637Pink` | 4 |
| late scan | `4542804108637Yellow` | 6 |
| unmatched row | `4542804108637` | 20 |
| unmatched row | `4542804109153` | 12 |

This is the main remaining review concern in this blast radius: the branch exposes stock-order exceptions for this order that main did not surface.

## History Impact

History keys changed from `1542 -> 1487`, a delta of `-55`. The detailed diff reports:

- changed keys: `1405`
- added history entries: `2418`
- removed history entries: `3412`

The high churn is expected from replaying the same actions under changed reducer semantics:

- archive entries now reflect cost-ledger-authoritative visible quantities,
- subtype-update no-op history entries are no longer emitted for many Shopify import cases,
- 143 single-variant key migrations move history from subtyped keys to bare JAN keys,
- Japan Festival late-scan reconstruction messages now say scans were reclassified as recounts instead of ignored when appropriate.

## Japan Festival Fix Example

For `4542804112917`, main treated the May 4 scan as an ignored late scan and added a reconstructed 24-unit old stock-order receipt. Because the item did not exist at the archive time, no archive sale consumed that reconstructed old stock.

Branch behavior:

- keeps the May 4 scan as a post-festival recount with `receivedQty: 0`,
- reconstructs the 24-unit old receipt at the order date,
- adds an archive sale consuming those 24 old units before the recount,
- leaves the visible count based on the recount.

Visible result:

| Item | Qty main -> branch | Shipped | On hand main -> branch |
|---|---:|---:|---:|
| `4542804112917` | 24 -> 13 | 7 -> 7 | 17 -> 6 |

## Review Notes

Expected/intentional:

- Single-variant Shopify bare SKUs now attach to the one local inventory item for that JAN.
- Historical orders and live-event orders move from single-subtype keys to bare JAN keys where appropriate.
- Previously missing Shopify lines are now present, resolving the two stored Shopify exceptions.
- Cost-ledger retype actions now move sale impact from the original subtype to the new subtype.
- Japan Festival late scans after an archive can be reclassified as stocktake recounts even when the item was first created after the archive.

Needs reviewer attention:

- Amifa Order 2 now has five stock-order cost issues.
- 11 existing cost ledgers have open-value changes in the report table above.
- Total visible on hand increases by 42 units, from the combination of cost-ledger-authoritative quantities, newly matched Shopify lines, and the Japan Festival recount fix.
