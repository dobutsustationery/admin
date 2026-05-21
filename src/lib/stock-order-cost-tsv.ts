// Reconciling parser for a pasted stock-order invoice TSV (JPY).
// See docs/investigations/DESIGN_ORDER_EXCEPTIONS_ROUTE.md §6.3
//
// Headers are inconsistent and sometimes span two rows. We detect the
// header (1 or 2 rows), enumerate candidate per-line unit-cost
// interpretations (a direct unit-price column, or a total ÷ qty
// column) and pick the one whose line sum exactly equals the order's
// value of goods. Stock orders never have subtypes.
// Columns are exposed so the UI can offer a manual override.

import Papa from "papaparse";

import { normalizeHeader, parseAmount } from "./stock-order-cost";

export interface StockOrderCostRow {
  jan: string;
  qty: number;
  unitCostJpy: number; // unit rows are rounded to ¥1; total rows may be fractional
  countryOfOrigin?: string;
  weight?: number;
}

export interface CostInterpretation {
  label: string;
  kind: "unit" | "total";
  costColumnIndex: number;
  qtyColumnIndex: number;
  countryColumnIndex: number; // -1 = none
  weightColumnIndex: number; // -1 = none
  costLabel: string; // normalized header of the cost/total column used
  qtyLabel: string; // normalized header of the qty column used
  sum: number; // unit rows: Σ round(unitCost)·qty; total rows: Σ line total
  rows: StockOrderCostRow[];
}

export interface TsvColumn {
  index: number;
  label: string; // display header, prefixed with spreadsheet column name
  norm: string; // normalized
}

export interface StockOrderCostParse {
  interpretations: CostInterpretation[];
  unmatchedHeader: boolean;
  headerRows: number; // 1 or 2
  columns: TsvColumn[]; // all resolved columns (for manual dropdowns)
  janCol: number;
  countryCol: number; // auto-detected COO column, -1 = none
  weightCol: number; // auto-detected weight column, -1 = none
}

export interface StockOrderCostReconciliation {
  reconciled: boolean;
  chosen?: CostInterpretation;
  discrepancy?: number; // signed: chosen.sum - valueOfGoodsJpy
  candidates: { label: string; sum: number }[];
  rows: StockOrderCostRow[];
  qtySum?: number;
  expectedItemCount?: number;
  itemCountReconciled?: boolean;
  itemCountDiscrepancy?: number; // signed: qtySum - expectedItemCount
}

// Quote-aware grid. A header cell can contain a quoted embedded
// newline (e.g. `"※Weight in Grams\nper piece. (g)"`); naive
// line/cell splitting would tear that header across two rows and
// misalign every column. Papa respects RFC-4180 quoting, matching
// the order-import parser's behaviour.
const toGrid = (rawPaste: string): string[][] => {
  const raw = String(rawPaste ?? "");
  const delimiter = raw.includes("\t") ? "\t" : ",";
  const { data } = Papa.parse<string[]>(raw, {
    delimiter,
    skipEmptyLines: true,
  });
  return data.filter((row) =>
    row.some((cell) => String(cell ?? "").trim() !== ""),
  );
};

function extractJan(cell: string): string {
  const s = String(cell ?? "").trim();
  const m = s.match(/\d{8,14}/);
  return m ? m[0] : s;
}

function findJan(norm: string[]): number {
  return norm.findIndex(
    (h) =>
      h.includes("jan") ||
      h.includes("barcode") ||
      h === "sku" ||
      h.includes("productnumber"),
  );
}

