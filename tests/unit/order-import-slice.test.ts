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
      'JAN Code,Country of Origin,Description,Total Pcs,Carton Number,Unused,Unused2,Unused3,"\u203bWeight in Grams',
      'per piece. (g)"',
      "4900000000013,Thailand,Linebreak Header Item,4,CN-2,,,,350",
    ].join("\n");

    const items = parseRows(null, csv);
    expect(items).toHaveLength(1);
    expect(items[0].countryOfOrigin).toBe("Thailand");
    expect(items[0].weight).toBe(350);
  });
});
