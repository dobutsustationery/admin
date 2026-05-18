// Inventory cost & valuation engine.
// See docs/investigations/DESIGN_INVENTORY_COST_AND_VALUATION.md
//
// Pure, deterministic. Given an item's date-sorted ledger of receipts and
// sales, walking it (optionally truncated to an as-of date) yields the
// on-hand quantity and the perpetual weighted-average cost in JPY and EUR.
// "Cost now" is a walk with asOf = +Infinity.

// Placeholder used when a stock order's true receipt date is unknown.
// The engine treats it as an ordinary date; only the exceptions surface
// recognises it, so computation never branches on "problem exists".
export const UNKNOWN_RECEIPT_DATE = Date.UTC(2026, 0, 1); // 2026-01-01

export type ReceiptEntry = {
  kind: "receipt";
  at: number; // epoch ms; always a real date (UNKNOWN_RECEIPT_DATE if not known)
  seq: number; // deterministic tiebreak within equal `at`
  qty: number;
  unitCostJpy: number; // always a number (0 = unknown, surfaced elsewhere)
  unitCostEur: number; // always a number (0 = unknown, surfaced elsewhere)
  // Provenance: "stockOrder:<orderId>" for order-sourced lots, else the
  // creating action type. Lets the exceptions UI target a given order's
  // lots. Does not affect the cost walk (not a sort key).
  source?: string;
};

export type SaleEntry = {
  kind: "sale";
  at: number;
  seq: number;
  qty: number;
};

export type LedgerEntry = ReceiptEntry | SaleEntry;

export interface CostState {
  onHand: number;
  avgJpy: number;
  avgEur: number;
}

export interface Valuation extends CostState {
  valueJpy: number;
  valueEur: number;
}

// Stable order: ascending by date, then by seq. Input is not mutated.
function sortLedger(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      if (a.e.at !== b.e.at) return a.e.at - b.e.at;
      if (a.e.seq !== b.e.seq) return a.e.seq - b.e.seq;
      return a.i - b.i; // preserve insertion order on full tie
    })
    .map((x) => x.e);
}

/**
 * Walk the ledger up to and including `asOf` (default: all entries).
 * Perpetual weighted-average: a receipt blends into the running average;
 * a sale reduces on-hand and leaves the average unchanged.
 */
export function walkLedger(
  entries: readonly LedgerEntry[],
  asOf: number = Number.POSITIVE_INFINITY,
): CostState {
  let onHand = 0;
  let avgJpy = 0;
  let avgEur = 0;

  for (const e of sortLedger(entries)) {
    if (e.at > asOf) break;
    if (e.kind === "receipt") {
      const next = onHand + e.qty;
      if (next <= 0) {
        // Degenerate (e.g. zero/negative qty): nothing to blend.
        onHand = next > 0 ? next : 0;
        continue;
      }
      avgJpy = (onHand * avgJpy + e.qty * e.unitCostJpy) / next;
      avgEur = (onHand * avgEur + e.qty * e.unitCostEur) / next;
      onHand = next;
    } else {
      onHand = Math.max(0, onHand - e.qty);
    }
  }

  return { onHand, avgJpy, avgEur };
}

/** Value of the item as of `asOf` = on-hand × weighted-average cost. */
export function valueAt(
  entries: readonly LedgerEntry[],
  asOf: number = Number.POSITIVE_INFINITY,
): Valuation {
  const s = walkLedger(entries, asOf);
  return {
    ...s,
    valueJpy: s.onHand * s.avgJpy,
    valueEur: s.onHand * s.avgEur,
  };
}

/** Total inventory value across many items as of `asOf`. */
export function totalValuation(
  ledgers: Iterable<readonly LedgerEntry[]>,
  asOf: number = Number.POSITIVE_INFINITY,
): { valueJpy: number; valueEur: number } {
  let valueJpy = 0;
  let valueEur = 0;
  for (const l of ledgers) {
    const v = valueAt(l, asOf);
    valueJpy += v.valueJpy;
    valueEur += v.valueEur;
  }
  return { valueJpy, valueEur };
}
