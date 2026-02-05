import { describe, expect, it } from "vitest";
import { parseRows } from "../../src/lib/order-import-slice";

describe("order import parsing", () => {
  it("parses country of origin and weight from headed columns", () => {
    const csv = [
      "JAN Code,Country of Origin,Description,Total Pcs,Carton Number,Unused,Unused2,Unused3,\u203bWeight in Grams per piece. (g)",
      "4900000000012,Japan,Test Item,3,CN-1,,,,120",
    ].join("\n");

    const items = parseRows(null, csv);
    expect(items).toHaveLength(1);
    expect(items[0].countryOfOrigin).toBe("Japan");
    expect(items[0].weight).toBe(120);
  });

  it("parses weight when header contains line break", () => {
    const csv = [
      "JAN Code,Country of Origin,Description,Total Pcs,Carton Number,Unused,Unused2,Unused3,\"\u203bWeight in Grams",
      "per piece. (g)\"",
      "4900000000013,Thailand,Linebreak Header Item,4,CN-2,,,,350",
    ].join("\n");

    const items = parseRows(null, csv);
    expect(items).toHaveLength(1);
    expect(items[0].countryOfOrigin).toBe("Thailand");
    expect(items[0].weight).toBe(350);
  });

  it("falls back to column B and column I when headers are unfamiliar", () => {
    const csv = [
      "JAN Code,Col2,Description,Col4,Col5,Col6,Col7,Col8,Col9",
      "4900000000014,Vietnam,Fallback Header Item,x,x,x,x,x,275",
    ].join("\n");

    const items = parseRows(null, csv);
    expect(items).toHaveLength(1);
    expect(items[0].countryOfOrigin).toBe("Vietnam");
    expect(items[0].weight).toBe(275);
  });
});
