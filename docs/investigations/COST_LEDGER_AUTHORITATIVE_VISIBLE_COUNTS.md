# Reducer experiment: cost-ledger authoritative visible counts

Regenerated: 2026-06-14

Backup: `../production-backup-jun-11/firestore-export.json`

Baseline: `ea5f468` (`Fix Shopify listing identity reconciliation`), the parent of the cost-ledger-authoritative reducer change.

Implementation replayed: current branch state after `26b788f` plus the current `retype_item` ledger-sale fix in the working tree.

Method: replayed the same backup twice through `rootReducer`, once in a detached baseline worktree and once in the current working tree, then compared the materialized inventory slice.

Artifacts:

- `/tmp/cost-ledger-authority-before.json`
- `/tmp/cost-ledger-authority-after.json`
- `/tmp/cost-ledger-authority-summary.json`

## Summary

| Metric | Before | After | Delta |
|---|---:|---:|---:|
| Broadcast actions replayed | 41,771 | 41,771 | 0 |
| Replay errors | 0 | 0 | 0 |
| Inventory items | 1,306 | 1,306 | 0 |
| Cost ledger keys | 1,305 | 1,305 | 0 |
| Items with negative visible on-hand | 9 | 0 | -9 |
| Items with changed visible qty/on-hand | - | 25 | +25 |
| Cost ledger keys changed | - | 191 | +191 |
| Ledger-only changed keys | - | 184 | +184 |
| Retype ledger sale rows | 0 | 497 | +497 |
| Retype ledger keys | 0 | 188 | +188 |

The current implementation resolves every negative on-hand item found in the baseline replay. Most ledger changes are explicit `retype_item` sale rows; most of those do not change visible inventory counts, but they make the order-line move auditable in the cost ledger.

## Visible Count Changes

| Item | Description | Qty before -> after | Shipped before -> after | On hand before -> after | Delta |
|---|---|---:|---:|---:|---:|
| `4542804112917` | Amifa Design & Origami Paper - Sakura Themes | 13 -> 24 | 7 -> 7 | 6 -> 17 | +11 |
| `4902778185650` | Mechanical Pencil Mitsubishi Kurotoga 0.7mm Blue | 0 -> 10 | 0 -> 0 | 0 -> 10 | +10 |
| `4589469849758` | Gacha Blind Mystery Box - Neko Cat Collectibles Set 2 | 10 -> 17 | 17 -> 17 | -7 -> 0 | +7 |
| `4542804080773Cream` | Bag Shopping Botanical | 12 -> 18 | 18 -> 18 | -6 -> 0 | +6 |
| `4991685190055Pink` | Iwako Japan Maiko Eraser | 5 -> 10 | 8 -> 8 | -3 -> 2 | +5 |
| `4991685190055White` | Iwako Japan Maiko Eraser | 5 -> 10 | 4 -> 4 | 1 -> 6 | +5 |
| `4991685201126Black` | Iwako Lucky Cat Eraser | 5 -> 10 | 6 -> 6 | -1 -> 4 | +5 |
| `4991685201126White` | Iwako Lucky Cat Eraser | 5 -> 10 | 8 -> 8 | -3 -> 2 | +5 |
| `4542804149982Yellow` | Amifa French Chinoiserie Saddle-stich Lined A5 Notebook | 2 -> 4 | 4 -> 4 | -2 -> 0 | +2 |
| `4969757159187Blue` | Mini Card set Fleurage with transparent Envelope | 0 -> 2 | 0 -> 0 | 0 -> 2 | +2 |
| `4542804085181Beige` | Amifa Custom Note Frame Stickers (48) | 6 -> 5 | 2 -> 2 | 4 -> 3 | -1 |
| `4542804119923Pink` | Masking Take 30mm x 4m | 0 -> 1 | 0 -> 0 | 0 -> 1 | +1 |
| `4562136651236Green` | Fabric Pouch 23x23cm Birds | 0 -> 1 | 0 -> 0 | 0 -> 1 | +1 |
| `4562136651557Grey` | Fabric Pouch 19x15.5cm Birds | 0 -> 1 | 0 -> 0 | 0 -> 1 | +1 |
| `4580424665277` | Letter set | 0 -> 1 | 0 -> 0 | 0 -> 1 | +1 |
| `4902505660405` | Pilot ILMILY 0.5mm Nuance Black Pen Collection | 10 -> 11 | 11 -> 11 | -1 -> 0 | +1 |
| `4902505660412` | Pilot ILMILY 0.5mm Nuance Black Pen Collection | 10 -> 11 | 11 -> 11 | -1 -> 0 | +1 |
| `4902505660450` | Pilot ILMILY 0.5mm Nuance Black Pen Collection | 10 -> 11 | 11 -> 11 | -1 -> 0 | +1 |
| `4952270242597` | Furukawa Kawaii Hedgehog Sticky Notes | 9 -> 10 | 1 -> 1 | 8 -> 9 | +1 |
| `4952270287086` | Furukawa Neko Cat Washi Paper Stationery Set Kawaii | 9 -> 10 | 2 -> 2 | 7 -> 8 | +1 |
| `4968583237502Marie` | Plastic Clip Aristocats | 0 -> 1 | 0 -> 0 | 0 -> 1 | +1 |
| `4974052670381` | Shachihata Iromoyo Oil-Based Mini Ink Pad - Desk Gems | 0 -> 1 | 0 -> 0 | 0 -> 1 | +1 |
| `4974052670404` | Shachihata Iromoyo Oil-Based Mini Ink Pad - Desk Gems | 0 -> 1 | 0 -> 0 | 0 -> 1 | +1 |
| `4974052670619` | Shachihata Iromoyo Oil-Based Mini Ink Pad - Desk Gems | 0 -> 1 | 0 -> 0 | 0 -> 1 | +1 |
| `4977564720711` | Plus Deco Rush Decoration Tape 6mm x 4m | 9 -> 10 | 1 -> 1 | 8 -> 9 | +1 |