// Prefer the TOTAL piece count, never a carton/inner-scoped one.
function findQty(norm: string[]): number {
  const cartonish = (h: string) =>
    h.includes("ctn") || h.includes("carton") || h.includes("inner");
  const moneyish = (h: string) =>
    h.includes("price") ||
    h.includes("cost") ||
    h.includes("amount") ||
    h.includes("yen") ||
    h.includes("jpy") ||
    h.includes("bgn") ||
    h.includes("lev") ||
    h.includes("eur") ||
    h.includes("wholesale") ||
    h.includes("tax");
  const usableQty = (h: string) => !cartonish(h) && !moneyish(h);

  let i = norm.findIndex((h) => h === "totalpcs" || h === "orderqtypcs");
  if (i < 0)
    i = norm.findIndex(
      (h) => h.includes("order") && h.includes("qty") && h.includes("pcs"),
    );
  if (i < 0)
    i = norm.findIndex(
      (h) => h.includes("pcs") && h.includes("total") && usableQty(h),
    );
  if (i < 0)
    i = norm.findIndex(
      (h) => h.includes("pcs") && h.includes("qty") && usableQty(h),
    );
  if (i < 0) i = norm.findIndex((h) => h.includes("pcs") && usableQty(h));
  if (i < 0)
    i = norm.findIndex(
      (h) =>
        (h.includes("qty") || h.includes("quantity")) &&
        !h.includes("unit") &&
        usableQty(h),
    );
  if (i < 0) i = norm.findIndex((h) => h.includes("pcs") && !cartonish(h));
  return i;
}

function unitCols(norm: string[]): number[] {
  return norm
    .map((h, i) =>
      (h.includes("unitprice") ||
        h.includes("pcspricejpy") ||
        h.includes("exfactory") ||
        (h.includes("price") && !h.includes("total"))) &&
      !h.includes("original")
        ? i
        : -1,
    )
    .filter((i) => i >= 0);
}
function totalCols(norm: string[]): number[] {
  return norm
    .map((h, i) =>
      h.includes("total") &&
      (h.includes("yen") || h.includes("jpy") || h.includes("amount"))
        ? i
        : -1,
    )
    .filter((i) => i >= 0);
}

function findCountryOfOrigin(norm: string[]): number {
  return norm.findIndex(
    (h) =>
      h === "countryoforigin" ||
      h === "origin" ||
      h === "country" ||
      h.includes("countryoforigin"),
  );
}

function findWeight(norm: string[]): number {
  const preferred = norm.findIndex(
    (h) =>
      h.includes("weightingrams") ||
      h.includes("weightingram") ||
      (h.includes("weight") && h.includes("gram")) ||
      (h.includes("weight") && h.includes("piece")),
  );
  if (preferred >= 0) return preferred;
  return norm.findIndex(
    (h) =>
      h === "weight" ||
      h === "weightg" ||
      h.includes("weight") ||
      h.includes("grams"),
  );
}

// Detect a 1- or 2-row header. A row variant is "complete" when it
// resolves JAN + qty + at least one cost/total column. Prefer 1-row;
// fall back to the 2-row joined header (then to whatever has a JAN so
// the manual override still has columns).
function complete(norm: string[]): boolean {
  return (
    findJan(norm) >= 0 &&
    findQty(norm) >= 0 &&
    (unitCols(norm).length > 0 || totalCols(norm).length > 0)
  );
}

function joinHeaderRows(top: string[], bottom: string[] | undefined): string[] {
  return top.map((c, i) => `${c ?? ""} ${bottom?.[i] ?? ""}`.trim());
}

function looksLikeHeaderContinuation(
  secondRow: string[] | undefined,
  janCol: number,
): boolean {
  if (!secondRow) return false;
  const janCell = String(secondRow[janCol] ?? "").trim();
  if (/\d{8,14}/.test(janCell)) return false;
  const headerishCells = secondRow.filter((cell) =>
    /[a-zA-Z¥円]/.test(String(cell ?? "")),
  ).length;
  return headerishCells > 0;
}

function detectHeader(grid: string[][]): {
  labels: string[];
  headerRows: number;
} {
  const one = grid[0];
  const oneNorm = one.map(normalizeHeader);
  if (grid.length >= 3) {
    const joined = joinHeaderRows(grid[0], grid[1]);
    const joinedComplete = complete(joined.map(normalizeHeader));
    const oneJan = findJan(oneNorm);
    if (
      joinedComplete &&
      oneJan >= 0 &&
      looksLikeHeaderContinuation(grid[1], oneJan)
    )
      return { labels: joined, headerRows: 2 };
  }
  if (complete(oneNorm)) return { labels: one, headerRows: 1 };
  if (grid.length >= 3) {
    const joined = joinHeaderRows(grid[0], grid[1]);
    if (complete(joined.map(normalizeHeader)))
      return { labels: joined, headerRows: 2 };
  }
  // Neither is complete: prefer the variant that at least has a JAN.
  if (findJan(oneNorm) >= 0) return { labels: one, headerRows: 1 };
  if (grid.length >= 3) {
    const joined = joinHeaderRows(grid[0], grid[1]);
    if (findJan(joined.map(normalizeHeader)) >= 0)
      return { labels: joined, headerRows: 2 };
  }
  return { labels: one, headerRows: 1 };
}

