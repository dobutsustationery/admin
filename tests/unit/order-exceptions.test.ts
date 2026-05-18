import { describe, it, expect } from "vitest";
import { rootReducer } from "$lib/root-reducer";
import {
  start_session,
  append_raw_rows,
  import_batch,
} from "$lib/order-import-slice";
import { set_stock_order_meta } from "$lib/inventory";
import {
  selectOrderExceptions,
  previewOrderMetaFix,
  paidToEur,
} from "$lib/order-exceptions";

// M3.2: set_stock_order_meta normalises the real paid currency to EUR
// (lev peg), retro-updates the order's source-tagged lots (date + EUR),
// re-derives cost; selectOrderExceptions flags every gap.
// See docs/investigations/DESIGN_ORDER_EXCEPTIONS_ROUTE.md

const TS = { _seconds: 1_700_000_000, _nanoseconds: 0 };
const JAN = "4543210000001";
const CSV = [
  "JAN code,Product name,Order Q'ty PCS,UNIT PRICE (YEN)",
  `${JAN},Widget, 10 , 200 `,
].join("\n");

function importOrder(id: string, name: string) {
  let s = rootReducer(undefined, { type: "@@INIT" });
  const w = (a: any) => ({ ...a, timestamp: TS });
  s = rootReducer(s, w(start_session({ id, name })));
  s = rootReducer(s, w(append_raw_rows({ rawRows: CSV, done: true })));
  s = rootReducer(s, w(import_batch({ filter: "NEW" })));
  return s;
}

describe("order-exceptions M3.2", () => {
  it("auto-registers the order; selector flags all gaps", () => {
    const s = importOrder("f1", "Supplier A");
    const rows = selectOrderExceptions(s.inventory);
    const r = rows.find((x) => x.orderId === "f1")!;
    expect(r).toBeDefined();
    expect(r.name).toBe("Supplier A");
    expect(r.lotCount).toBe(1);
    expect(r.unpricedCount).toBe(0); // priced ¥200 from the CSV
    expect(r.flags.dateUnknown).toBe(true); // sentinel/absent
    expect(r.flags.orderValueUnknown).toBe(true);
    expect(r.flags.paidUnknown).toBe(true);
    expect(r.isException).toBe(true);
  });

  it("BGN paid amount is normalised to EUR; lots retro-updated", () => {
    let s = importOrder("f1", "Supplier A");
    const T = Date.parse("2025-09-01");
    s = rootReducer(s, {
      ...set_stock_order_meta({
        orderId: "f1",
        meta: {
          receivedAt: T,
          valueOfOrderJpy: 1000,
          paidCurrency: "BGN",
          paidAmount: 195.583, // = 100 EUR at the fixed peg
        },
      }),
      timestamp: TS,
    } as any);

    const m = s.inventory.stockOrderRegistry!["f1"];
    expect(m.totalOrderEur).toBeCloseTo(100, 6);
    // fx = 100 / 1000 = 0.1 ; lot unitCostJpy 200 -> EUR 20 ; at -> T
    const key = Object.keys(s.inventory.costLedger!).find((k) =>
      k.startsWith(JAN),
    )!;
    const lot = s.inventory.costLedger![key].find(
      (e: any) => e.kind === "receipt",
    )!;
    expect(lot.at).toBe(T);
    expect(lot.unitCostEur).toBeCloseTo(20, 6);

    const r = selectOrderExceptions(s.inventory).find(
      (x) => x.orderId === "f1",
    )!;
    expect(r.flags.dateUnknown).toBe(false);
    expect(r.flags.orderValueUnknown).toBe(false);
    expect(r.flags.paidUnknown).toBe(false);
    expect(r.flags.goodsValueUnknown).toBe(true); // still no value-of-goods
    expect(r.isException).toBe(true);
  });

  it("paidToEur normalises BGN via the fixed peg", () => {
    expect(paidToEur({ paidCurrency: "BGN", paidAmount: 195.583 })).toBeCloseTo(
      100,
      6,
    );
    expect(paidToEur({ paidCurrency: "EUR", paidAmount: 250 })).toBe(250);
    expect(paidToEur({ totalOrderEur: 7 })).toBe(7);
  });

  it("previewOrderMetaFix projects date + EUR without mutating state", () => {
    const s = importOrder("f1", "Supplier A");
    const before = JSON.stringify(s.inventory.costLedger);
    const T = Date.parse("2025-09-01");
    const pv = previewOrderMetaFix(s.inventory, "f1", {
      receivedAt: T,
      valueOfOrderJpy: 1000,
      paidCurrency: "BGN",
      paidAmount: 195.583,
    });
    expect(pv.affectedLots).toBe(1);
    expect(pv.fx).toBeCloseTo(0.1, 9);
    expect(pv.items).toHaveLength(1);
    // unitCostJpy 200 -> EUR 20 at fx 0.1
    expect(pv.items[0].newCostEur).toBeCloseTo(20, 6);
    // state untouched by the pure preview
    expect(JSON.stringify(s.inventory.costLedger)).toBe(before);
  });

  it("EUR paid amount passes through unchanged", () => {
    let s = importOrder("f2", "Supplier B");
    s = rootReducer(s, {
      ...set_stock_order_meta({
        orderId: "f2",
        meta: { paidCurrency: "EUR", paidAmount: 250, valueOfOrderJpy: 500 },
      }),
      timestamp: TS,
    } as any);
    expect(s.inventory.stockOrderRegistry!["f2"].totalOrderEur).toBe(250);
  });
});
