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
  id?: string;
  kind: "receipt";
  at: number; // epoch ms; always a real date (UNKNOWN_RECEIPT_DATE if not known)
  seq: number; // deterministic tiebreak within equal `at`
  qty: number;
  // Quantity that represents newly received purchased goods for cumulative
  // received-value reporting. Defaults to `qty`. Recount/quantity-adjustment
  // receipts can carry stock value without pretending a supplier receipt
  // happened again.
  receivedQty?: number;
  unitCostJpy: number; // always a number (0 = unknown, surfaced elsewhere)
  unitCostEur: number; // always a number (0 = unknown, surfaced elsewhere)
  // Provenance: "stockOrder:<orderId>" for order-sourced lots, else the
  // creating action type. Lets the exceptions UI target a given order's
  // lots. Does not affect the cost walk (not a sort key).
  source?: string;
  // Broadcast document that created this receipt, when known. Used only to
  // make optimistic pending writes idempotent when Firestore later confirms
  // the same document with a resolved server timestamp.
  createdByActionId?: string;
  // The stock order that supplied this lot's cost. Set even when a
  // "Zeroed Quantities" original order attaches cost to a pre-existing
  // scan lot (which keeps its scan `source`/`at`). Metadata only — the
  // exceptions UI keys off `source OR costOrderId`. Not a sort key.
  costOrderId?: string;
  // Manual override for historical bad scans/imports. Kept on the entry
  // so the logged correction replays deterministically.
  ignored?: boolean;
  // Audit marker for reducer-applied visible-qty corrections. The entry's
  // current qty is authoritative; originalQty and quantityCorrections explain
  // why a scanned receipt was reduced or ignored.
  originalQty?: number;
  quantityCorrections?: {
    at: number;
    actionType: string;
    actionDocId?: string;
    fromVisibleQty: number;
    toVisibleQty: number;
    requestedVisibleQty?: number;
    reducedBy: number;
    increasedBy?: number;
  }[];
  auditComment?: string;
  auditSeverity?: "warning" | "danger";
  ignoreReason?: string;
  adjustmentEntry?: boolean;
  adjustmentMode?: "apply-to-target" | "standalone";
  adjustmentTarget?: {
    id?: string;
    at: number;
    seq: number;
  };
};

