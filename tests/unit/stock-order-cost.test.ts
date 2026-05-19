import { describe, it, expect } from "vitest";
import {
  parseStockOrderOrderedQty,
  parseStockOrderUnitCostJpy,
  parseAmount,
  normalizeHeader,
  STOCK_ORDER_UNIT_COST_UNKNOWN,
} from "$lib/stock-order-cost";

// See docs/investigations/DESIGN_INVENTORY_COST_AND_VALUATION.md §6.2

describe("parseAmount", () => {
  it("strips formatting", () => {
    expect(parseAmount(" 4,700 ")).toBe(4700);
    expect(parseAmount("¥1,234.5")).toBe(1234.5);
    expect(parseAmount(282.7)).toBe(282.7);
    expect(parseAmount("-12")).toBe(-12);
  });
  it("returns NaN for empty/garbage", () => {
    expect(Number.isNaN(parseAmount(""))).toBe(true);
    expect(Number.isNaN(parseAmount("  "))).toBe(true);
    expect(Number.isNaN(parseAmount(undefined))).toBe(true);
    expect(Number.isNaN(parseAmount(Number.NaN))).toBe(true);
  });
});

describe("parseStockOrderOrderedQty", () => {
  it("uses a direct PCS quantity when present", () => {
    expect(
      parseStockOrderOrderedQty(
        ["JAN Code", "ORDER \nQ'ty PCS", "UNIT PRICE (YEN)"],
        ["x", "20", "100"],
      ),
    ).toBe(20);
  });

  it("derives quantity from Kanegen unit and line totals", () => {
    expect(
      parseStockOrderOrderedQty(
        ["JAN Code", "UNIT PRICE (YEN)", "TOTAL (YEN)", "TOTAL (BGN)"],
        ["4901681382316", "¥636", "¥6,360", "lev71.68"],
      ),
    ).toBe(10);

    expect(
      parseStockOrderOrderedQty(
        [
          "JAN code",
          "Unit price excluding tax\n（C rank）",
          "estimated\namount",
          "Estimated amount, \ntax included",
        ],
        ["4901681382316", "660", "2,640", "2,904"],
      ),
    ).toBe(4);
  });
});

describe("normalizeHeader", () => {
  it("lowercases and drops non-alphanumerics incl. newlines", () => {
    expect(normalizeHeader("ORDER \nQ'ty PCS")).toBe("orderqtypcs");
    expect(normalizeHeader("Total Wholesale Amount YEN")).toBe(
      "totalwholesaleamountyen",
    );
    expect(normalizeHeader("UNIT PRICE (YEN)")).toBe("unitpriceyen");
  });
});

describe("parseStockOrderUnitCostJpy", () => {
  it("Total Wholesale ÷ PCS, disregarding Q'ty UNIT (Senshu-style)", () => {
    const headers = [
      "JAN code",
      "Order Q'ty Unit",
      "Order Q'ty PCS",
      "Total Wholesale Amount YEN",
    ];
    // UNIT=4 must be ignored; 4700 / 20 = 235  (NOT 4700/(20*4)=58.75)
    const row = ["4952270317561", " 4 ", " 20 ", '" 4,700 "'];
    expect(parseStockOrderUnitCostJpy(headers, row)).toBeCloseTo(235, 9);
  });

  it("uses an explicit per-unit price column when finite", () => {
    const headers = [
      "Bar-Code No.",
      "Q'ty per UNIT",
      "UNIT PRICE (YEN)",
      "ORDER \nQ'ty UNIT",
      "ORDER \nQ'ty PCS",
      "Total Wholesale Amount YEN",
    ];
    const row = ["4542804103342", "6", " 35 ", "4", "30", " 1,050 "];
    // explicit price 35 wins; not confused by "Q'ty per UNIT"/"ORDER Q'ty UNIT"
    expect(parseStockOrderUnitCostJpy(headers, row)).toBe(35);
  });

  it("falls back to total ÷ pcs when explicit price is blank/zero", () => {
    const headers = [
      "UNIT PRICE (YEN)",
      "ORDER \nQ'ty PCS",
      "Total Wholesale Amount YEN",
    ];
    expect(
      parseStockOrderUnitCostJpy(
        ["UNIT PRICE (YEN)", "ORDER \nQ'ty PCS", "Total Wholesale Amount YEN"],
        ["", "10", "1000"],
      ),
    ).toBe(100);
    expect(parseStockOrderUnitCostJpy(headers, [" 0 ", "10", "1000"])).toBe(
      100,
    );
  });

  it("returns the unknown sentinel when not computable", () => {
    const headers = [
      "JAN code",
      "Order Q'ty PCS",
      "Total Wholesale Amount YEN",
    ];
    expect(parseStockOrderUnitCostJpy(headers, ["x", "0", "1000"])).toBe(
      STOCK_ORDER_UNIT_COST_UNKNOWN,
    );
    expect(parseStockOrderUnitCostJpy(headers, ["x", "", ""])).toBe(
      STOCK_ORDER_UNIT_COST_UNKNOWN,
    );
    expect(parseStockOrderUnitCostJpy(["A", "B"], ["1", "2"])).toBe(
      STOCK_ORDER_UNIT_COST_UNKNOWN,
    );
  });

  it("handles a newline inside the PCS header", () => {
    const headers = ["ORDER \nQ'ty PCS", "Total Wholesale Amount YEN"];
    expect(parseStockOrderUnitCostJpy(headers, ["20", "5000"])).toBe(250);
  });

  it("rule 3: derives cost from TOTAL (YEN) ÷ TOTAL PCS when no unit price", () => {
    // Senshu shape: no unit-price col, only a JPY line total + TOTAL PCS.
    const headers = ["JAN Code", "TOTAL PCS", "TOTAL (YEN)", "TOTAL (BGN)"];
    expect(
      parseStockOrderUnitCostJpy(headers, [
        "4977564690045",
        "20",
        "¥2,540",
        "lev28.63",
      ]),
    ).toBe(127); // 2540 / 20
  });

  it("rule 3: ignores lev/BGN totals, picks the yen line total", () => {
    const headers = ["JAN", "TOTAL PCS", "TOTAL (BGN)", "TOTAL AMOUNT YEN"];
    expect(
      parseStockOrderUnitCostJpy(headers, ["x", "10", "lev99", "1000"]),
    ).toBe(100);
  });

  it("rule 3 does not override an explicit unit price (rule 1 wins)", () => {
    const headers = ["JAN", "UNIT PRICE (YEN)", "TOTAL PCS", "TOTAL (YEN)"];
    expect(
      parseStockOrderUnitCostJpy(headers, ["x", "130", "20", "2540"]),
    ).toBe(130); // explicit price, not 2540/20=127
  });
});
