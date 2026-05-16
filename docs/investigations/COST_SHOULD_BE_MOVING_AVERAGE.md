# Inventory cost is last-write-wins; it must be a weighted moving average

## The question

"Where did the cost for `4902778028179Black` originally come from? If
it is in two orders we have to average across the orders, not
overwrite." — and the general principle: 10 units @ ¥100, sell 2
(value ¥800), buy 10 @ ¥75 ⇒ value ¥1,550, per-unit ¥1,550/18 ≈
¥86.1 — **not** ¥75, **not** ¥100.

## Answer: it is exactly that case

`4902778028179` (Uni Kuru Toga M5 Black) was purchased in **two
separate supplier orders**:

| Lot | Source CSV | Unit cost | Qty |
|---|---|--:|--:|
| 1 | `Kanegan #1 (Order 1)` (file0) — `unit price (yen)` = `282.70` | **¥282.70** | ~10 (estimated amt 2,570 ÷ 257) |
| 2 | `Kanegan #3 (Order 5, new stock)` (file4) — `Total Wholesale Amount YEN` 2,430, pcs 10, unit 1 | **¥243.00** (2,430 ÷ (10×1)) | 10 |

Current code (and PR #134 as written) **overwrites**: the later order
wins ⇒ cost becomes ¥243. That is wrong. With no sales the correct
weighted cost is `(10×282.70 + 10×243) / 20 = ¥262.85`; accounting for
the 7 units already shipped from lot 1 before lot 2 arrived it is
≈ ¥252 (depends on receipt/shipment ordering). Neither input value is
the right answer.

All five "re-valued" items from #134 are the same two-lot pattern:

| JAN (subtype) | Lot 1 | Lot 2 (Order 5 derived) | overwrite (now) | weighted avg* |
|---|--:|--:|--:|--:|
| 4902778028179 Black | ¥282.70 ×~10 (Ord1) | ¥243 ×10 | 243 | ≈262.85 |
| 4902778028186 Silver | ¥282.70 ×~10 (Ord1) | ¥243 ×10 | 243 | ≈262.85 |
| 4902778028216 | ¥282.50 ×~? (Ord1) | ¥243 ×10 | 243 | ≈ blend |
| 4952270287321 Cat in Mug | ¥194 ×5 (Ord3) | ¥97 ×20 (1,940÷(10×2)) | 97 | (5×194+20×97)/25 = **116.4** |
| 4977564637699 Green | ¥385 ×20 (Ord3) | ¥201 ×40 (8,040÷(20×2)) | 201 | (20×385+40×201)/60 = **262.33** |

\* simple receipt-weighted average ignoring intervening sales; the
true perpetual figure also depends on units sold between receipts.

## The general defect

This is **not** specific to these 5 — it is every JAN purchased in
more than one order. Cost is set by last-write-wins on *every* path:

- `computeOrderImportBatch` MATCH branch:
  `if (item.cost !== undefined) newItem.cost = item.cost;` —
  overwrite with the latest order's unit cost.
- `mapOrderToInventory` (NEW) — sets cost from the single row.
- `mapShopifyToInventory` / Shopify import — overwrite.
- `update_field` cost — overwrite.

None of these blend with the cost of stock already on hand. So the
reported `cost` is "the unit cost of whichever receipt was processed
last", not the value of the inventory. Anything downstream that uses
`cost` for inventory valuation, margin, or COGS is wrong for every
multi-receipt item.

## Correct model — perpetual weighted-average (moving average) cost

Maintain, per inventory item, the **on-hand value** alongside qty (or
recompute average cost on each receipt):

- **Receipt** of `qtyIn` units at lot unit cost `cIn`:
  `newAvg = (onHandQty·avgCost + qtyIn·cIn) / (onHandQty + qtyIn)`
  (guard `onHandQty + qtyIn > 0`).
- **Shipment / sale** of `qtyOut`: qty decreases; **avgCost
  unchanged**; on-hand value decreases by `qtyOut·avgCost` (this is
  COGS).
- **Archive / zeroing** (`archive_inventory` sets qty 0): resets
  on-hand value to 0; the next receipt establishes a fresh average.
- A direct `update_field(cost)` or Shopify cost should be treated as
  an explicit **correction** of `avgCost` (not a receipt) — or
  disallowed, TBD with the owner.

This is standard perpetual-inventory moving-average valuation and
matches the user's worked example exactly
(`(800 + 10·75)/18 = 86.1…`).

## Open questions (need owner input before implementing)

1. **Lot quantities.** Order-import qty parsing is per-file and
   schema-dependent (file0 has no clean pcs column; qty is inferred
   from `estimated amount ÷ unit price`). Reliable per-receipt qty is
   required for a correct average. Which column is authoritative per
   supplier?
2. **Non-order cost writes.** Are Shopify-import / `update_field`
   cost values *corrections* (set avg directly) or should they be
   ignored once order-import lots exist?
3. **Historical bootstrap.** For items whose first receipts predate
   reliable cost data, what is the opening average?
4. **Scope.** This changes `cost` for many items by design — the
   before/after "diff = 0" guarantee no longer applies; validation
   must be against hand-computed expected averages + owner sign-off.

## Recommendation

1. **Hold PR #134** (bucket-B derived cost via overwrite). Its
   *derivation* of a per-unit lot cost from `Total Wholesale ÷
   (PCS×Unit)` is correct and reusable — but feeding it through the
   **overwrite** path makes the 5 flagged items *more* wrong, not
   less. The derived value should become a *lot input* to the
   moving-average, not a replacement of the running cost.
2. Treat moving-average cost as its own work item: a small design
   (state shape: add `onHandValue` or `avgCost` semantics), then
   change every receipt path to blend, with shipments reducing value
   at avg. Validate on `production-backup-may-16` against
   hand-computed averages for the 5 above (and a sample of other
   multi-order JANs), with owner sign-off on the accounting method.
3. Fix A (#133, cost carried onto NEW items) is still correct and
   independent — it provides the lot cost the average will consume.

## Reproduction

```bash
bun run /tmp/trace-cost-history.ts   # state-change trace for the 5 keys
# + the per-source CSV lot table in this PR's history
```
