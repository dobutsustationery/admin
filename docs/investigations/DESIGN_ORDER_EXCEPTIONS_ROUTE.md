# Design: Order Exceptions Route

Status: **DRAFT FOR REVIEW** — implementation begins only after this
design is approved.

Builds on `DESIGN_INVENTORY_COST_AND_VALUATION.md` (the cost-lot
ledger, `UNKNOWN_RECEIPT_DATE`, stock-order registry).

---

## 1. Purpose

A UI to find and repair **stock orders** whose imported lots are
incomplete, so the derived inventory cost becomes correct:

- missing/placeholder **receipt date** (`UNKNOWN_RECEIPT_DATE`),
- missing **paid exchange** (order JPY total + order paid total),
- missing **per-unit costs** (zero-cost "needs cost" lots).

Repairs are event-sourced (broadcast actions) and **previewable before
commit**, exactly like the live-event TSV import.

---

## 2. Model refinements (prerequisite)

Two small additions to the cost ledger are required for this route to
target a specific order's lots:

1. **Lot `source` tagging.** When `applyInventoryUpdate` materialises a
   receipt from a stock order, set
   `source = "stockOrder:" + stockOrder.orderId`. Lot 1 from a normal
   creation keeps `source = "<actionType>"`. (`LedgerEntry.source`
   already exists; it is currently unset on the re-order push.)

2. **Auto-registered stock orders.** The order-import interceptor
   already derives `orderId = activeFile.id || activeFile.name`. On
   every `orderImport/import_batch` it records, if absent, a registry
   entry:

   ```ts
   stockOrderRegistry[orderId] = {
     orderId, name,              // activeFile.name (supplier label)
     receivedAt,                 // from prior meta or UNKNOWN_RECEIPT_DATE
     valueOfGoodsJpy?,           // Σ line goods (reconciliation anchor, §5)
     valueOfOrderJpy?,           // invoice total JPY (incl. shipping/tax)
     paidCurrency?, paidAmount?, // the real fact paid (EUR | BGN)
     totalOrderEur?,             // derived: paid normalised to EUR
   }
   ```

   This makes the set of stock orders enumerable without scanning the
   action log in the UI.

These refinements ship first (small, validated by full replay: must
stay byte-identical — `source` is metadata, registry auto-entry is
additive).

---

## 3. Exception classification (pure selector)

A stock order is an **exception** if **any** gap exists:

- `receivedAt === UNKNOWN_RECEIPT_DATE` — date unknown;
- `valueOfOrderJpy` or `totalOrderEur` missing — exchange unknown;
- `valueOfGoodsJpy` missing — goods value (TSV reconciliation anchor)
  unknown;
- ≥1 ledger lot with `source === "stockOrder:"+orderId` and
  `unitCostJpy === 0` — needs cost;
- **override-existing**: a staged TSV would change a lot that already
  has a non-zero `unitCostJpy` (surfaced as its own flag, see §6.3).

`selectOrderExceptions(state)` returns, per order: `orderId`, `name`,
each gap flag, lot count, unpriced-lot count, override-conflict count,
and current date / value-of-goods / value-of-order / paid. Pure;
unit-tested.

---

## 4. Route A — `/order-exceptions` (list)

- Table of orders flagged by §3. Columns: order name, receipt date (or
  "⚠ unknown"), JPY total, paid (EUR), # lots, # needing cost, the
  exception tags.
- Each row has **Fix Order →** linking to Route B.
- A clean order (no exceptions) is not listed; an "all clear" empty
  state when none remain.
- Read-only; no mutations here.

---

## 5. Three money facts + currency

Each stock order carries three distinct monetary facts:

| Fact | Currency | Meaning |
|---|---|---|
| **value of goods** (`valueOfGoodsJpy`) | JPY | Σ of per-line goods cost. The **reconciliation anchor** for the TSV parser (§6.3). |
| **value of order** (`valueOfOrderJpy`) | JPY | Supplier invoice total (goods + shipping/tax). |
| **cost of order** (paid) | EUR or **BGN** | What was actually paid. |

Bulgarian lev is fixed to the euro by currency-board peg:

```ts
export const BGN_PER_EUR = 1.95583; // fixed; 1 EUR = 1.95583 BGN
```

- **State stores EUR only.** The action records the real fact
  `{ paidCurrency: "EUR" | "BGN", paidAmount }`; the reducer derives
  `totalOrderEur = paidCurrency === "BGN" ? paidAmount / BGN_PER_EUR :
  paidAmount`, and stores `paidCurrency`/`paidAmount` verbatim (audit).
  The event log never loses that LEV was paid; downstream state never
  branches on currency.
