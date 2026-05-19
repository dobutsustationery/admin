import { describe, it, expect } from "vitest";
import { rootReducer } from "$lib/root-reducer";
import {
  start_session,
  append_raw_rows,
  import_batch,
} from "$lib/order-import-slice";
import {
  set_stock_order_meta,
  fix_stock_order,
  update_field,
} from "$lib/inventory";
import {
  selectOrderExceptions,
  previewOrderMetaFix,
  previewStockOrderFix,
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

describe("order-exceptions M3.4 — TSV cost commit", () => {
  // Order import with NO cost column -> unpriced source-tagged lot.
  const NOCOST = [
    "JAN code,Product name,Order Q'ty PCS",
    `${JAN},Widget,10`,
  ].join("\n");
  function unpricedOrder() {
    let s = rootReducer(undefined, { type: "@@INIT" });
    const w = (a: any) => ({ ...a, timestamp: TS });
    s = rootReducer(s, w(start_session({ id: "fc", name: "Supplier C" })));
    s = rootReducer(s, w(append_raw_rows({ rawRows: NOCOST, done: true })));
    s = rootReducer(s, w(import_batch({ filter: "NEW" })));
    return s;
  }

  const tsvPaste = [
    "JAN code\tUNIT PRICE (YEN)\tQuantity",
    `${JAN}\t200\t10`,
  ].join("\n");

  it("one atomic fix_stock_order: meta + reconciled TSV prices the lot", () => {
    let s = unpricedOrder();
    const key = Object.keys(s.inventory.costLedger!).find((k) =>
      k.startsWith(JAN),
    )!;
    expect(s.inventory.costLedger![key][0].unitCostJpy).toBe(0); // unpriced

    // Single action carries the goods value AND the TSV; the TSV
    // reconciles against the just-set value-of-goods.
    s = rootReducer(s, {
      ...fix_stock_order({
        orderId: "fc",
        meta: { valueOfGoodsJpy: 2000 },
        costTsv: tsvPaste,
        overrideExisting: false,
        approveDiscrepancy: false,
      }),
      timestamp: TS,
    } as any);

    expect(s.inventory.stockOrderRegistry!["fc"].valueOfGoodsJpy).toBe(2000);
    expect(s.inventory.costLedger![key][0].unitCostJpy).toBe(200);
    expect(s.inventory.idToItem[key].cost).toBe(200);
  });

  it("non-reconciling TSV is blocked unless discrepancy approved", () => {
    const s0 = unpricedOrder();
    const key = Object.keys(s0.inventory.costLedger!).find((k) =>
      k.startsWith(JAN),
    )!;

    // goods 1999 vs Σ 200*10=2000 -> discrepancy; not approved -> no change
    const s2 = rootReducer(s0, {
      ...fix_stock_order({
        orderId: "fc",
        meta: { valueOfGoodsJpy: 1999 },
        costTsv: tsvPaste,
        overrideExisting: false,
        approveDiscrepancy: false,
      }),
      timestamp: TS,
    } as any);
    expect(s2.inventory.costLedger![key][0].unitCostJpy).toBe(0);
    // meta still applied (atomic, but cost gated separately)
    expect(s2.inventory.stockOrderRegistry!["fc"].valueOfGoodsJpy).toBe(1999);

    // approved -> applied
    const s3 = rootReducer(s0, {
      ...fix_stock_order({
        orderId: "fc",
        meta: { valueOfGoodsJpy: 1999 },
        costTsv: tsvPaste,
        overrideExisting: false,
        approveDiscrepancy: true,
      }),
      timestamp: TS,
    } as any);
    expect(s3.inventory.costLedger![key][0].unitCostJpy).toBe(200);
  });

  it("manual interpretation is used consistently by preview and commit", () => {
    const s0 = unpricedOrder();
    const key = Object.keys(s0.inventory.costLedger!).find((k) =>
      k.startsWith(JAN),
    )!;
    const ambiguousTsv = [
      "JAN code\tUNIT PRICE (YEN)\tQuantity\tTOTAL (YEN)",
      `${JAN}\t200\t10\t1500`,
    ].join("\n");
    const manualUnit = {
      kind: "unit" as const,
      costColumnIndex: 1,
      qtyColumnIndex: 2,
    };

    const pv = previewStockOrderFix(s0.inventory, "fc", {
      meta: { valueOfGoodsJpy: 1500 },
      rawPaste: ambiguousTsv,
      overrideExisting: false,
      approveDiscrepancy: true,
      interpretation: manualUnit,
    });
    expect(pv.reconciliation?.chosen?.kind).toBe("unit");
    expect(pv.reconciliation?.chosen?.sum).toBe(2000);
    expect(pv.items[0].newCostJpy).toBe(200);

    const s1 = rootReducer(s0, {
      ...fix_stock_order({
        orderId: "fc",
        meta: { valueOfGoodsJpy: 1500 },
        costTsv: ambiguousTsv,
        costInterpretation: manualUnit,
        overrideExisting: false,
        approveDiscrepancy: true,
      }),
      timestamp: TS,
    } as any);
    expect(s1.inventory.costLedger![key][0].unitCostJpy).toBe(200);
  });

  it("blocks unmatched TSV rows unless they are explicitly ignored", () => {
    const s = unpricedOrder();
    const withExtra = [
      "JAN code\tUNIT PRICE (YEN)\tQuantity",
      `${JAN}\t200\t10`,
      "9999999999999\t100\t1",
    ].join("\n");

    const blocked = previewStockOrderFix(s.inventory, "fc", {
      meta: { valueOfGoodsJpy: 2100 },
      rawPaste: withExtra,
      overrideExisting: false,
      approveDiscrepancy: false,
    });
    expect(blocked.unmatchedJans).toEqual(["9999999999999"]);
    expect(blocked.blocked).toBe(true);

    const ignored = previewStockOrderFix(s.inventory, "fc", {
      meta: { valueOfGoodsJpy: 2100 },
      rawPaste: withExtra,
      overrideExisting: false,
      approveDiscrepancy: false,
      ignoreUnmatchedRows: true,
    });
    expect(ignored.blocked).toBe(false);
  });

  it("fixes missing COO and weight from matched TSV rows", () => {
    const s0 = unpricedOrder();
    const key = Object.keys(s0.inventory.costLedger!).find((k) =>
      k.startsWith(JAN),
    )!;
    const richTsv = [
      "JAN code\tUNIT PRICE (YEN)\tQuantity\tCountry of Origin\tWeight in Grams per piece",
      `${JAN}\t200\t10\tJapan\t42`,
    ].join("\n");

    const pv = previewStockOrderFix(s0.inventory, "fc", {
      meta: { valueOfGoodsJpy: 2000 },
      rawPaste: richTsv,
      overrideExisting: false,
      approveDiscrepancy: false,
    });
    expect(pv.matchRows[0].canFixCountryOfOrigin).toBe(true);
    expect(pv.matchRows[0].canFixWeight).toBe(true);

    const s1 = rootReducer(s0, {
      ...fix_stock_order({
        orderId: "fc",
        meta: { valueOfGoodsJpy: 2000 },
        costTsv: richTsv,
        overrideExisting: false,
        approveDiscrepancy: false,
        fixCountryOfOrigin: true,
        fixWeights: true,
      }),
      timestamp: TS,
    } as any);

    expect(s1.inventory.idToItem[key].countryOfOrigin).toBe("Japan");
    expect(s1.inventory.idToItem[key].weight).toBe(42);
  });

  it("uses the selected weight tolerance for mismatch warnings", () => {
    let s0 = unpricedOrder();
    const key = Object.keys(s0.inventory.costLedger!).find((k) =>
      k.startsWith(JAN),
    )!;
    s0 = rootReducer(s0, {
      ...update_field({
        id: key,
        field: "weight",
        from: "",
        to: 42,
      }),
      timestamp: TS,
    } as any);
    const richTsv = [
      "JAN code\tUNIT PRICE (YEN)\tQuantity\tWeight in Grams per piece",
      `${JAN}\t200\t10\t42.05`,
    ].join("\n");

    const strict = previewStockOrderFix(s0.inventory, "fc", {
      meta: { valueOfGoodsJpy: 2000 },
      rawPaste: richTsv,
      overrideExisting: false,
      approveDiscrepancy: false,
      weightToleranceG: 0,
    });
    expect(strict.matchRows[0].weightMismatch).toBe(true);
    expect(strict.matchRows[0].kinds).toContain("warning");

    const tolerant = previewStockOrderFix(s0.inventory, "fc", {
      meta: { valueOfGoodsJpy: 2000 },
      rawPaste: richTsv,
      overrideExisting: false,
      approveDiscrepancy: false,
      weightToleranceG: 0.1,
    });
    expect(tolerant.matchRows[0].weightMismatch).toBe(false);
    expect(tolerant.matchRows[0].kinds).not.toContain("warning");
  });
});

describe("order-exceptions M3.5 — unified previewStockOrderFix", () => {
  const NOCOST = [
    "JAN code,Product name,Order Q'ty PCS",
    `${JAN},Widget,10`,
  ].join("\n");
  function unpriced() {
    let s = rootReducer(undefined, { type: "@@INIT" });
    const w = (a: any) => ({ ...a, timestamp: TS });
    s = rootReducer(s, w(start_session({ id: "fp", name: "Supplier P" })));
    s = rootReducer(s, w(append_raw_rows({ rawRows: NOCOST, done: true })));
    s = rootReducer(s, w(import_batch({ filter: "NEW" })));
    return s;
  }
  const tsv = ["JAN code\tUNIT PRICE (YEN)\tQuantity", `${JAN}\t200\t10`].join(
    "\n",
  );

  it("combined preview shows the real old→new (not 0→0) when TSV matches", () => {
    const s = unpriced();
    const pv = previewStockOrderFix(s.inventory, "fp", {
      meta: {
        valueOfGoodsJpy: 2000,
        valueOfOrderJpy: 2000,
        paidAmount: 20,
        paidCurrency: "EUR",
      },
      rawPaste: tsv,
      overrideExisting: false,
      approveDiscrepancy: false,
    });
    expect(pv.reconciliation?.reconciled).toBe(true);
    expect(pv.matched.length).toBe(1);
    expect(pv.items.length).toBe(1);
    // unpriced 0 -> 200 from the TSV, reflected in the ONE combined table
    expect(pv.items[0].oldCostJpy).toBe(0);
    expect(pv.items[0].newCostJpy).toBe(200);
    // fx = 20/2000 = 0.01 -> EUR 2
    expect(pv.fx).toBeCloseTo(0.01, 9);
    expect(pv.items[0].newCostEur).toBeCloseTo(2, 9);
    expect(pv.blocked).toBe(false);
  });

  it("no paste: still previews meta-only effect, items present", () => {
    const s = unpriced();
    const pv = previewStockOrderFix(s.inventory, "fp", {
      meta: { receivedAt: Date.parse("2025-09-01") },
      rawPaste: "",
      overrideExisting: false,
      approveDiscrepancy: false,
    });
    expect(pv.reconciliation).toBeNull();
    expect(pv.affectedLots).toBe(1);
    expect(pv.blocked).toBe(false);
  });
});