function spreadsheetColumnName(index: number): string {
  let n = index + 1;
  let label = "";
  while (n > 0) {
    n -= 1;
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26);
  }
  return label;
}

function buildRows(
  grid: string[][],
  headerRows: number,
  janCol: number,
  qtyCol: number,
  costCol: number,
  kind: "unit" | "total",
  countryCol = -1,
  weightCol = -1,
): { rows: StockOrderCostRow[]; sum: number } {
  const rows: StockOrderCostRow[] = [];
  let sum = 0;
  for (const cells of grid.slice(headerRows)) {
    const jan = extractJan(cells[janCol]);
    const qty = parseAmount(cells[qtyCol]);
    if (jan === "" || !Number.isFinite(qty) || qty <= 0) continue;
    const raw = parseAmount(cells[costCol]);
    const u = kind === "total" ? raw / qty : raw;
    if (!Number.isFinite(u) || u <= 0) continue;
    const unitCostJpy = kind === "total" ? u : Math.round(u);
    const countryOfOrigin =
      countryCol >= 0 ? String(cells[countryCol] ?? "").trim() : "";
    const weight = weightCol >= 0 ? parseAmount(cells[weightCol]) : Number.NaN;
    rows.push({
      jan,
      qty,
      unitCostJpy,
      ...(countryOfOrigin ? { countryOfOrigin } : {}),
      ...(Number.isFinite(weight) && weight > 0 ? { weight } : {}),
    });
    sum += kind === "total" ? raw : unitCostJpy * qty;
  }
  return { rows, sum };
}

export function parseStockOrderCostTsv(rawPaste: string): StockOrderCostParse {
  const grid = toGrid(rawPaste);
  const empty: StockOrderCostParse = {
    interpretations: [],
    unmatchedHeader: true,
    headerRows: 1,
    columns: [],
    janCol: -1,
    countryCol: -1,
    weightCol: -1,
  };
  if (grid.length < 2) return empty;

  const { labels, headerRows } = detectHeader(grid);
  const norm = labels.map(normalizeHeader);
  const columns: TsvColumn[] = labels.map((label, index) => ({
    index,
    label: `${spreadsheetColumnName(index)}: ${
      String(label ?? "").trim() || `col${index}`
    }`,
    norm: norm[index],
  }));
  const janCol = findJan(norm);
  const qtyCol = findQty(norm);
  const countryCol = findCountryOfOrigin(norm);
  const weightCol = findWeight(norm);
  if (janCol < 0 || qtyCol < 0)
    return { ...empty, columns, janCol, headerRows, countryCol, weightCol };

  const interpretations: CostInterpretation[] = [];
  const add = (costCol: number, kind: "unit" | "total") => {
    const { rows, sum } = buildRows(
      grid,
      headerRows,
      janCol,
      qtyCol,
      costCol,
      kind,
      countryCol,
      weightCol,
    );
    if (rows.length)
      interpretations.push({
        label: norm[costCol] || `${kind}#${costCol}`,
        kind,
        costColumnIndex: costCol,
        qtyColumnIndex: qtyCol,
        countryColumnIndex: countryCol,
        weightColumnIndex: weightCol,
        costLabel: norm[costCol],
        qtyLabel: norm[qtyCol],
        sum,
        rows,
      });
  };
  for (const c of unitCols(norm)) add(c, "unit");
  for (const c of totalCols(norm)) add(c, "total");

  return {
    interpretations,
    unmatchedHeader: interpretations.length === 0,
    headerRows,
    columns,
    janCol,
    countryCol,
    weightCol,
  };
}

