import { describe, it, expect } from "vitest";
import {
  buildInterpretation,
  parseStockOrderCostTsv,
  reconcileManual,
  reconcileStockOrderCostTsv,
} from "$lib/stock-order-cost-tsv";

// Reconciling TSV parser across the inconsistent invoice header shapes,
// incl. a two-row header. See DESIGN_ORDER_EXCEPTIONS_ROUTE.md §6.3.

const tsv = (rows: string[][]) => rows.map((r) => r.join("\t")).join("\n");

describe("parseStockOrderCostTsv — header shapes", () => {
  it("shape 1: unit price + delivery quantity + total wholesale", () => {
    const p = parseStockOrderCostTsv(
      tsv([
        [
          "JAN code",
          "Unit price including tax",
          "delivery quantity",
          "Total wholesale amount YEN",
        ],
        ["4900000000001", "100", "10", "1000"],
      ]),
    );
    expect(p.unmatchedHeader).toBe(false);
    expect(p.headerRows).toBe(1);
    // a unit interp (100) and a total interp (1000/10=100) both Σ=1000
    expect(p.interpretations.map((i) => i.sum).sort()).toEqual([1000, 1000]);
  });

  it("shape 2: PCS/UNIT price JPY + ORDER Q'ty PCS", () => {
    const p = parseStockOrderCostTsv(
      tsv([
        [
          "JAN code",
          "PCS Price JPY",
          "UNIT Price JPY",
          "ORDER Q'ty UNIT",
          "ORDER Q'ty PCS",
          "Total Wholesale Amount YEN",
        ],
        ["4900000000002", "50", "200", "4", "20", "1000"],
      ]),
    );
    expect(p.unmatchedHeader).toBe(false);
    // qty resolves to UNIT (4); UNIT price is tried before PCS price.
    const sums = p.interpretations.map((i) => i.sum);
    expect(sums).toContain(800); // 200*4
    expect(p.interpretations.every((i) => i.qtyColumnIndex === 3)).toBe(true);
    expect(p.interpretations[0]).toMatchObject({
      kind: "unit",
      costColumnIndex: 2,
      qtyColumnIndex: 3,
    });
    expect(
      p.interpretations.find((i) => i.kind === "total")?.rows[0],
    ).toMatchObject({
      qty: 4,
      unitCostJpy: 250,
    });
  });

  it("prefers UNIT price and UNIT quantity columns over PCS columns", () => {
    const p = parseStockOrderCostTsv(
      tsv([
        [
          "Bar-Code No.",
          "PCS Price JPY",
          "UNIT Price JPY",
          "ORDER Q'ty UNIT",
          "ORDER Q'ty PCS",
          "Total Wholesale Amount YEN",
        ],
        ["4542804117776", "35", "350", "4", "40", "1400"],
      ]),
    );

    const r = reconcileStockOrderCostTsv(p, 1400, 4);
    expect(r.reconciled).toBe(true);
    expect(r.chosen).toMatchObject({
      kind: "unit",
      costColumnIndex: 2,
      qtyColumnIndex: 3,
    });
    expect(r.rows[0]).toMatchObject({
      jan: "4542804117776",
      qty: 4,
      unitCostJpy: 350,
    });
    expect(r.itemCountReconciled).toBe(true);
  });

  it("shape 4: 'Original price' is NOT treated as unit cost", () => {
    const p = parseStockOrderCostTsv(
      tsv([
        [
          "JAN code",
          "Order Q'ty PCS",
          "Original price",
          "Wholesale price Rank E",
          "Total Wholesale Amount YEN",
        ],
        ["4900000000004", "10", "999", "80", "800"],
      ]),
    );
    const labels = p.interpretations.map((i) => i.label);
    expect(labels.some((l) => l.includes("original"))).toBe(false);
    // wholesale price 80 * 10 = 800 ; total 800/10*10 = 800
    expect(p.interpretations.map((i) => i.sum)).toContain(800);
  });

  it("shape 5: two-row header is auto-detected", () => {
    const p = parseStockOrderCostTsv(
      tsv([
        ["JAN code", "ORDER", "Ex-Factory", "TOTAL"],
        ["", "PCS", "JP¥", "AMOUNT"],
        ["4900000000005", "5", "30", "150"],
      ]),
    );
    expect(p.unmatchedHeader).toBe(false);
    expect(p.headerRows).toBe(2);
    // unit 30*5=150 ; total 150/5*5=150
    expect(p.interpretations.map((i) => i.sum)).toContain(150);
  });

  it("labels manual columns with spreadsheet letters and joined two-row headers", () => {
    const p = parseStockOrderCostTsv(
      tsv([
        ["JAN code", "ORDER Q'ty", "Total Amount JPY"],
        ["", "PCS", "YEN"],
        ["4900000000006", "5", "150"],
      ]),
    );

    expect(p.headerRows).toBe(2);
    expect(p.columns.map((c) => c.label)).toEqual([
      "A: JAN code",
      "B: ORDER Q'ty PCS",
      "C: Total Amount JPY YEN",
    ]);
  });

  it("carries COO and weight from pasted order rows", () => {
    const p = parseStockOrderCostTsv(
      tsv([
        [
          "JAN code",
          "Quantity",
          "UNIT PRICE (YEN)",
          "Country of Origin",
          "Weight in Grams per piece",
        ],
        ["4900000000007", "3", "120", "Japan", "45g"],
      ]),
    );

    expect(p.interpretations[0].rows[0]).toMatchObject({
      jan: "4900000000007",
      countryOfOrigin: "Japan",
      weight: 45,
    });
  });

  it("recognizes short weight headers", () => {
    const p = parseStockOrderCostTsv(
      tsv([
        ["JAN code", "Quantity", "UNIT PRICE (YEN)", "Weight (g)"],
        ["4900000000008", "3", "120", "45"],
      ]),
    );

    expect(p.interpretations[0].rows[0].weight).toBe(45);
  });
});