## Negative On-Hand Cases Resolved

All nine baseline negative-on-hand items become non-negative:

| Item | Before on hand | After on hand |
|---|---:|---:|
| `4542804080773Cream` | -6 | 0 |
| `4542804149982Yellow` | -2 | 0 |
| `4589469849758` | -7 | 0 |
| `4902505660405` | -1 | 0 |
| `4902505660412` | -1 | 0 |
| `4902505660450` | -1 | 0 |
| `4991685190055Pink` | -3 | 2 |
| `4991685201126Black` | -1 | 4 |
| `4991685201126White` | -3 | 2 |

No item becomes newly negative.

## Retype Ledger Rows

The current reducer records cost-ledger sale movement for `retype_item`:

- 250 `retype_item` actions replayed.
- 497 retype ledger sale rows created.
- 188 item ledgers receive at least one retype sale row.
- 244 actions have a normal reverse/apply pair with zero net inventory-unit movement.
- 6 actions are not a perfect reverse/apply pair.

The six non-perfect pairs are explainable and should be reviewed separately rather than silently ignored:

| Action | Rows | Why it is non-perfect |
|---|---|---|
| `dLjtZX0AOusuJgRjUNwA` | apply `+1` to `4542804112832Strawberry` | Source key `4542804112832Orange` is missing at replay time, so only the destination can be recorded. |
| `Zc9kQIydpBcUi5xha8QT` | apply `+3` to `4542804112832Cherry` | Source key `4542804112832Orange` is missing at replay time, so only the destination can be recorded. |
| `cj3PjeRrWO4W00Ti2LDA` | apply `+1` to `4542804130904Swan` | Source key `4542804130904Purple` is missing at replay time, so only the destination can be recorded. |
| `gZZWijedhunMcyd7wq8O` | reverse `-0.111111` from `4549131901542Pink Rabbit`, apply `+0.1` to `4549131901542Green Bear` | Fractional pre-festival piece counts differ between the source and destination subtypes. |
| `Tsjfj719usqcqlMoku6K` | reverse `-0.2` from `4540457802704Pink`, apply `+1` to `4540457802704Blue` | Fractional pre-festival piece handling differs between the source and destination subtypes. |
| `x8w6zb0uJH1UUgZsOWAS` | reverse `-0.2` from `4540457802704Pink`, apply `+1` to `4540457802704Blue` | Fractional pre-festival piece handling differs between the source and destination subtypes. |

## Ledger Value Changes

A simple materialized-ledger comparison finds 17 keys whose final open ledger quantity or value changes. The total final open ledger value moves by `-1285 JPY`.

Most of these changes are caused by the new retype sale rows making old order-line moves visible in the ledger. Several affected rows have zero value on both sides, so they change ledger quantity without changing value.

| Item | Final ledger before | Final ledger after |
|---|---:|---:|
| `4542804108620Pink` | 8 units / 130 JPY | 5 units / 0 JPY |
| `4542804108637Beige` | 3 units / 0 JPY | 3 units / 195 JPY |
| `4542804108637Pink` | 2 units / 0 JPY | 2 units / 130 JPY |
| `4542804108637Yellow` | 5 units / 0 JPY | 4 units / 260 JPY |
| `4542804109153Green` | 9 units / 585 JPY | 9 units / 0 JPY |
| `4542804109153Red` | 7 units / 455 JPY | 7 units / 0 JPY |
| `4542804128352Brown` | 13 units / 700 JPY | 13 units / 0 JPY |

## Interpretation

The prior version of this document understated the current blast radius because it only covered the first cost-ledger-authoritative reducer change. With the current `retype_item` ledger fix included, visible inventory changes are narrower than the old 35-item table, but ledger auditability expands substantially: historical retype moves now appear as explicit ledger sale rows.

The remaining follow-up questions are the six non-perfect retype pairs. Three are caused by missing source keys at replay time. Three are caused by fractional loose-piece conversion differences between source and destination subtypes.
