import { describe, it, expect } from "vitest";
import { rootReducer } from "$lib/root-reducer";
import {
  start_session,
  append_raw_rows,
  import_batch,
} from "$lib/order-import-slice";

// docs/investigations/COST_EXCEPTIONS.md bucket B: some supplier CSVs
// (the Kanegen export) have no per-unit price column, only a line
// `Total Wholesale Amount YEN`. Per-unit cost is derived as
//   total / (Order Q'ty PCS * Order Q'ty Unit).
// The historical `unit price (yen)` column must still win when present.

const TS = { _seconds: 1_700_000_000, _nanoseconds: 0 };

function runCsv(csv: string) {
  let s = rootReducer(undefined, { type: "@@INIT" });
  s = rootReducer(s, {
    ...start_session({ id: "f", name: "supplier.csv" }),
    timestamp: TS,
  } as any);
  s = rootReducer(s, {
    ...append_raw_rows({ rawRows: csv, done: true }),
    timestamp: TS,
  } as any);
  s = rootReducer(s, {
    ...import_batch({ filter: "NEW" }),
    timestamp: TS,
  } as any);
  return s.inventory.idToItem;
}

describe("order-import derived supplier cost (bucket B)", () => {
  it("derives cost = Total Wholesale Amount YEN / (PCS * Unit) when no per-unit column", () => {
    const JAN = "4952270317561";
    const csv = [
      "JAN code,Country of Origin,Product name（product number）,Order Q'ty Unit,Order Q'ty PCS,Total Wholesale Amount YEN",
      `${JAN},Japan,LT725 Kalita Black,4,20,"4,700"`,
    ].join("\n");
    const inv = runCsv(csv);
    expect(inv[JAN]).toBeDefined();
    // 4700 / (20 * 4) = 58.75
    expect(inv[JAN].cost).toBeCloseTo(58.75, 5);
  });

  it("still prefers an explicit unit price (yen) over the derived total", () => {
    const JAN = "4900000000123";
    const csv = [
      "JAN code,Order Q'ty Unit,Order Q'ty PCS,Total Wholesale Amount YEN,UNIT PRICE (YEN)",
      `${JAN},4,20,"4,700",JPY 99 `,
    ].join("\n");
    const inv = runCsv(csv);
    expect(inv[JAN].cost).toBe(99);
  });

  it("leaves cost undefined when only a total but no usable PCS*Unit", () => {
    const JAN = "4900000000999";
    const csv = [
      "JAN code,Order Q'ty Unit,Order Q'ty PCS,Total Wholesale Amount YEN",
      `${JAN},0,0,"4,700"`,
    ].join("\n");
    const inv = runCsv(csv);
    expect(inv[JAN]).toBeDefined();
    expect(inv[JAN].cost).toBeUndefined();
  });
});