- **Per-item EUR cost** uses the order's effective rate
  `fx = totalOrderEur / valueOfOrderJpy` applied to each item's JPY
  unit cost. Shipping/tax (the gap between value-of-order and
  value-of-goods) is **not capitalised** into item cost — consistent
  with the cost-and-valuation design. `valueOfGoodsJpy` is used to
  *validate/select* the TSV parse (§6.3), not as the fx denominator.
  (See §10 Q1 to confirm the fx denominator.)

---

## 6. Route B — `/order-exceptions/[orderId]` (Fix Order)

One screen, three independently-committable sections, each with a
preview of the resulting inventory impact:

### 6.1 Receipt date

Date picker → preview: "N lots from this order move from
<old> to <chosen date>; M items re-derive cost (perpetual order
changes)." Commit → `set_stock_order_meta({ orderId, meta: { receivedAt } })`.

### 6.2 Order money facts

Inputs: **Value of goods (JPY)**, **Value of order (JPY)** (invoice
incl. shipping/tax), **Order paid** = amount + currency selector
(EUR | BGN). Preview shows derived `fx` and the per-item EUR cost
change for this order's lots. Commit → `set_stock_order_meta({ orderId,
meta: { valueOfGoodsJpy, valueOfOrderJpy, paidCurrency, paidAmount } })`
(reducer derives `totalOrderEur`).

### 6.3 Missing costs — reconciling TSV paste

Original invoices are JPY with **inconsistent, sometimes two-row**
headers. Observed shapes (non-exhaustive):

```
Unit price including tax | delivery quantity | Total wholesale amount YEN
PCS Price JPY | UNIT Price JPY | "ORDER\nQ'ty UNIT" | "ORDER\nQ'ty PCS" | Total Wholesale Amount YEN
Quantity | UNIT PRICE (YEN) | TOTAL (YEN)
Order Q'ty PCS | Product name（…） | Original price | Wholesale price Rank E | Total Wholesale Amount YEN
INNER ORDER PCS ORDER TOTAL Ex-Factory  TOTAL   (row 1)
PCS   INNER CTN CTN PCS  JP\      AMOUNT       (row 2)   ← two header rows
```

**Header detection.** Try a 1-row header; if a quantity and a
cost/total column can't both be resolved, retry treating the **first
two rows as a combined header** (join row1+row2 per column, normalised
like the existing order/live-event parsers). Pick whichever yields a
usable mapping.

**Per-line unit cost — reconcile to value of goods.** A line may offer
several candidate unit-cost interpretations:
- a direct unit-price column (tax-inclusive or ex-tax), or
- `Total (YEN) ÷ qty`, where qty is PCS (preferred) — with the
  Total÷PCS rule from the cost design.

For each viable interpretation `I`, compute
`Σ_lines round(unitCost_I) × qty` (each line rounded to ¥1).
**Choose the interpretation whose sum *exactly* equals
`valueOfGoodsJpy`.** This both picks the right columns *and validates
the paste* against the order's known goods value.

If **no** interpretation matches exactly, the preview selects the
closest interpretation and shows the **exact discrepancy**
(`Σ − valueOfGoodsJpy`, signed) plus every candidate's sum. Commit is
then gated behind an explicit **"approve despite ¥<discrepancy>
mismatch"** acknowledgement (default off) — the user approves the exact
number, no silent acceptance.

**Flow (mirrors live-event import).**
- `set_stock_order_cost_paste({ orderId, rawPaste })` stages the paste
  only (no mutation), like `liveEventImport/set_paste`.
- Pure `computeStockOrderCostCommit(state, orderId)` returns the
  preview: chosen interpretation + reconciliation Σ vs goods value;
  matched rows (key, qty, new ¥); unmatched rows; **override
  conflicts** (rows whose target lot already has a non-zero cost);
  resulting re-derived item cost.
- The screen shows it; an **"override existing priced lots"** toggle
  (default off) gates whether override-conflict rows are applied.
  Override conflicts are an exception flag (§3) regardless.
- Nothing applies until **Commit** broadcasts
  `commit_stock_order_costs({ orderId, overrideExisting,
  approveDiscrepancy })`. The reducer refuses to apply a non-reconciling
  paste unless `approveDiscrepancy` is set, and refuses override
  conflicts unless `overrideExisting` is set.

### 6.4 Reducer behaviour (the part that actually fixes inventory)

Because import already happened earlier in the action log, the fix
actions retroactively update that order's lots when replayed:

- `set_stock_order_meta`: store meta; derive `totalOrderEur` and
  `fx = totalOrderEur / valueOfOrderJpy`; then for every `costLedger[*]`
  entry with `source === "stockOrder:"+orderId`: set `at = receivedAt`
  (if given); recompute `unitCostEur = unitCostJpy * fx` (if known);
  re-derive the affected item's `cost` via `walkLedger`.
- `commit_stock_order_costs`: re-run the reconciling parse
  deterministically from the staged paste; for each resolved row set
  `unitCostJpy` (+ `unitCostEur` via fx) on that order's matching
  lot(s) — unpriced always; already-priced only when
  `overrideExisting`; re-derive affected items.

Deterministic under cold replay: import creates sentinel lots, the
later (logged) fix action mutates exactly that order's lots. Full
replay before/after: only the fixed orders' items change.

---

## 7. Preview-before-commit UX (consistent across all three)

Same contract as the live-event route: a staged action (or pure
compute) produces a preview; the screen renders it (counts + a table of
affected SKUs old→new); an explicit **Commit** button broadcasts the
mutating action. Navigating away without commit changes nothing.

---

## 8. Broadcast actions (new / extended)

| Action | Payload | Effect |
|---|---|---|
| `set_stock_order_meta` (extend) | `{ orderId, meta:{ receivedAt?, valueOfGoodsJpy?, valueOfOrderJpy?, paidCurrency?, paidAmount? } }` | store; derive `totalOrderEur`+`fx`; retro-update this order's lots; re-derive |
| `set_stock_order_cost_paste` (new) | `{ orderId, rawPaste }` | stage TSV only (no mutation) |
| `commit_stock_order_costs` (new) | `{ orderId, overrideExisting, approveDiscrepancy }` | reconcile-parse staged TSV; refuse if non-reconciling unless `approveDiscrepancy`; price matching lots (override-priced only if `overrideExisting`); re-derive |

Staging state for the paste lives in a slice (like
`liveEventImport`), keyed by `orderId`.

---

## 9. Validation / tests

1. Pure unit: `selectOrderExceptions`, BGN→EUR conversion,
   `computeStockOrderCostCommit` (match/unmatched/already-priced).
2. Reducer unit: `set_stock_order_meta` retro-updates sourced lots
   (date + fx) and re-derives; `commit_stock_order_costs` prices
   unpriced lots; LEV recorded as fact but state EUR.
3. Full replay on the latest backup: appending a fix action for an
   order changes only that order's items, to the hand-computed values;
   determinism across two cold replays.
4. E2E: list shows sentinel orders → Fix Order → set date / exchange
   (EUR and BGN) / paste TSV → preview → commit → SKU Review COST
   drops; zero-pixel screenshots.

---

## 10. Resolved decisions

All design questions are resolved; no open items.

- TSV unit cost is **JPY**; accept both a direct unit-price column and
  Total÷PCS, choosing the interpretation that reconciles to
  value-of-goods.
- Exception = **any** gap (date / value-of-goods / value-of-order /
  paid / unpriced lot / override conflict).
- Override of an already-priced lot is itself an exception, gated by an
  `overrideExisting` toggle (default off).
- Order identity = `activeFile.id || activeFile.name` (filename).
- **fx denominator** = `totalOrderEur / valueOfOrderJpy` (paid ÷
  invoice; shipping/tax not capitalised).
- **Reconciliation = exact** (each line rounded to ¥1; Σ must equal
  `valueOfGoodsJpy`).
- **Non-reconciling paste** is not rejected: preview shows the exact
  signed discrepancy and all candidate sums; commit requires an
  explicit `approveDiscrepancy` acknowledgement.
- **Two-row-header** auto-detection (try 1-row; if qty+cost columns
  unresolved, retry joining the first two rows) is the chosen approach.

---

## 11. Milestones (post-approval)

- **M3.1** Model refinements (§2): lot `source`, auto-registry. Replay
  byte-identical.
- **M3.2** `set_stock_order_meta` retro-update + BGN peg + selector.
  Unit + replay tests.
- **M3.3** Route A (list) + Route B date & exchange sections + preview.
  E2E.
- **M3.4** TSV cost paste slice + `computeStockOrderCostCommit` +
  Route B §6.3 + commit. Unit + E2E.

No work begins until §10 is answered and this design is approved.
