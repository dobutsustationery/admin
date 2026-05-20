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

// Bulgarian lev is fixed to the euro by currency-board peg.
// State stores EUR; the action records the real paid currency.
export const BGN_PER_EUR = 1.95583; // 1 EUR = 1.95583 BGN (fixed)

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
  // The stock order that supplied this lot's cost. Set even when a
  // "Zeroed Quantities" original order attaches cost to a pre-existing
  // scan lot (which keeps its scan `source`/`at`). Metadata only — the
  // exceptions UI keys off `source OR costOrderId`. Not a sort key.
  costOrderId?: string;
};

export type SaleEntry = {
  kind: "sale";
  at: number;
  seq: number;
  qty: number;
  // True when this sale was emitted by an inventory archive (a
  // stock-take wipe), not a real customer/event sale. Archives are
  // typically followed by a recount that re-adds inventory; without
  // a hint, the perpetual blend would zero the running average at the
  // archive's zero-crossing and an unpriced recount lot would carry
  // €0 forward. With this flag, `walkLedger` remembers the pre-archive
  // average and inherits it on the next unpriced post-archive receipt.
  isArchive?: boolean;
};

export type LedgerEntry = ReceiptEntry | SaleEntry;

/**
 * Does this ledger entry belong to stock order `orderId`? True for a
 * receipt the order created (`source === "stockOrder:"+orderId`) OR a
 * pre-existing scan lot whose cost that order supplied
 * (`costOrderId === orderId`, e.g. a "Zeroed Quantities" original
 * order). The single predicate every order-exceptions consumer uses.
 */
export function lotMatchesOrder(e: LedgerEntry, orderId: string): boolean {
  return (
    e.kind === "receipt" &&
    (e.source === `stockOrder:${orderId}` || e.costOrderId === orderId)
  );
}

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
  // Set by an archive sale (`isArchive: true`) that brought on-hand to
  // zero. The next receipt blends with this prior average for any
  // currency it doesn't itself price, then `carry` is consumed.
  let carry: { jpy: number; eur: number } | null = null;

  for (const e of sortLedger(entries)) {
    if (e.at > asOf) break;
    if (e.kind === "receipt") {
      const next = onHand + e.qty;
      if (next <= 0) {
        // Degenerate (e.g. zero/negative qty): nothing to blend.
        onHand = next > 0 ? next : 0;
        continue;
      }
      if (onHand === 0 && carry) {
        // First post-archive receipt. Priced currencies override.
        // For a currency that is itself unpriced, derive it from the
        // OTHER currency on the same receipt via the fx ratio implicit
        // in the carry (avgEur/avgJpy or its inverse). The avg ratio is
        // dilution-invariant: even if the pre-archive blend mixed
        // priced lots with unpriced scan lots, `carry.eur/carry.jpy`
        // still equals the priced lot's per-unit fx. Only when the
        // receipt is unpriced in BOTH currencies do we fall back to
        // inheriting the carried averages directly (no anchor to scale).
        const jpyPriced = e.unitCostJpy > 0;
        const eurPriced = e.unitCostEur > 0;
        if (jpyPriced && eurPriced) {
          avgJpy = e.unitCostJpy;
          avgEur = e.unitCostEur;
        } else if (jpyPriced) {
          avgJpy = e.unitCostJpy;
          avgEur =
            carry.jpy > 0 ? (e.unitCostJpy * carry.eur) / carry.jpy : carry.eur;
        } else if (eurPriced) {
          avgEur = e.unitCostEur;
          avgJpy =
            carry.eur > 0 ? (e.unitCostEur * carry.jpy) / carry.eur : carry.jpy;
        } else {
          avgJpy = carry.jpy;
          avgEur = carry.eur;
        }
        carry = null;
      } else {
        avgJpy = (onHand * avgJpy + e.qty * e.unitCostJpy) / next;
        avgEur = (onHand * avgEur + e.qty * e.unitCostEur) / next;
      }
      onHand = next;
    } else {
      const prev = onHand;
      onHand = Math.max(0, onHand - e.qty);
      if (e.isArchive && prev > 0 && onHand === 0) {
        carry = { jpy: avgJpy, eur: avgEur };
      }
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
