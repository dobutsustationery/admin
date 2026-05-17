# Design: Inventory Cost & Valuation

Status: **DRAFT FOR REVIEW** — implementation begins only after this
design is approved.

---

## 1. Purpose & scope

Define how an inventory item's **cost** is determined, and how the
**total value of inventory** is reported, including:

- a perpetual weighted-average cost that is correct when receipts and
  sales interleave over time;
- historical valuation **as of any date**;
- dual currency: goods are purchased from Japan in **JPY** and paid in
  **EUR**; each receipt's EUR cost is fixed by the exchange actually paid
  for that stock order.

### 1.1 Terminology

A **stock order** is a purchase of inventory from a supplier (recorded by
the `orderImport/*` events), distinct from a customer purchase. Customer
purchases are out of scope and will be renamed "sales" under a separate
design.

Out of scope: how `shipped`/remaining is computed (already correct); the
valuation report UI (§10); the customer-order → "sales" rename.

---

## 2. The core idea: cost lots are derived state

Cost data is **not a new hand-maintained store**. It is materialised by
replaying the existing broadcast action log through the reducers —
exactly like `idToItem`. The only new persisted data are owner edits to
the **stock-order registry** (§7), which are themselves broadcast actions
and replay like everything else.

Consequence: a lot may safely store *computed* values (e.g. EUR unit
cost). If a computation is later found wrong, the fix is a reducer change
plus a schema-version bump → full replay re-materialises every lot
correctly. There is no migration of stored cost data because cost data is
never the source of truth; the action log is.

### 2.1 Per-item cost ledger (the materialised structure)

For each canonical item key, the reducers materialise a single
**date-sorted ledger** interleaving receipts and sales:

```ts
type LedgerEntry =
  | { kind: "receipt"; at: number; seq: number;
      qty: number; unitCostJpy: number; unitCostEur: number }
  | { kind: "sale";    at: number; seq: number; qty: number };

costLedger: { [itemKey: string]: LedgerEntry[] }; // sorted by (at, seq)
```

- `unitCostJpy` and `unitCostEur` are **always numbers, never
  undefined** (§6).
- `at` is a real epoch-ms date, **never null** (§6.1).
- The item's stored `qty`/`shipped` are unchanged; `cost` becomes derived
  (§4) — the ledger is the single source for cost and valuation.

---

## 3. Where lots are materialised (specific reducers)

Receipts and sales enter the ledger at exactly these points; **all
exchange + per-unit cost arithmetic lives only here**, never in UI or
selectors:

| Ledger entry | Reducer / interceptor | File:line |
|---|---|---|
| **receipt** — item creation, scan, bulk import, stock-order delta, split | `applyInventoryUpdate` (the single write chokepoint every item mutation funnels through) | `src/lib/inventory.ts:692` |
| stock-order **pricing context** for the above (stock-order id → totals/date) tagged onto the synthesized `bulk_import_items` | `orderImport/import_batch` interceptor | `src/lib/root-reducer.ts:1081` |
| **sale** — Shopify order | `shopify_order_reconciled` reducer | `src/lib/inventory.ts:1505` |
| **sale** — live event | `liveEventImport/commit_import` interceptor | `src/lib/root-reducer.ts:1315` |
| **sale/write-off** — archive | `archive_inventory` reducer | `src/lib/inventory.ts:2399` |

`applyInventoryUpdate` is the linchpin: item creation, scans,
stock-order quantity deltas, and splits already all pass through it.
It is the one place a **receipt** entry is appended; it reads the
stock-order registry (§7) for the order's `(totalOrderJpy,
totalOrderEur, receiptDate)` and computes the lot's per-unit costs.
The sale reducers append **sale** entries with the event's business
date and quantity.

---

## 4. Cost & valuation engine

Costing method is **perpetual weighted-average**. There is no separate
"merge two lists" step — the ledger is already one interleaved sorted
array. Walking it to a date is the entire engine:

```
onHand=0; avgJpy=0; avgEur=0
for e in costLedger[item] while e.at <= D:        # D = ∞ for "now"
  receipt:  n = onHand + e.qty
            avgJpy = (onHand*avgJpy + e.qty*e.unitCostJpy)/n
            avgEur = (onHand*avgEur + e.qty*e.unitCostEur)/n
            onHand = n
  sale:     onHand = max(0, onHand - e.qty)       # avg unchanged
