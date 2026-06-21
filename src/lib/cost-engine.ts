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
  // Quantity that represents newly received purchased goods for order/recount
  // provenance. Defaults to `qty`. Some recount/quantity-adjustment receipts
  // carry `receivedQty: 0`; inventory-value reporting derives cumulative value
  // from receipt-driven value increases, not directly from this metadata.
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

  const result = materialized.filter(
    (entry) =>
      !(
        entry.kind === "receipt" &&
        entry.adjustmentEntry &&
        entry.adjustmentMode === "apply-to-target"
      ),
  );

  applyArchiveSweepQuantities(result);
  return result;
}

// On-hand of every (effective, non-ignored) entry created before `beforeSeq`,
// with archives sweeping their own pre-archive on-hand. `saleQty` selects the
// unit a sale consumes (cost qty vs. operator-visible qty). Used to derive how
// much an archive sells.
//
// `clampMidWalk` selects which walk's semantics to match, because the two
// differ for a sale ordered before its covering receipt (e.g. a same-day
// loose-piece sale that sorts ahead of the pack receipt):
//   - cost sweep (clampMidWalk=false): carry the deficit into the receipt,
//     like walkLedger's pending-sale carry. Clamping here would forget those
//     units and over-state the sweep, surfacing as a phantom oversold.
//   - visible sweep (clampMidWalk=true): clamp at zero each step, like
//     walkLedgerForVisibleQty, so the swept visibleQty matches the visible
//     on-hand the item count reconciles against.
// Either way the final result is clamped at zero (an archive cannot sell
// negative stock).
function preArchiveOnHand(
  result: readonly LedgerEntry[],
  beforeSeq: number,
  saleQty: (e: LedgerEntry) => number,
  clampMidWalk: boolean,
): number {
  const sorted = [...result].sort((a, b) => a.at - b.at || a.seq - b.seq);
  let onHand = 0;
  const step = (next: number) => (clampMidWalk ? Math.max(0, next) : next);
  for (const e of sorted) {
    if (e.seq >= beforeSeq || e.ignored) continue;
    if (e.kind === "receipt") {
      onHand = step(onHand + (Number(e.qty) || 0));
    } else if (e.isArchive) {
      // Nested archive: recompute its sweep rather than trust its stored qty.
      onHand = step(
        onHand - preArchiveOnHand(result, e.seq, saleQty, clampMidWalk),
      );
    } else {
      onHand = step(onHand - saleQty(e));
    }
  }
  return Math.max(0, onHand);
}

// An archive is a stock-take wipe: it sells the on-hand that exists just before
// it. That quantity is re-derived here from the current (post-audit) entries
// rather than read from the snapshot recorded when the archive first replayed,
// so ignoring a row or correcting a quantity earlier in the ledger correctly
// flows through the archive. archiveSweepDivergences compares the two so the UI
// can warn when an audit action changed the swept quantity.
function applyArchiveSweepQuantities(result: LedgerEntry[]): void {
  if (!result.some((e) => e.kind === "sale" && e.isArchive && !e.ignored)) {
    return;
  }
  for (const e of result) {
    if (e.kind !== "sale" || !e.isArchive || e.ignored) continue;
    const costSweep = preArchiveOnHand(
      result,
      e.seq,
      (s) => Number(s.qty) || 0,
      false,
    );
    const visSweep = preArchiveOnHand(
      result,
      e.seq,
      (s) => Number((s as SaleEntry).visibleQty ?? s.qty) || 0,
      true,
    );
    e.qty = costSweep;
    if (e.visibleQty !== undefined || Math.abs(costSweep - visSweep) > 1e-9) {
      e.visibleQty = visSweep;
    }
  }
}

/**
 * Walk the ledger up to and including `asOf` (default: all entries).
 * Perpetual weighted-average: a receipt blends into the running average;
 * a sale reduces on-hand and leaves the average unchanged.
 */