/**
 * Deterministically build a specific interpretation from explicit
 * column choices (manual override). Re-parses rawPaste so the commit
 * interceptor can reproduce exactly what the screen previewed.
 */
export function buildInterpretation(
  rawPaste: string,
  sel: {
    kind: "unit" | "total";
    costColumnIndex: number;
    qtyColumnIndex: number;
    // undefined = auto-detect; -1 = explicitly none; >=0 = that column.
    countryColumnIndex?: number;
    weightColumnIndex?: number;
  },
): CostInterpretation | null {
  const grid = toGrid(rawPaste);
  if (grid.length < 2) return null;
  const { labels, headerRows } = detectHeader(grid);
  const norm = labels.map(normalizeHeader);
  const janCol = findJan(norm);
  const costCol = sel.costColumnIndex;
  const qtyCol = sel.qtyColumnIndex;
  const inBounds = (i: number) => (i >= 0 && i < labels.length ? i : -1);
  const countryCol =
    sel.countryColumnIndex === undefined
      ? findCountryOfOrigin(norm)
      : inBounds(sel.countryColumnIndex);
  const weightCol =
    sel.weightColumnIndex === undefined
      ? findWeight(norm)
      : inBounds(sel.weightColumnIndex);
  if (
    janCol < 0 ||
    costCol < 0 ||
    qtyCol < 0 ||
    costCol >= labels.length ||
    qtyCol >= labels.length
  )
    return null;
  const { rows, sum } = buildRows(
    grid,
    headerRows,
    janCol,
    qtyCol,
    costCol,
    sel.kind,
    countryCol,
    weightCol,
  );
  if (rows.length === 0) return null;
  return {
    label: norm[costCol] || `${sel.kind}#${costCol}`,
    kind: sel.kind,
    costColumnIndex: costCol,
    qtyColumnIndex: qtyCol,
    countryColumnIndex: countryCol,
    weightColumnIndex: weightCol,
    costLabel: norm[costCol],
    qtyLabel: norm[qtyCol],
    sum,
    rows,
  };
}

export function reconcileStockOrderCostTsv(
  parse: StockOrderCostParse,
  valueOfGoodsJpy: number | undefined,
  expectedItemCount?: number,
): StockOrderCostReconciliation {
  const candidates = parse.interpretations.map((i) => ({
    label: i.label,
    sum: i.sum,
  }));
  if (parse.interpretations.length === 0)
    return {
      reconciled: false,
      candidates,
      rows: [],
      ...itemCountFields([], expectedItemCount),
    };

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
        ...itemCountFields(exact.rows, expectedItemCount),
      };
  }

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
    ...itemCountFields(chosen.rows, expectedItemCount),
  };
}

/** Reconcile from a forced manual interpretation (vs. auto-detect). */
export function reconcileManual(
  interp: CostInterpretation | null,
  valueOfGoodsJpy: number | undefined,
  expectedItemCount?: number,
): StockOrderCostReconciliation {
  if (!interp)
    return {
      reconciled: false,
      candidates: [],
      rows: [],
      ...itemCountFields([], expectedItemCount),
    };
  const candidates = [{ label: interp.label, sum: interp.sum }];
  const reconciled = valueOfGoodsJpy != null && interp.sum === valueOfGoodsJpy;
  return {
    reconciled,
    chosen: interp,
    discrepancy:
      valueOfGoodsJpy == null ? undefined : interp.sum - valueOfGoodsJpy,
    candidates,
    rows: interp.rows,
    ...itemCountFields(interp.rows, expectedItemCount),
  };
}

function itemCountFields(
  rows: readonly StockOrderCostRow[],
  expectedItemCount?: number,
): Pick<
  StockOrderCostReconciliation,
  | "qtySum"
  | "expectedItemCount"
  | "itemCountReconciled"
  | "itemCountDiscrepancy"
> {
  const qtySum = rows.reduce((sum, row) => sum + row.qty, 0);
  if (!(Number(expectedItemCount) > 0)) return { qtySum };
  const expected = Number(expectedItemCount);
  return {
    qtySum,
    expectedItemCount: expected,
    itemCountReconciled: qtySum === expected,
    itemCountDiscrepancy: qtySum - expected,
  };
}
