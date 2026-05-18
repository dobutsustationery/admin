import { describe, it, expect } from "vitest";
import {
  parseStockOrderCostTsv,
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
    // qty resolves to PCS (20); unit cols 50 & 200; total 1000/20=50
    const sums = p.interpretations.map((i) => i.sum);
    expect(sums).toContain(1000); // 50*20
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

  it("goods unknown: first interpretation, no discrepancy", () => {
    const r = reconcileStockOrderCostTsv(parse, undefined);
    expect(r.reconciled).toBe(false);
    expect(r.discrepancy).toBeUndefined();
    expect(r.rows.length).toBe(2);
  });
});