export type SaleEntry = {
  id?: string;
  kind: "sale";
  at: number;
  seq: number;
  qty: number;
  // Optional sale quantity in the operator-visible stock units. This can
  // differ from `qty` for legacy loose-piece sales where the cost ledger
  // should consume fractional pack units but visible qty corrections still
  // need to reason about the original piece count.
  visibleQty?: number;
  // True when this sale was emitted by an inventory archive (a
  // stock-take wipe), not a real customer/event sale. Archives are
  // typically followed by a recount that re-adds inventory; without
  // a hint, the perpetual blend would zero the running average at the
  // archive's zero-crossing and an unpriced recount lot would carry
  // €0 forward. With this flag, `walkLedger` remembers the pre-archive
  // average and inherits it on the next unpriced post-archive receipt.
  isArchive?: boolean;
  ignored?: boolean;
  ignoreReason?: string;
  originalQty?: number;
  auditComment?: string;
  auditSeverity?: "warning" | "danger";
  adjustmentEntry?: boolean;
  adjustmentMode?: "apply-to-target" | "standalone";
  adjustmentTarget?: {
    id?: string;
    at: number;
    seq: number;
  };
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

function receiptMatchesAdjustmentTarget(
  entry: LedgerEntry,
  target: ReceiptEntry["adjustmentTarget"],
): entry is ReceiptEntry {
  return (
    !!target?.id &&
    entry.kind === "receipt" &&
    !(entry.adjustmentEntry && entry.adjustmentMode === "apply-to-target") &&
    entry.id === target.id
  );
}

function findAdjustmentTarget(
  entries: LedgerEntry[],
  target: ReceiptEntry["adjustmentTarget"],
): ReceiptEntry | undefined {
  const exact = entries.find((entry): entry is ReceiptEntry =>
    receiptMatchesAdjustmentTarget(entry, target),
  );
  return exact;
}

type CostLot = {
  qty: number;
  jpy: number;
  eur: number;
  source: "receipt" | "restored-sale";
};

function lotAverage(lots: readonly CostLot[]): { jpy: number; eur: number } {
  let qty = 0;
  let jpy = 0;
  let eur = 0;
  for (const lot of lots) {
    if (lot.qty <= 0) continue;
    qty += lot.qty;
    jpy += lot.qty * lot.jpy;
    eur += lot.qty * lot.eur;
  }
  if (qty <= 0) return { jpy: 0, eur: 0 };
  return { jpy: jpy / qty, eur: eur / qty };
}

function consumeLotsFifo(lots: CostLot[], qty: number): void {
  let remaining = Math.max(0, qty);
  while (remaining > 0 && lots.length > 0) {
    const lot = lots[0];
    const consumed = Math.min(lot.qty, remaining);
    lot.qty -= consumed;
    remaining -= consumed;
    if (lot.qty <= 1e-9) lots.shift();
  }
}

function stocktakeCarryAverage(lots: readonly CostLot[]): {
  jpy: number;
  eur: number;
} {
  const receiptLots = lots.filter((lot) => lot.source === "receipt");
  const receiptAverage = lotAverage(receiptLots);
  return receiptAverage.jpy > 0 || receiptAverage.eur > 0
    ? receiptAverage
    : lotAverage(lots);
}

function nextStocktakeReceiptAfter(
  entries: readonly LedgerEntry[],
  index: number,
  asOf: number,
): ReceiptEntry | undefined {
  for (let i = index + 1; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry.at > asOf) break;
    if (entry.ignored) continue;
    if (entry.kind === "receipt" && entry.qty > 0 && entry.receivedQty === 0) {
      return entry;
    }
  }
  return undefined;
}

function applyCarryToUnitCost(
  receipt: ReceiptEntry,
  carry: { jpy: number; eur: number },
): { jpy: number; eur: number } {
  const jpyPriced = receipt.unitCostJpy > 0;
  const eurPriced = receipt.unitCostEur > 0;
  if (jpyPriced && eurPriced) {
    return { jpy: receipt.unitCostJpy, eur: receipt.unitCostEur };
  }
  if (jpyPriced) {
    return {
      jpy: receipt.unitCostJpy,
      eur:
        carry.jpy > 0
          ? (receipt.unitCostJpy * carry.eur) / carry.jpy
          : carry.eur,
    };
  }
  if (eurPriced) {
    return {
      jpy:
        carry.eur > 0
          ? (receipt.unitCostEur * carry.jpy) / carry.eur
          : carry.jpy,
      eur: receipt.unitCostEur,
    };
  }
  return carry;
}

