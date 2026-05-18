// Reconciling parser for a pasted stock-order invoice TSV (JPY).
// See docs/investigations/DESIGN_ORDER_EXCEPTIONS_ROUTE.md §6.3
//
// Invoice headers are inconsistent and sometimes span two rows. We
// detect the header (1 or 2 rows), enumerate candidate per-line
// unit-cost interpretations (a direct unit-price column, or a
// total ÷ qty column), and pick the interpretation whose
// Σ round(unitCost)·qty *exactly* equals the order's value of goods.
// If none reconciles, the closest is returned with the exact signed
// discrepancy for explicit approval.

import { normalizeHeader, parseAmount } from "./stock-order-cost";

export interface StockOrderCostRow {
  jan: string;
  subtype: string;
  qty: number;
  unitCostJpy: number; // rounded to ¥1
}

export interface CostInterpretation {
  label: string;
  kind: "unit" | "total";
  sum: number; // Σ round(unitCost)·qty
  rows: StockOrderCostRow[];
}

export interface StockOrderCostParse {
  interpretations: CostInterpretation[];
  unmatchedHeader: boolean; // could not resolve qty + a cost column
  headerRows: number; // 1 or 2
}

export interface StockOrderCostReconciliation {
  reconciled: boolean; // an interpretation summed exactly to goods
  chosen?: CostInterpretation;
  discrepancy?: number; // signed: chosen.sum - valueOfGoodsJpy
  candidates: { label: string; sum: number }[];
  rows: StockOrderCostRow[];
}

const splitCells = (line: string): string[] =>
  line.includes("\t") ? line.split("\t") : line.split(",");

function extractJan(cell: string): string {
  const s = String(cell ?? "").trim();
  const m = s.match(/\d{8,14}/);
  return m ? m[0] : s;
}

interface ColMap {
  jan: number;
  subtype: number;
  qty: number;
  unitCols: number[];
  totalCols: number[];
}

function resolveColumns(headers: string[]): ColMap | null {
  const norm = headers.map(normalizeHeader);
  const find = (pred: (h: string) => boolean) => norm.findIndex(pred);
  const all = (pred: (h: string) => boolean) =>
    norm.map((h, i) => (pred(h) ? i : -1)).filter((i) => i >= 0);

  const jan = find(
    (h) =>
      h.includes("jan") ||
      h.includes("barcode") ||
      h === "sku" ||
      h.includes("productnumber"),
  );
  // qty: prefer a PCS column, else a generic quantity (not "unit").
  let qty = find((h) => h.includes("pcs"));
  if (qty < 0)
    qty = find(
      (h) =>
        (h.includes("qty") || h.includes("quantity")) && !h.includes("unit"),
    );
  const subtype = find((h) => h.includes("subtype") || h === "variant");

  const unitCols = all(
    (h) =>
      (h.includes("unitprice") ||
        h.includes("pcspricejpy") ||
        h.includes("exfactory") ||
        (h.includes("price") && !h.includes("total"))) &&
      !h.includes("original"),
  );
  const totalCols = all(
    (h) =>
      h.includes("total") &&
      (h.includes("yen") || h.includes("jpy") || h.includes("amount")),
  );

  if (jan < 0 || qty < 0 || (unitCols.length === 0 && totalCols.length === 0))
    return null;
  return { jan, subtype, qty, unitCols, totalCols };
}

export function parseStockOrderCostTsv(rawPaste: string): StockOrderCostParse {
  const lines = String(rawPaste ?? "")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  if (lines.length < 2)
    return { interpretations: [], unmatchedHeader: true, headerRows: 1 };

  const grid = lines.map(splitCells);

  // Try a 1-row header; if qty + a cost column can't be resolved, retry
  // with the first two rows joined per column (two-row header).
  let headerRows = 1;
  let cols = resolveColumns(grid[0]);
  if (!cols && grid.length >= 3) {
    const joined = grid[0].map((c, i) => `${c ?? ""} ${grid[1]?.[i] ?? ""}`);
    cols = resolveColumns(joined);
    if (cols) headerRows = 2;
  }
  if (!cols)
    return { interpretations: [], unmatchedHeader: true, headerRows: 1 };

  const dataRows = grid.slice(headerRows);
  const baseRows = dataRows
    .map((cells) => ({
      jan: extractJan(cells[cols!.jan]),
      subtype:
        cols!.subtype >= 0 ? String(cells[cols!.subtype] ?? "").trim() : "",
      qty: parseAmount(cells[cols!.qty]),
      cells,
    }))
    .filter((r) => r.jan !== "" && Number.isFinite(r.qty) && r.qty > 0);

  const interpretations: CostInterpretation[] = [];
  const build = (
    label: string,
    kind: "unit" | "total",
    unitOf: (cells: string[], qty: number) => number,
  ) => {
    const rows: StockOrderCostRow[] = [];
    let sum = 0;
    for (const r of baseRows) {
      const u = unitOf(r.cells, r.qty);
      if (!Number.isFinite(u) || u <= 0) continue;
      const unitCostJpy = Math.round(u);
      rows.push({ jan: r.jan, subtype: r.subtype, qty: r.qty, unitCostJpy });
      sum += unitCostJpy * r.qty;
    }
    if (rows.length) interpretations.push({ label, kind, sum, rows });
  };

  for (const c of cols.unitCols)
    build(normalizeHeader(grid[0][c] || `unit#${c}`), "unit", (cells) =>
      parseAmount(cells[c]),
    );
  for (const c of cols.totalCols)
    build(
      normalizeHeader(grid[0][c] || `total#${c}`),
      "total",
      (cells, qty) => parseAmount(cells[c]) / qty,
    );

  return {
    interpretations,
    unmatchedHeader: interpretations.length === 0,
    headerRows,
  };
}

export function reconcileStockOrderCostTsv(
  parse: StockOrderCostParse,
  valueOfGoodsJpy: number | undefined,
): StockOrderCostReconciliation {
  const candidates = parse.interpretations.map((i) => ({
    label: i.label,
    sum: i.sum,
  }));
  if (parse.interpretations.length === 0)
    return { reconciled: false, candidates, rows: [] };

  // Prefer a direct unit-price interpretation on ties.
  const ordered = [...parse.interpretations].sort((a, b) =>
    a.kind === b.kind ? 0 : a.kind === "unit" ? -1 : 1,
  );

  if (valueOfGoodsJpy != null) {
    const exact = ordered.find((i) => i.sum === valueOfGoodsJpy);
    if (exact)
      return {
        reconciled: true,
        chosen: exact,
        discrepancy: 0,
        candidates,
        rows: exact.rows,
      };
  }

  // No exact match: closest by |sum - goods| (or first if goods unknown).
  const chosen =
    valueOfGoodsJpy == null
      ? ordered[0]
      : ordered.reduce((best, i) =>
          Math.abs(i.sum - valueOfGoodsJpy) <
          Math.abs(best.sum - valueOfGoodsJpy)
            ? i
            : best,
        );
  return {
    reconciled: false,
    chosen,
    discrepancy:
      valueOfGoodsJpy == null ? undefined : chosen.sum - valueOfGoodsJpy,
    candidates,
    rows: chosen.rows,
  };
}
