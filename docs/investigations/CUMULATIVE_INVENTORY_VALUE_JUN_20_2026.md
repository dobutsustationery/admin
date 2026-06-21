# Cumulative Inventory Value Semantics - 2026-06-20

## Corrected Interpretation

`Cumulative Inventory Value` should increase when inventory value increases because new purchase value has entered the system, without subtracting later sales.

The first attempted fix counted positive receipt quantity directly. That was incomplete: a priced receipt can also reprice existing zero-cost on-hand stock, increasing inventory value beyond the value of the receipt row itself. The corrected implementation counts receipt-driven value increases from the same walk used for current inventory value, plus any value assigned to pending sales that are costed by a later receipt.

The important exception is stocktake/recount rows. A recount can restore current inventory value after an archive sweep, but it does not mean new inventory value was received. Receipts marked `receivedQty: 0` may carry value for current stock valuation and later COGS, but they do not increase cumulative inventory value.

## Staging Reproducer

Backup used:

`../staging-backup-jun-20/firestore-export.json`

Artifacts:

- Reproducer replay: `.blastradius/runs/cumulative-inventory-value-jun20/staging-jun20-current.json`
- Intermediate fix replay: `.blastradius/runs/cumulative-inventory-value-jun20/staging-jun20-alternate-fix.json`
- Final nuanced fix replay: `.blastradius/runs/cumulative-inventory-value-jun20/staging-jun20-nuanced-fix.json`
- Nuanced-vs-intermediate diff: `.blastradius/runs/cumulative-inventory-value-jun20/staging-nuanced-vs-alternate-fix.json`

The row that exposed the bug:

| Date       | Row                            | Value JPY | Sold JPY | Prior cumulative JPY | Corrected cumulative JPY | Prior difference | Corrected difference |
| ---------- | ------------------------------ | --------: | -------: | -------------------: | -----------------------: | ---------------: | -------------------: |
| 2024-07-02 | Amifa #1 / Order 2 stock order |    77,041 |   18,588 |               95,369 |                   95,629 |              260 |                    0 |

The entire `2024-07-02` difference came from one item:

| Item key           | JAN           | Subtype | Cause                                                                                                                                                                                                                        | Delta JPY |
| ------------------ | ------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------: |
| 4542804108637Beige | 4542804108637 | Beige   | A reconstructed 4-unit Order 2 receipt at ¥65 landed on 4 existing zero-cost units. Current inventory value increased by 8 × ¥65 = ¥520, while the prior cumulative calculation counted only the 4 new receipt units = ¥260. |      +260 |

Raw staging action:

```text
S4eThXooGyscObNlUr8Q
type: reconstruct_stock_order_late_scan_receipt
orderId: 1efWnQHQ_sswyQI_Nf2957t5yJycZ0QQD
itemKey: 4542804108637Beige
note: Missing Scan
```

## Final Key Rows

The final fix keeps the July 2 correction and removes the Japan festival cumulative-value jump:

| Date       | Row                             | Value JPY | Sold JPY | Cumulative inventory JPY | Difference |
| ---------- | ------------------------------- | --------: | -------: | -----------------------: | ---------: |
| 2024-07-02 | Order 2 stock order             |    77,041 |   18,588 |                   95,629 |          0 |
| 2025-04-30 | Month end before Japan festival |   461,957 |   44,882 |                  506,839 |          0 |
| 2025-05-31 | Month end after Japan festival  |   362,615 |  145,870 |                  506,839 |      1,646 |
| 2026-06-20 | Current                         |   818,103 |  378,122 |                1,194,572 |      1,653 |

The small post-festival residual difference is not the large recount jump; the cumulative inventory value stays flat across the festival month because the recount receipts are now excluded from cumulative increases.

The sold-value adjustment also treats value decreases caused by stocktake/recount restatements as sold/lost inventory value. That removes negative residuals such as `4901681382316` and `4901681382330`; the remaining post-festival residual is now the positive recount/restatement side rather than a net of positive and negative offsets.

## Blast Radius vs Prior Local Fix

The intermediate value-delta fix changed 29 rows versus the prior local fix. The final nuanced fix retains the pre-festival row fixes, but excludes `receivedQty: 0` recount/restatement receipts from cumulative inventory value.

The first five rows move by +¥260, clearing the exact `Value + Cumulative Sold - Cumulative Inventory` mismatch:

| Date       | Row                 | Delta JPY | Prior difference | Corrected difference |
| ---------- | ------------------- | --------: | ---------------: | -------------------: |
| 2024-07-02 | Order 2 stock order |      +260 |              260 |                    0 |
| 2024-07-31 | Month end           |      +260 |              260 |                    0 |
| 2024-08-02 | Order 3 stock order |      +260 |              260 |                    0 |
| 2024-08-31 | Month end           |      +260 |              260 |                    0 |
| 2024-09-30 | Quarter end         |      +260 |              260 |                    0 |

From 2024-10-31 through 2025-04-30 the cumulative delta is +¥3,440, also clearing the visible mismatch on those rows.

Item-level cumulative inventory value increases retained by the final fix:

| Item key            | Delta JPY | Prior cumulative JPY | Corrected cumulative JPY | Description                                            |
| ------------------- | --------: | -------------------: | -----------------------: | ------------------------------------------------------ |
| 4542804114232Blue   |      +724 |                1,464 |                    2,188 | Amifa Greeting Card Set - Twinkle Bloom                |
| 4542804114232Cream  |      +638 |                1,355 |                    1,993 | Amifa Greeting Card Set - Twinkle Bloom                |
| 4542804108606Bear   |      +390 |                2,015 |                    2,405 | Amifa Animal Family Flake Stickers Cute Kawaii (40)    |
| 4542804109153Green  |      +372 |                1,309 |                    1,681 | Amifa Panda Envelopes                                  |
| 4542804080872Blue   |      +325 |                  780 |                    1,105 | Amifa Clear Sticker Flakes Retro Birds and Stamps (30) |
| 4542804112832Cherry |      +293 |                1,398 |                    1,690 | Amifa Fruit Mini Card Set                              |
| 4542804080872Red    |      +276 |                  829 |                    1,105 | Amifa Clear Sticker Flakes Retro Birds and Stamps (30) |
| 4542804108637Beige  |      +260 |                  910 |                    1,170 | Amifa Petale Clear Floral Stickers (30)                |
| 4542804109153Red    |      +251 |                1,235 |                    1,486 | Amifa Panda Envelopes                                  |
| 4542804113693       |       +57 |                5,850 |                    5,907 | Amifa Kawaii Pattern Masking Sheet Stickers (8)        |

## Validation

Focused test:

```text
npx vitest run tests/unit/inventory-value.test.ts
```

Result: 9 tests passed.