=> value_at(D) = onHand * avg(JPY|EUR)
```

- **Order matters**: units sold before a re-order arrives cause the
  re-order to blend against the reduced on-hand. Real dates are required;
  the result is not order-independent.
- Current `cost` = walk with `D = ∞`.
- Inventory value as of `D` = `Σ_items onHand_i(D) * avg_i(D)`, in JPY
  and EUR. EUR uses each receipt's paid EUR cost, so it reflects real
  money spent, not a single spot rate.

---

## 5. Receipt construction rules (inside `applyInventoryUpdate`)

- **Item creation / first qty set** → append receipt
  `{ at: parse(creationDate), qty: initialQty, seq: 0,
  unitCostJpy, unitCostEur }` using the matched stock order's costs (or
  the "needs cost" sentinel until known, §6.2).
- **Stock-order import, delta == 0** (original order: cost attach) → set
  the existing first receipt's `unitCostJpy`/`unitCostEur`/`at` from the
  stock order where still unset. No new entry.
- **Stock-order import, delta > 0** (re-order) → append a new receipt
  `{ at: <stock-order receipt date>, qty: delta, unitCostJpy,
  unitCostEur, seq: next }`. Earlier entries are never modified.
- **Stock-order import creating a new item** → first receipt with the
  order's qty/costs/date.
- **Manual receipt** (§7) → append a receipt with owner-supplied
  qty/JPY/EUR/date.
- After any change: recompute `cost` via §4; append one
  `idToHistory[key]` audit entry (qty, JPY/EUR unit costs, source stock
  order, resulting averages).

Re-key/merge/split carry `costLedger` with the item (`migrateCostLots`,
`copyCostLots`).

---

## 6. Per-unit cost — always a number

### 6.1 Date — never null, magic placeholder

`at` is always a real epoch-ms date. When a stock order's true receipt
date is unknown, its entries use the shared constant:

```ts
export const UNKNOWN_RECEIPT_DATE = Date.UTC(2026, 0, 1); // 2026-01-01
```

The engine treats it as an ordinary date. Only the exceptions surface
(§8) recognises the constant, so computation code never branches on
"missing date".

### 6.2 JPY & EUR — computed in the reducer, stored as numbers

- Per-unit JPY of a stock-order line =
  `Total Wholesale Amount YEN ÷ Order Q'ty PCS`.
  `Order Q'ty PCS` is total pieces; `Order Q'ty UNIT` (pieces per pack)
  is **disregarded** (PCS is a multiple of UNIT). An explicit finite
  per-unit price column, if present, is used as-is.
- The stock-order registry (§7) holds the order's absolute
  `totalOrderJpy` and `totalOrderEur`. The reducer computes
  `fx = totalOrderEur / totalOrderJpy` and
  `unitCostEur = unitCostJpy * fx`.
- Both are stored on the entry as plain numbers (safe — derived state,
  §2). Shipping is intentionally **not capitalised**: `fx` comes from
  shipping-inclusive totals but is applied only to goods JPY cost, so the
  shipping share of the payment is left unallocated.
- If a stock-order line has no parseable JPY cost, the reducer writes the
  sentinel `unitCostJpy = 0` (and `unitCostEur = 0`) and the item is
  surfaced as **needs cost** (§8). The field type stays `number`; no
  `undefined`.

---

## 7. Stock-order registry & screen (`/received-inventory`)

The registry maps each stock order → `{ supplier, receiptDate,
totalOrderJpy, totalOrderEur }`, populated by broadcast actions from the
screen:

- Lists every receipt entry (item, qty, date, JPY, EUR, source order).
- Per stock order, edit **receipt date**, **`totalOrderJpy`**,
  **`totalOrderEur`** — one edit rematerialises all that order's entries
  (date + per-unit EUR recompute on replay).
- Record a new physical receipt (qty, JPY cost, date) — a first-class
  receipt entry with a known date.

Until edited, undated orders carry `UNKNOWN_RECEIPT_DATE`; orders missing
totals yield `fx`/EUR = 0 → flagged.

---

## 8. Cost-exceptions surface

Recognises the sentinels and offers the fix:

- **Receipt date unknown** — entry `at === UNKNOWN_RECEIPT_DATE` → set
  the stock order's real date (§7).
- **Exchange unknown** — stock order missing `totalOrderJpy`/
  `totalOrderEur` → enter both.
- **Needs cost** — entry `unitCostJpy === 0` from a line with no
  parseable cost → manual cost entry.

Goal: zero entries with placeholder date, missing exchange, or zero cost.

---

## 9. State & schema

- `costLedger` per item (§2.1); stock-order registry (§7); `cost`
  derived.
- Engine (§4) is pure/deterministic given the ledger.
- Schema-version bump: `cost` is derived; hydrated snapshots discarded
  and re-derived on load (this is also the fix path for any future cost
  formula correction — §2).

---

## 10. Valuation reporting (separate design)

Designed separately. Requirements captured: arbitrary as-of dates chosen
at report time (at least quarterly period-ends), JPY & EUR with per-item
breakdown and CSV export. The §4 `value_at(D)` walk is the primitive that
report consumes.

---

## 11. Confirmed decisions

1. Costing = perpetual weighted-average.
2. Cost lots are **derived state** materialised by reducers during
   replay (§2/§3); storing computed JPY+EUR per entry is safe.
3. All exchange + per-unit arithmetic lives only in the reducers of §3.
4. `unitCostJpy`/`unitCostEur` are always numbers (sentinel `0` +
   exception if source data missing); `at` is always a real date
   (`UNKNOWN_RECEIPT_DATE` placeholder + exception).
5. Exchange = `totalOrderEur / totalOrderJpy` per stock order, applied to
   each item's JPY cost; shipping not capitalised.
6. Shipment business dates: Shopify `created_at`; live-event date;
   archive = action date.
7. Valuation report designed separately; customer-order → "sales" rename
   deferred to its own design.

---

## 12. Validation plan

1. Full-replay cost recomputation on the production backup; only
   re-ordered items change vs. today, to the blended values; hand-check
   an item whose original units sold before its re-order arrived (avg
   reflects reduced on-hand).
2. As-of valuation: two dates straddling a re-order; value moves by
   exactly `Δqty * relevant cost`.
3. Currency: EUR total = `Σ entry qty * unitCostEur`, invariant to later
   FX changes; per-order `fx = totalOrderEur / totalOrderJpy`.
4. Placeholder date: items from undated stock orders surface as
   exceptions; no `UNKNOWN_RECEIPT_DATE` branching in engine/selectors.
5. Determinism: identical state hash across two cold replays.
6. Unit tests: engine (interleaved receipt/sale, currency, zero-cost
   leg, as-of truncation); stock-order per-unit parser
   (`Total Wholesale Amount YEN ÷ Order Q'ty PCS`).
7. E2E: stock-orders screen (date/exchange/receipt); exceptions surface;
   zero-pixel screenshots.

---

## 13. Milestones (post-approval)

- **M1** Cost/valuation engine (§4) + stock-order per-unit parser, pure,
  unit-tested.
- **M2** Ledger materialisation in the §3 reducers + stock-order registry
  (§7) + derived cost + audit; schema bump; full-replay validation.
- **M3** Stock-orders screen `/received-inventory` (date/exchange/
  receipt) + E2E.
- **M4** Cost-exceptions surface (§8) + manual cost entry + E2E.
- **M5** Valuation report (separate design) consuming §4.