export function walkLedger(
  entries: readonly LedgerEntry[],
  asOf: number = Number.POSITIVE_INFINITY,
  blendWarnings?: ZeroCostBlend[],
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
      // A ¥0 lot meeting a priced one: one side is costed and the other is not.
      // Establishing the basis on the first receipt (onHand 0) is not a blend.
      const existingPriced = avgJpy > 1e-9;
      const incomingPriced = unitCostJpy > 1e-9;
      const zeroBoundary =
        onHand > 0 && receiptQty > 0 && existingPriced !== incomingPriced;
      if (zeroBoundary && !existingPriced) {
        // Priced receipt landing on uncosted on-hand. Treat the now-known cost
        // as the basis for the whole position (the uncosted goods are the same
        // item) instead of diluting it toward ¥0 — re-price, do not average.
        if (blendWarnings) {
          blendWarnings.push({
            id: e.id,
            at: e.at,
            seq: e.seq,
            existingQty: onHand,
            existingAvgJpy: avgJpy,
            receiptQty,
            receiptUnitJpy: unitCostJpy,
            kind: "uncosted-onhand",
          });
        }
        for (const lot of lots) {
          if (!(lot.jpy > 1e-9)) lot.jpy = unitCostJpy;
          if (!(lot.eur > 1e-9)) lot.eur = unitCostEur;
        }
        avgJpy = unitCostJpy;
        avgEur = unitCostEur;
      } else {
        if (zeroBoundary && blendWarnings) {
          // Uncosted receipt diluting priced on-hand — should never happen.
          blendWarnings.push({
            id: e.id,
            at: e.at,
            seq: e.seq,
            existingQty: onHand,
            existingAvgJpy: avgJpy,
            receiptQty,
            receiptUnitJpy: unitCostJpy,
            kind: "zero-incoming",
          });
        }
        avgJpy = (onHand * avgJpy + receiptQty * unitCostJpy) / next;
        avgEur = (onHand * avgEur + receiptQty * unitCostEur) / next;
      }
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

export interface ArchiveSweepDivergence {
  id?: string;
  at: number;
  seq: number;
  recordedQty: number;
  sweptQty: number;
}

/**
 * Archive sales sweep all on-hand stock to zero at walk time (see walkLedger).
 * The quantity recorded on the archive entry is a snapshot taken when the
 * archive action first replayed; a later audit action (ignoring a row or
 * adjusting a quantity) can change the pre-archive on-hand, so the quantity
 * actually swept can differ from what was recorded. This lists every archive
 * entry whose re-derived sweep quantity differs from its recorded quantity, so
 * the UI can warn that the swept quantity changed because of an audit action.
 *
 * On-hand is accumulated the same way the operator-visible walk does (receipts
 * add, sales subtract their visible quantity), so divergences are reported in
 * the visible stock units shown in the ledger table.
 */
export function archiveSweepDivergences(
  entries: readonly LedgerEntry[],
): ArchiveSweepDivergence[] {
  const effectiveById = new Map<string, SaleEntry>();
  for (const e of effectiveLedgerEntries(entries)) {
    if (e.kind === "sale" && e.isArchive && e.id) effectiveById.set(e.id, e);
  }
  const out: ArchiveSweepDivergence[] = [];
  for (const e of entries) {
    if (e.kind !== "sale" || !e.isArchive || e.ignored || !e.id) continue;
    const effective = effectiveById.get(e.id);
    if (!effective) continue;
    const recordedQty = Number(e.visibleQty ?? e.qty) || 0;
    const sweptQty = Number(effective.visibleQty ?? effective.qty) || 0;
    if (Math.abs(recordedQty - sweptQty) > 1e-9) {
      out.push({ id: e.id, at: e.at, seq: e.seq, recordedQty, sweptQty });
    }
  }
  return out;
}

export interface LedgerOversold {
  oversoldQty: number;
  firstNegativeAt: number;
  offendingOrders: string[];
}

export interface ZeroCostBlend {
  id?: string;
  at: number;
  seq: number;
  existingQty: number;
  existingAvgJpy: number;
  receiptQty: number;
  receiptUnitJpy: number;
  /**
   * `uncosted-onhand`: a priced receipt met uncosted (¥0) on-hand. Rather than
   * diluting toward ¥0, the on-hand adopts the incoming price (no averaging).
   * `zero-incoming`: an uncosted (¥0) receipt was averaged into priced on-hand,
   * diluting the cost basis. This should never happen and indicates a missing
   * receipt cost.
   */
  kind: "uncosted-onhand" | "zero-incoming";
}

/**
 * Every point where a ¥0 lot meets a priced one in the perpetual-average walk —
 * either a priced receipt landing on uncosted on-hand (`uncosted-onhand`, which
 * adopts the incoming price instead of averaging) or an uncosted receipt being
 * averaged into priced on-hand (`zero-incoming`, which dilutes the basis and
 * should never occur). Carry-rescued recounts (a ¥0 stocktake receipt that
 * inherits the pre-archive average) are already priced by the time they blend
 * and so do not warn.
 */
export function zeroCostBlendWarnings(
  entries: readonly LedgerEntry[],
): ZeroCostBlend[] {
  const out: ZeroCostBlend[] = [];
  walkLedger(entries, Number.POSITIVE_INFINITY, out);
  return out;
}

/**
 * Decode the order/source id embedded in a sale ledger entry id of the shape
 * `ledger:sale:<key>:<actionId>:<actionType>:<orderId>:<atMs>:<qty>` (each part
 * is URL-encoded, so splitting on ":" is safe). Returns the decoded orderId for
 * sales recorded by package_item / quantify_item, else undefined.
 */
export function orderIdFromSaleId(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const parts = id.split(":");
  const idx = parts.findIndex(
    (p) => p === "package_item" || p === "quantify_item",
  );
  if (idx < 0 || idx + 1 >= parts.length) return undefined;
  try {
    return decodeURIComponent(parts[idx + 1]);
  } catch {
    return parts[idx + 1];
  }
}

// Operator-visible on-hand: the same clamped walk that drives item.qty
// (walkLedgerForVisibleQty in inventory.ts). Used as an oversold guard.
function visibleOnHand(ledger: readonly LedgerEntry[]): number {
  let onHand = 0;
  for (const e of ledger) {
    if (e.ignored) continue;
    if (e.kind === "receipt") {
      onHand = Math.max(0, onHand + (Number(e.qty) || 0));
    } else {
      onHand = Math.max(0, onHand - (Number(e.visibleQty ?? e.qty) || 0));
    }
  }
  return onHand;
}

/**
 * An item is "oversold" when it has NO stock left yet its sales still exceed
 * everything ever received — a deficit the clamped visible walk hides at zero
 * (e.g. a live event whose count sold more units than were in stock).
 *
 * Two guards keep this honest:
 *  - If the operator-visible on-hand is positive the item plainly has stock and
 *    cannot be oversold, whatever the cost walk says. (A stock-take archive that
 *    sweeps a post-dated receipt can drive the cost balance negative while real
 *    stock remains; that is not an oversell.)
 *  - The deficit is measured in the ledger's native `qty` unit, consistent for
 *    receipts and sales. `visibleQty` is a piece-count annotation for
 *    loose-piece items (1 piece = 1/22 of a pack) and must not be mixed with
 *    pack-unit receipts, or fully-sold loose-piece items look oversold.
 *
 * Returns the net oversold quantity, when the deficit first appeared, and the
 * orders whose sales drove on-hand negative — or null when not oversold.
 */
export function ledgerOversold(
  entries: readonly LedgerEntry[],
): LedgerOversold | null {
  const ledger = sortLedger(effectiveLedgerEntries(entries));
  if (visibleOnHand(ledger) > 1e-6) return null;

  let onHand = 0;
  let firstNegativeAt = 0;
  const offendingOrders = new Set<string>();
  for (const e of ledger) {
    if (e.ignored) continue;
    if (e.kind === "receipt") {
      onHand += Number(e.qty) || 0;
      continue;
    }
    onHand -= Number(e.qty) || 0;
    if (onHand < -1e-6) {
      if (!firstNegativeAt) firstNegativeAt = e.at;
      const order = orderIdFromSaleId(e.id);
      if (order) offendingOrders.add(order);
    }
  }
  if (onHand >= -1e-6) return null;
  return {
    oversoldQty: -onHand,
    firstNegativeAt,
    offendingOrders: [...offendingOrders],
  };
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