export function effectiveLedgerEntries(
  entries: readonly LedgerEntry[],
): LedgerEntry[] {
  const materialized = entries.map((entry) => ({ ...entry })) as LedgerEntry[];

  for (const entry of entries) {
    if (
      entry.kind !== "receipt" ||
      entry.ignored ||
      !entry.adjustmentEntry ||
      entry.adjustmentMode !== "apply-to-target"
    ) {
      continue;
    }

    const target = findAdjustmentTarget(materialized, entry.adjustmentTarget);
    if (!target) continue;

    target.qty += entry.qty;
    if (entry.receivedQty !== undefined) {
      target.receivedQty = (target.receivedQty || 0) + entry.receivedQty;
    }
    if (target.qty <= 0) {
      target.qty = 0;
      target.ignored = true;
      target.ignoreReason =
        target.ignoreReason || "qty correction reduced receipt to zero";
    }
  }

  for (const entry of materialized) {
    if (
      entry.kind !== "receipt" ||
      entry.ignored ||
      !entry.adjustmentEntry ||
      !entry.adjustmentTarget
    ) {
      continue;
    }
    const target = findAdjustmentTarget(materialized, entry.adjustmentTarget);
    if (!target) continue;
    if (target.unitCostJpy > 0 || entry.unitCostJpy === 0) {
      entry.unitCostJpy = target.unitCostJpy;
    }
    if (target.unitCostEur > 0 || entry.unitCostEur === 0) {
      entry.unitCostEur = target.unitCostEur;
    }
    if (target.source && !entry.source) entry.source = target.source;
    if (target.costOrderId && !entry.costOrderId) {
      entry.costOrderId = target.costOrderId;
    }
  }

  return materialized.filter(
    (entry) =>
      !(
        entry.kind === "receipt" &&
        entry.adjustmentEntry &&
        entry.adjustmentMode === "apply-to-target"
      ),
  );
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
  const ledger = sortLedger(effectiveLedgerEntries(entries));
  let onHand = 0;
  let avgJpy = 0;
  let avgEur = 0;
  const lots: CostLot[] = [];
  // Set by an archive sale (`isArchive: true`) that brought on-hand to
  // zero. The next receipt blends with this prior average for any
  // currency it doesn't itself price, then `carry` is consumed.
  let carry: { jpy: number; eur: number } | null = null;
  let pendingSaleQty = 0;

  for (let index = 0; index < ledger.length; index += 1) {
    const e = ledger[index];
    if (e.at > asOf) break;
    if (e.ignored) continue;
    if (e.kind === "receipt") {
      let unitCostJpy = e.unitCostJpy;
      let unitCostEur = e.unitCostEur;

      if (e.receivedQty === 0 && carry) {
        const carried = applyCarryToUnitCost(e, carry);
        unitCostJpy = carried.jpy;
        unitCostEur = carried.eur;
        carry = null;
      }

      const consumedByPending = Math.min(Math.max(e.qty, 0), pendingSaleQty);
      pendingSaleQty -= consumedByPending;
      const receiptQty = e.qty - consumedByPending;
      const next = onHand + receiptQty;
      if (next <= 0) {
        // Degenerate (e.g. zero/negative qty): nothing to blend.
        onHand = next > 0 ? next : 0;
        continue;
      }
      avgJpy = (onHand * avgJpy + receiptQty * unitCostJpy) / next;
      avgEur = (onHand * avgEur + receiptQty * unitCostEur) / next;
      onHand = next;
      if (receiptQty > 0) {
        lots.push({
          qty: receiptQty,
          jpy: unitCostJpy,
          eur: unitCostEur,
          source: "receipt",
        });
      }
    } else {
      const prev = onHand;
      if (e.qty >= 0) {
        if (e.isArchive && prev > 0) {
          const nextReceipt = nextStocktakeReceiptAfter(ledger, index, asOf);
          if (nextReceipt) {
            const survivorLots = lots.map((lot) => ({ ...lot }));
            const shrinkQty = Math.max(0, prev - Math.max(0, nextReceipt.qty));
            consumeLotsFifo(survivorLots, shrinkQty);
            const survivorAverage = stocktakeCarryAverage(survivorLots);
            carry =
              survivorAverage.jpy > 0 || survivorAverage.eur > 0
                ? survivorAverage
                : { jpy: avgJpy, eur: avgEur };
            if (e.qty >= prev) {
              onHand = 0;
              lots.splice(0, lots.length);
              continue;
            }
          }
        }
        const consumed = Math.min(e.qty, onHand);
        onHand -= consumed;
        consumeLotsFifo(lots, consumed);
        pendingSaleQty += e.qty - consumed;
      } else {
        let restored = -e.qty;
        const pendingReduction = Math.min(restored, pendingSaleQty);
        pendingSaleQty -= pendingReduction;
        restored -= pendingReduction;
        onHand += restored;
        if (restored > 0) {
          lots.push({
            qty: restored,
            jpy: avgJpy,
            eur: avgEur,
            source: "restored-sale",
          });
        }
      }
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
