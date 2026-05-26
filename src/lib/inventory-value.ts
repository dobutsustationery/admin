// Inventory-value report: total cost of remaining inventory over time.
//
// One report since company inception. A row at every month end (quarter
// ends flagged), a row whenever a stock order is received, and a final
// "current" row. Value = Σ on-hand × perpetual weighted-average cost,
// evaluated as-of that instant via the pure cost engine.
//
// Pure and deterministic: `nowMs` is injected so tests don't depend on
// the wall clock.

import { totalValuation, type LedgerEntry } from "./cost-engine";
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
  let carry: { jpy: number; eur: number } | null = null;
  let inventoryJpy = 0;
  let inventoryEur = 0;
  let soldJpy = 0;
  let soldEur = 0;

  for (const entry of sortLedger(entries)) {
    if (entry.at > asOf) break;
    if (entry.ignored) continue;

    if (entry.kind === "receipt") {
      const next = onHand + entry.qty;
      let unitCostJpy = entry.unitCostJpy;
      let unitCostEur = entry.unitCostEur;

      if (next > 0 && onHand === 0 && carry) {
        const jpyPriced = entry.unitCostJpy > 0;
        const eurPriced = entry.unitCostEur > 0;
        if (jpyPriced && eurPriced) {
          unitCostJpy = entry.unitCostJpy;
          unitCostEur = entry.unitCostEur;
        } else if (jpyPriced) {
          unitCostJpy = entry.unitCostJpy;
          unitCostEur =
            carry.jpy > 0
              ? (entry.unitCostJpy * carry.eur) / carry.jpy
              : carry.eur;
        } else if (eurPriced) {
          unitCostEur = entry.unitCostEur;
          unitCostJpy =
            carry.eur > 0
              ? (entry.unitCostEur * carry.jpy) / carry.eur
              : carry.jpy;
        } else {
          unitCostJpy = carry.jpy;
          unitCostEur = carry.eur;
        }
        carry = null;
      }

      inventoryJpy += entry.qty * unitCostJpy;
      inventoryEur += entry.qty * unitCostEur;

      if (next <= 0) {
        onHand = next > 0 ? next : 0;
        continue;
      }

      avgJpy = (onHand * avgJpy + entry.qty * unitCostJpy) / next;
      avgEur = (onHand * avgEur + entry.qty * unitCostEur) / next;
      onHand = next;
      continue;
    }

    const prev = onHand;
    const soldQty = entry.qty >= 0 ? Math.min(entry.qty, onHand) : entry.qty;
    soldJpy += soldQty * avgJpy;
    soldEur += soldQty * avgEur;
    onHand = Math.max(0, onHand - entry.qty);
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
