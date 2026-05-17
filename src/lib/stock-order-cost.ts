// Per-unit JPY cost of a stock-order CSV line.
// See docs/investigations/DESIGN_INVENTORY_COST_AND_VALUATION.md §6.2
//
// Rule:
//   - if an explicit finite per-unit price column is present, use it;
//   - else  Total Wholesale Amount YEN ÷ Order Q'ty PCS.
//   - Order Q'ty UNIT (pieces per pack) is DISREGARDED — PCS is the
//     total piece count and is a multiple of UNIT.
// Pure and header-driven; headers differ per supplier so matching is by
// normalised header text. Returns 0 when not computable (the "needs
// cost" sentinel — surfaced by the exceptions code, never here).

export const STOCK_ORDER_UNIT_COST_UNKNOWN = 0;

/** lowercase, drop every non-alphanumeric char (handles newlines, ¥, '). */
export function normalizeHeader(h: string): string {
  return String(h)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Parse a possibly formatted number: " 4,700 " -> 4700, "¥1,234.5" -> 1234.5. */
export function parseAmount(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  const s = String(v ?? "").replace(/[^0-9.\-]/g, "");
  if (s === "" || s === "-" || s === "." || s === "-.") return NaN;
  return Number.parseFloat(s);
}

function buildIndex(headers: readonly string[]): Map<string, number> {
  const idx = new Map<string, number>();
  headers.forEach((h, i) => {
    const n = normalizeHeader(h);
    if (n && !idx.has(n)) idx.set(n, i);
  });
  return idx;
}

function find(
  idx: Map<string, number>,
  pred: (normalizedHeader: string) => boolean,
): number {
  for (const [k, i] of idx) if (pred(k)) return i;
  return -1;
}

/**
 * Per-unit JPY cost for one stock-order row.
 * @param headers the CSV header row (first row of rawRows)
 * @param row     the data row, cell-aligned with headers
 */
export function parseStockOrderUnitCostJpy(
  headers: readonly string[],
  row: readonly unknown[],
): number {
  const idx = buildIndex(headers);

  // 1. Explicit per-unit price column (e.g. "UNIT PRICE (YEN)").
  //    Must not collide with "Q'ty per UNIT" / "ORDER Q'ty UNIT".
  const priceCol = find(
    idx,
    (h) => h.includes("unitprice") && h.includes("yen"),
  );
  if (priceCol >= 0) {
    const p = parseAmount(row[priceCol]);
    if (Number.isFinite(p) && p > 0) return p;
  }

  // 2. Total Wholesale Amount YEN ÷ Order Q'ty PCS.
  const totalCol = find(
    idx,
    (h) => h.includes("totalwholesale") && h.includes("yen"),
  );
  const pcsCol = find(idx, (h) => h.includes("qty") && h.includes("pcs"));
  if (totalCol >= 0 && pcsCol >= 0) {
    const total = parseAmount(row[totalCol]);
    const pcs = parseAmount(row[pcsCol]);
    if (Number.isFinite(total) && Number.isFinite(pcs) && pcs > 0) {
      return total / pcs;
    }
  }

  return STOCK_ORDER_UNIT_COST_UNKNOWN;
}