describe("reconcileStockOrderCostTsv", () => {
  const parse = parseStockOrderCostTsv(
    tsv([
      ["JAN code", "UNIT PRICE (YEN)", "Quantity", "TOTAL (YEN)"],
      ["4900000000010", "65", "6", "390"],
      ["4900000000011", "62", "12", "744"],
    ]),
  );

  it("picks the interpretation that exactly sums to value of goods", () => {
    const r = reconcileStockOrderCostTsv(parse, 65 * 6 + 62 * 12);
    expect(r.reconciled).toBe(true);
    expect(r.discrepancy).toBe(0);
    expect(r.rows).toHaveLength(2);
    expect(r.chosen!.kind).toBe("unit"); // unit preferred on tie
  });

  it("reports the exact signed discrepancy when none reconciles", () => {
    const goods = 65 * 6 + 62 * 12 + 5; // off by 5
    const r = reconcileStockOrderCostTsv(parse, goods);
    expect(r.reconciled).toBe(false);
    expect(r.discrepancy).toBe(-5); // chosen.sum - goods
  });

  it("reconciles parsed item count against an expected count", () => {
    const r = reconcileStockOrderCostTsv(parse, 65 * 6 + 62 * 12, 18);
    expect(r.qtySum).toBe(18);
    expect(r.itemCountReconciled).toBe(true);
    expect(r.itemCountDiscrepancy).toBe(0);
  });

  it("reports parsed item count discrepancies", () => {
    const r = reconcileStockOrderCostTsv(parse, 65 * 6 + 62 * 12, 20);
    expect(r.qtySum).toBe(18);
    expect(r.itemCountReconciled).toBe(false);
    expect(r.itemCountDiscrepancy).toBe(-2);
  });

  it("does not round total/qty unit costs before reconciliation", () => {
    const p = parseStockOrderCostTsv(
      tsv([
        ["JAN code", "Quantity", "TOTAL (YEN)"],
        ["4900000000012", "3", "1000"],
        ["4900000000013", "7", "2000"],
      ]),
    );

    const r = reconcileStockOrderCostTsv(p, 3000);

    expect(r.reconciled).toBe(true);
    expect(r.chosen?.kind).toBe("total");
    expect(r.rows.map((row) => row.unitCostJpy)).toEqual([1000 / 3, 2000 / 7]);
    expect(r.chosen?.sum).toBe(3000);
  });

  it("goods unknown: first interpretation, no discrepancy", () => {
    const r = reconcileStockOrderCostTsv(parse, undefined);
    expect(r.reconciled).toBe(false);
    expect(r.discrepancy).toBeUndefined();
    expect(r.rows.length).toBe(2);
  });
});

