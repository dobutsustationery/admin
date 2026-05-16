import { describe, it, expect } from "vitest";
import { rootReducer } from "$lib/root-reducer";
import {
  start_session,
  append_raw_rows,
  import_batch,
} from "$lib/order-import-slice";

// Regression for docs/investigations/COST_EXCEPTIONS.md bucket A:
// mapOrderToInventory previously dropped `cost`, so order-import-created
// NEW items lost the supplier cost parsed from "unit price (yen)".

const TS = { _seconds: 1_700_000_000, _nanoseconds: 0 };
const JAN = "4542804199999";

// Header is the first appended row (no set_header in production flow).
const CSV = [
  "Bar-Code No.,Product name,Total PCS,UNIT PRICE (YEN)",
  `${JAN},Widget Deluxe,12,JPY 62 `,
].join("\n");

describe("order import populates cost on NEW items", () => {
  it("carries supplier unit price (yen) onto the created inventory item", () => {
    let s = rootReducer(undefined, { type: "@@INIT" });
    s = rootReducer(s, {
      ...start_session({ id: "f1", name: "supplier.csv" }),
      timestamp: TS,
    } as any);
    s = rootReducer(s, {
      ...append_raw_rows({ rawRows: CSV, done: true }),
      timestamp: TS,
    } as any);
    s = rootReducer(s, {
      ...import_batch({ filter: "NEW" }),
      timestamp: TS,
    } as any);

    const item = s.inventory.idToItem[JAN];
    expect(item).toBeDefined();
    expect(item.qty).toBe(12);
    expect(item.cost).toBe(62);
  });
});
