// Inventory-value report: total cost of remaining inventory over time.
//
// One report since company inception. A row at every month end (quarter
// ends flagged), a row whenever a stock order is received, and a final
// "current" row. Value = Σ on-hand × perpetual weighted-average cost,
// evaluated as-of that instant via the pure cost engine.
//
// Pure and deterministic: `nowMs` is injected so tests don't depend on
// the wall clock.

import {
  effectiveLedgerEntries,
  totalValuation,
  type LedgerEntry,
  type ReceiptEntry,
} from "./cost-engine";
import type { InventoryState } from "./inventory";

export type InventoryValueRowKind =
  | "month-end"
  | "quarter-end"
  | "stock-order"
  | "current";

export interface InventoryValueRow {
  asOf: number; // epoch ms the valuation is taken at (inclusive)
  dateIso: string; // YYYY-MM-DD (UTC)
  kind: InventoryValueRowKind;
  label: string;
  valueJpy: number;
  valueEur: number;
  cumulativeInventoryValueJpy: number;
  cumulativeInventoryValueEur: number;
  cumulativeSoldValueJpy: number;
  cumulativeSoldValueEur: number;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// Last millisecond of month `m` (0-based) in year `y`, UTC.
function monthEndMs(y: number, m: number): number {
  return Date.UTC(y, m + 1, 1) - 1;
}

const QUARTER_END_MONTHS = new Set([2, 5, 8, 11]); // Mar Jun Sep Dec

function sortLedger(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      if (a.entry.at !== b.entry.at) return a.entry.at - b.entry.at;
      if (a.entry.seq !== b.entry.seq) return a.entry.seq - b.entry.seq;
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
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

function lotValue(lots: readonly CostLot[]): { jpy: number; eur: number } {
  let jpy = 0;
  let eur = 0;
  for (const lot of lots) {
    if (lot.qty <= 0) continue;
    jpy += lot.qty * lot.jpy;
    eur += lot.qty * lot.eur;
  }
  return { jpy, eur };
}

function consumeLotsFifoValue(
  lots: CostLot[],
  qty: number,
): { jpy: number; eur: number; lots: CostLot[] } {
  let remaining = Math.max(0, qty);
  let jpy = 0;
  let eur = 0;
  const consumedLots: CostLot[] = [];
  while (remaining > 0 && lots.length > 0) {
    const lot = lots[0];
    const consumed = Math.min(lot.qty, remaining);
    jpy += consumed * lot.jpy;
    eur += consumed * lot.eur;
    consumedLots.push({
      qty: consumed,
      jpy: lot.jpy,
      eur: lot.eur,
      source: lot.source,
    });
    lot.qty -= consumed;
    remaining -= consumed;
    if (lot.qty <= 1e-9) lots.shift();
  }
  return { jpy, eur, lots: consumedLots };
}

function isZeroCostLot(lot: CostLot): boolean {
  return Math.abs(lot.jpy) <= 1e-9 && Math.abs(lot.eur) <= 1e-9;
}

function consumeZeroCostLots(
  lots: CostLot[],
  qty: number,
): { consumedQty: number; lots: CostLot[] } {
  let remaining = Math.max(0, qty);
  let consumedQty = 0;
  const consumedLots: CostLot[] = [];
  for (let index = 0; index < lots.length && remaining > 0; ) {
    const lot = lots[index];
    if (!isZeroCostLot(lot)) {
      index += 1;
      continue;
    }
    const consumed = Math.min(lot.qty, remaining);
    consumedQty += consumed;
    consumedLots.push({
      qty: consumed,
      jpy: 0,
      eur: 0,
      source: lot.source,
    });
    lot.qty -= consumed;
    remaining -= consumed;
    if (lot.qty <= 1e-9) lots.splice(index, 1);
    else index += 1;
  }
  return { consumedQty, lots: consumedLots };
}

function consumeNormalSaleValue(
  lots: CostLot[],
  qty: number,
  avgJpy: number,
  avgEur: number,
): { jpy: number; eur: number; lots: CostLot[] } {
  let remaining = Math.max(0, qty);
  let jpy = 0;
  let eur = 0;
  const consumedLots: CostLot[] = [];
  while (remaining > 0 && lots.length > 0) {
    const lot = lots[0];
    const consumed = Math.min(lot.qty, remaining);
    const zeroCost = isZeroCostLot(lot);
    const soldJpy = zeroCost ? 0 : avgJpy;
    const soldEur = zeroCost ? 0 : avgEur;
    jpy += consumed * soldJpy;
    eur += consumed * soldEur;
    consumedLots.push({
      qty: consumed,
      jpy: soldJpy,
      eur: soldEur,
      source: lot.source,
    });
    lot.qty -= consumed;
    remaining -= consumed;
    if (lot.qty <= 1e-9) lots.shift();
  }
  if (remaining > 0) {
    jpy += remaining * avgJpy;
    eur += remaining * avgEur;
    consumedLots.push({
      qty: remaining,
      jpy: avgJpy,
      eur: avgEur,
      source: "receipt",
    });
  }
  return { jpy, eur, lots: consumedLots };
}

function consumeStocktakeShrinkValue(
  lots: CostLot[],
  qty: number,
): { jpy: number; eur: number; lots: CostLot[] } {
  const zero = consumeZeroCostLots(lots, qty);
  const remaining = Math.max(0, qty - zero.consumedQty);
  const priced = consumeLotsFifoValue(lots, remaining);
  return {
    jpy: priced.jpy,
    eur: priced.eur,
    lots: [...zero.lots, ...priced.lots],
  };
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

function cumulativeLedgerValues(
  entries: readonly LedgerEntry[],
  asOf: number,
): {
  inventoryJpy: number;
  inventoryEur: number;
  soldJpy: number;
  soldEur: number;
} {
  let onHand = 0;
  let avgJpy = 0;
  let avgEur = 0;
  const lots: CostLot[] = [];
  let carry: { jpy: number; eur: number } | null = null;
  let inventoryJpy = 0;
  let inventoryEur = 0;
  let soldJpy = 0;
  let soldEur = 0;
  let pendingSaleQty = 0;
  const soldLots: CostLot[] = [];
  const ledger = sortLedger(effectiveLedgerEntries(entries));

  for (let index = 0; index < ledger.length; index += 1) {
    const entry = ledger[index];
    if (entry.at > asOf) break;
    if (entry.ignored) continue;

    if (entry.kind === "receipt") {
      const next = onHand + entry.qty;
      let unitCostJpy = entry.unitCostJpy;
      let unitCostEur = entry.unitCostEur;

      if (next > 0 && entry.receivedQty === 0 && carry) {
        const carried = applyCarryToUnitCost(entry, carry);
        unitCostJpy = carried.jpy;
        unitCostEur = carried.eur;
        carry = null;
      }

      const receivedQty =
        Number.isFinite(entry.receivedQty) && entry.receivedQty != null
          ? entry.receivedQty
          : entry.qty;
      inventoryJpy += receivedQty * unitCostJpy;
      inventoryEur += receivedQty * unitCostEur;

      const consumedByPending = Math.min(
        Math.max(entry.qty, 0),
        pendingSaleQty,
      );
      pendingSaleQty -= consumedByPending;
      const consumedByPendingJpy = consumedByPending * unitCostJpy;
      const consumedByPendingEur = consumedByPending * unitCostEur;
      soldJpy += consumedByPendingJpy;
      soldEur += consumedByPendingEur;

      const receiptQty = entry.qty - consumedByPending;
      const nextAfterPending = onHand + receiptQty;

      if (nextAfterPending <= 0) {
        onHand = nextAfterPending > 0 ? nextAfterPending : 0;
        continue;
      }

      const existingPriced = avgJpy > 1e-9;
      const incomingPriced = unitCostJpy > 1e-9;
      const zeroBoundary =
        onHand > 0 && receiptQty > 0 && existingPriced !== incomingPriced;
      if (zeroBoundary && !existingPriced) {
        avgJpy = unitCostJpy;
        avgEur = unitCostEur;
      } else {
        avgJpy =
          (onHand * avgJpy + receiptQty * unitCostJpy) / nextAfterPending;
        avgEur =
          (onHand * avgEur + receiptQty * unitCostEur) / nextAfterPending;
      }
      onHand = nextAfterPending;
      if (receiptQty > 0) {
        lots.push({
          qty: receiptQty,
          jpy: unitCostJpy,
          eur: unitCostEur,
          source: "receipt",
        });
      }
      continue;
    }

    const prev = onHand;
    if (entry.qty >= 0) {
      if (entry.isArchive && prev > 0) {
        const nextReceipt = nextStocktakeReceiptAfter(ledger, index, asOf);
        if (nextReceipt) {
          const survivorLots = lots.map((lot) => ({ ...lot }));
          const shrinkQty = Math.max(0, prev - Math.max(0, nextReceipt.qty));
          const hasZeroCostStock = survivorLots.some(isZeroCostLot);
          const beforeStocktakeValue = hasZeroCostStock
            ? lotValue(survivorLots)
            : { jpy: prev * avgJpy, eur: prev * avgEur };
          const survivorShrinkValue = consumeStocktakeShrinkValue(
            survivorLots,
            shrinkQty,
          );
          const survivorAverage = stocktakeCarryAverage(survivorLots);
          carry =
            survivorAverage.jpy > 0 || survivorAverage.eur > 0
              ? survivorAverage
              : { jpy: avgJpy, eur: avgEur };
          if (entry.qty >= prev) {
            const recountUnitCost = applyCarryToUnitCost(nextReceipt, carry);
            const survivorBookValue = {
              jpy: beforeStocktakeValue.jpy - survivorShrinkValue.jpy,
              eur: beforeStocktakeValue.eur - survivorShrinkValue.eur,
            };
            const recountValue = {
              jpy: Math.max(0, nextReceipt.qty) * recountUnitCost.jpy,
              eur: Math.max(0, nextReceipt.qty) * recountUnitCost.eur,
            };
            const shrinkValue = consumeStocktakeShrinkValue(
              lots,
              Math.max(0, prev - Math.max(0, nextReceipt.qty)),
            );
            soldJpy +=
              shrinkValue.jpy +
              Math.max(0, survivorBookValue.jpy - recountValue.jpy);
            soldEur +=
              shrinkValue.eur +
              Math.max(0, survivorBookValue.eur - recountValue.eur);
            onHand = 0;
            lots.splice(0, lots.length);
            continue;
          }
        }
      }
      const soldQty = Math.min(entry.qty, onHand);
      const soldValue = consumeNormalSaleValue(lots, soldQty, avgJpy, avgEur);
      soldJpy += soldValue.jpy;
      soldEur += soldValue.eur;
      soldLots.push(...soldValue.lots);
      onHand -= soldQty;
      pendingSaleQty += entry.qty - soldQty;
    } else {
      let restored = -entry.qty;
      const pendingReduction = Math.min(restored, pendingSaleQty);
      pendingSaleQty -= pendingReduction;
      restored -= pendingReduction;
      const restoredLots: CostLot[] = [];
      let remainingRestore = restored;
      while (remainingRestore > 0 && soldLots.length > 0) {
        const lot = soldLots[soldLots.length - 1];
        const restoredQty = Math.min(lot.qty, remainingRestore);
        soldJpy -= restoredQty * lot.jpy;
        soldEur -= restoredQty * lot.eur;
        restoredLots.unshift({
          qty: restoredQty,
          jpy: lot.jpy,
          eur: lot.eur,
          source: "restored-sale",
        });
        lot.qty -= restoredQty;
        remainingRestore -= restoredQty;
        if (lot.qty <= 1e-9) soldLots.pop();
      }
      if (remainingRestore > 0) {
        soldJpy -= remainingRestore * avgJpy;
        soldEur -= remainingRestore * avgEur;
        restoredLots.unshift({
          qty: remainingRestore,
          jpy: avgJpy,
          eur: avgEur,
          source: "restored-sale",
        });
      }
      onHand += restored;
      if (restoredLots.length > 0) {
        lots.unshift(...restoredLots);
      }
    }
    if (entry.isArchive && prev > 0 && onHand === 0) {
      carry = { jpy: avgJpy, eur: avgEur };
    }
  }

  return { inventoryJpy, inventoryEur, soldJpy, soldEur };
}

export function totalCumulativeValues(
  ledgers: Iterable<readonly LedgerEntry[]>,
  asOf: number,
): {
  inventoryJpy: number;
  inventoryEur: number;
  soldJpy: number;
  soldEur: number;
} {
  let inventoryJpy = 0;
  let inventoryEur = 0;
  let soldJpy = 0;
  let soldEur = 0;

  for (const ledger of ledgers) {
    const values = cumulativeLedgerValues(ledger, asOf);
    inventoryJpy += values.inventoryJpy;
    inventoryEur += values.inventoryEur;
    soldJpy += values.soldJpy;
    soldEur += values.soldEur;
  }

  return { inventoryJpy, inventoryEur, soldJpy, soldEur };
}

/**
 * Build the inventory-value report. Rows are sorted ascending by `asOf`;
 * stock-order rows sort before a same-instant period row. Returns [] when
 * there is no cost ledger activity.
 */
export function buildInventoryValueReport(
  inventory: Pick<InventoryState, "costLedger" | "stockOrderRegistry">,
  nowMs: number,
): InventoryValueRow[] {
  const ledger = inventory.costLedger || {};
  const ledgers = Object.values(ledger) as LedgerEntry[][];

  let minAt = Number.POSITIVE_INFINITY;
  let maxAt = Number.NEGATIVE_INFINITY;
  for (const entries of ledgers) {
    for (const e of entries) {
      if (e.at < minAt) minAt = e.at;
      if (e.at > maxAt) maxAt = e.at;
    }
  }
  if (!Number.isFinite(minAt)) return [];

  const end = Math.max(maxAt, nowMs);

  type Point = { asOf: number; kind: InventoryValueRowKind; label: string };
  const points: Point[] = [];

  // Month / quarter ends from inception's month through `end`.
  const start = new Date(minAt);
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const asOf = monthEndMs(y, m);
    if (asOf > end) break;
    const isQuarter = QUARTER_END_MONTHS.has(m);
    points.push({
      asOf,
      kind: isQuarter ? "quarter-end" : "month-end",
      label: `${isQuarter ? "Quarter" : "Month"} end ${isoDate(asOf)}`,
    });
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
  }

  // Stock-order receipts.
  const registry = inventory.stockOrderRegistry || {};
  for (const orderId of Object.keys(registry)) {
    const meta = registry[orderId];
    const at = meta.receivedAt;
    if (at == null || at <= 0) continue;
    const name = (meta.name || meta.supplier || orderId).trim();
    points.push({
      asOf: at,
      kind: "stock-order",
      label: `Stock order received: ${name}`,
    });
  }

  // Always end on the present value.
  points.push({ asOf: nowMs, kind: "current", label: "Current" });

  // stock-order rows sort before a same-instant period/current row.
  const rank = (k: InventoryValueRowKind) => (k === "stock-order" ? 0 : 1);
  points.sort((a, b) => a.asOf - b.asOf || rank(a.kind) - rank(b.kind));

  return points.map(({ asOf, kind, label }) => {
    const { valueJpy, valueEur } = totalValuation(ledgers, asOf);
    const cumulative = totalCumulativeValues(ledgers, asOf);
    return {
      asOf,
      dateIso: isoDate(asOf),
      kind,
      label,
      valueJpy: Math.round(valueJpy),
      valueEur: Math.round(valueEur * 100) / 100,
      cumulativeInventoryValueJpy: Math.round(cumulative.inventoryJpy),
      cumulativeInventoryValueEur:
        Math.round(cumulative.inventoryEur * 100) / 100,
      cumulativeSoldValueJpy: Math.round(cumulative.soldJpy),
      cumulativeSoldValueEur: Math.round(cumulative.soldEur * 100) / 100,
    };
  });
}

/** Tab-separated export for the accountant. */
export function inventoryValueTsv(rows: InventoryValueRow[]): string {
  const header = [
    "Date",
    "Type",
    "Event",
    "Value (EUR)",
    "Value (JPY)",
    "Cumulative Inventory Value (EUR)",
    "Cumulative Inventory Value (JPY)",
    "Cumulative Sold Inventory Value (EUR)",
    "Cumulative Sold Inventory Value (JPY)",
  ];
  const typeLabel: Record<InventoryValueRowKind, string> = {
    "month-end": "Month end",
    "quarter-end": "Quarter end",
    "stock-order": "Stock order",
    current: "Current",
  };
  const lines = rows.map((r) =>
    [
      r.dateIso,
      typeLabel[r.kind],
      r.label,
      r.valueEur.toFixed(2),
      String(r.valueJpy),
      r.cumulativeInventoryValueEur.toFixed(2),
      String(r.cumulativeInventoryValueJpy),
      r.cumulativeSoldValueEur.toFixed(2),
      String(r.cumulativeSoldValueJpy),
    ].join("\t"),
  );
  return [header.join("\t"), ...lines].join("\n");
}