describe("manual stock-order cost interpretation", () => {
  it("uses explicit column indices, including duplicate normalized labels", () => {
    const raw = tsv([
      ["JAN code", "Quantity", "Total (YEN)", "Total YEN"],
      ["4900000000020", "10", "800", "1000"],
    ]);

    const interp = buildInterpretation(raw, {
      kind: "total",
      costColumnIndex: 3,
      qtyColumnIndex: 1,
    });
    const r = reconcileManual(interp, 1000);

    expect(r.reconciled).toBe(true);
    expect(r.chosen?.costColumnIndex).toBe(3);
    expect(r.chosen?.qtyColumnIndex).toBe(1);
    expect(r.rows[0].unitCostJpy).toBe(100);
    expect(r.chosen?.sum).toBe(1000);
  });

  it("can force unit price even when a total column also exists", () => {
    const raw = tsv([
      ["JAN code", "UNIT PRICE (YEN)", "Quantity", "TOTAL (YEN)"],
      ["4900000000021", "200", "10", "1500"],
    ]);

    const interp = buildInterpretation(raw, {
      kind: "unit",
      costColumnIndex: 1,
      qtyColumnIndex: 2,
    });
    const r = reconcileManual(interp, 2000);

    expect(r.reconciled).toBe(true);
    expect(r.chosen?.kind).toBe("unit");
    expect(r.rows[0].unitCostJpy).toBe(200);
  });

  it("can force COO and weight columns independently of auto-detection", () => {
    const raw = tsv([
      [
        "JAN code",
        "UNIT PRICE (YEN)",
        "Quantity",
        "Country of Origin",
        "COO override",
        "Weight in Grams",
        "Manual Weight",
      ],
      ["4900000000022", "200", "10", "Japan", "China", "25", "42"],
    ]);

    const interp = buildInterpretation(raw, {
      kind: "unit",
      costColumnIndex: 1,
      qtyColumnIndex: 2,
      countryColumnIndex: 4,
      weightColumnIndex: 6,
    });

    expect(interp?.countryColumnIndex).toBe(4);
    expect(interp?.weightColumnIndex).toBe(6);
    expect(interp?.rows[0]).toMatchObject({
      countryOfOrigin: "China",
      weight: 42,
    });
  });

  it("can disable COO and weight columns with explicit none selections", () => {
    const raw = tsv([
      [
        "JAN code",
        "UNIT PRICE (YEN)",
        "Quantity",
        "Country of Origin",
        "Weight in Grams",
      ],
      ["4900000000023", "200", "10", "Japan", "25"],
    ]);

    const interp = buildInterpretation(raw, {
      kind: "unit",
      costColumnIndex: 1,
      qtyColumnIndex: 2,
      countryColumnIndex: -1,
      weightColumnIndex: -1,
    });

    expect(interp?.countryColumnIndex).toBe(-1);
    expect(interp?.weightColumnIndex).toBe(-1);
    expect(interp?.rows[0].countryOfOrigin).toBeUndefined();
    expect(interp?.rows[0].weight).toBeUndefined();
  });
});

describe("parseStockOrderCostTsv — quoted embedded newline in header", () => {
  // Real Kanegen header: the weight column header is a CSV-quoted cell
  // with a literal newline. Naive line splitting tore the header in two
  // and misaligned every column; a quote-aware parse keeps it intact.
  const csv = [
    'JAN code,Country of Origin,Order Q\'ty PCS,Total Wholesale Amount YEN,"※Weight in Grams\nper piece. (g)"',
    "4901681506606,Japan,12,9600,33",
    "4901681519309,Japan,20,16000,8",
  ].join("\r\n");

  it("parses the header as one row and resolves the weight column", () => {
    const p = parseStockOrderCostTsv(csv);
    expect(p.unmatchedHeader).toBe(false);
    expect(p.headerRows).toBe(1);
    expect(p.janCol).toBe(0);
    const interp = p.interpretations.find((i) => i.kind === "total");
    expect(interp).toBeTruthy();
    expect(interp!.rows.map((r) => r.jan)).toEqual([
      "4901681506606",
      "4901681519309",
    ]);
    // unit = total / qty = 9600/12 = 800, 16000/20 = 800
    expect(interp!.rows.map((r) => r.unitCostJpy)).toEqual([800, 800]);
    // weight is read from the embedded-newline column, not lost
    expect(interp!.rows.map((r) => r.weight)).toEqual([33, 8]);
  });

  it("buildInterpretation reproduces the same parse for the commit path", () => {
    const interp = buildInterpretation(csv, {
      kind: "total",
      costColumnIndex: 3,
      qtyColumnIndex: 2,
    });
    expect(interp).toBeTruthy();
    expect(interp!.rows[0].weight).toBe(33);
    expect(interp!.rows[0].unitCostJpy).toBe(800);
  });
});
