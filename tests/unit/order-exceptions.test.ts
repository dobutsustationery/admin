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
  apply_stock_order_costs,
  set_cost_ledger_entries_ignored,
  set_cost_ledger_entry_qty,
  reconstruct_stock_order_unmatched_receipt,
  reconstruct_stock_order_late_scan_receipt,
  mark_stock_order_row_not_received,
  selectStockOrderCostIssues,
  update_field,
  update_item,
  create_stock_order_receipt,
  type Item,
} from "$lib/inventory";
import {
  buildStockOrderScanBatchAudit,
  buildStockOrderScannerAudit,
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

const scanItem = (subtype: string, qty: number): Item => ({
  janCode: JAN,
  subtype,
  description: "Widget",
  hsCode: "48211010",
  image: "",
  qty,
  pieces: 1,
  shipped: 0,
  creationDate: "Nov 14, 2023 (0)",
  timestamp: 0,
});

const scanAction = (
  id: string,
  janCode: string,
  qty: number,
  iso: string,
  description = "Scanned item",
) => {
  const ms = Date.parse(iso);
  return {
    id,
    type: "update_item",
    payload: {
      id: janCode,
      item: {
        janCode,
        subtype: "",
        description,
        hsCode: "",
        image: "",
        qty,
        pieces: 1,
      },
    },
    timestamp: {
      seconds: Math.floor(ms / 1000),
      nanoseconds: (ms % 1000) * 1_000_000,
    },
  };
};

function importOrder(id: string, name: string) {
  let s = rootReducer(undefined, { type: "@@INIT" });
  const w = (a: any) => ({ ...a, timestamp: TS });
  s = rootReducer(s, w(start_session({ id, name })));
  s = rootReducer(s, w(append_raw_rows({ rawRows: CSV, done: true })));
  s = rootReducer(s, w(import_batch({ filter: "NEW" })));
  return s;
}

describe("stock order scan batch audit", () => {
  it("compares order rows to the best matching scan batch window", () => {
    const inventory = {
      stockOrderRegistry: {
        order3: {
          name: "Order 3",
          usesZeroedQuantities: true,
          costRows: [
            { jan: "A", qty: 10, unitCostJpy: 100 },
            { jan: "B", qty: 10, unitCostJpy: 200 },
            { jan: "D", qty: 10, unitCostJpy: 300 },
          ],
        },
      },
    };
    const audit = buildStockOrderScanBatchAudit(inventory as any, [
      scanAction("a1", "A", 10, "2025-01-25T12:00:00Z", "A"),
      scanAction("c1", "C", 4, "2025-01-25T12:05:00Z", "Extra"),
      scanAction("d1", "D\n", 10, "2025-01-26T12:00:00Z", "D"),
      scanAction("b1", "B", 10, "2025-05-04T12:00:00Z", "Late B"),
    ]);

    const row = audit[0];
    expect(row.orderId).toBe("order3");
    expect(new Date(row.startAt!).toISOString().slice(0, 10)).toBe(
      "2025-01-25",
    );
    expect(row.missingOrShort.map((x) => x.jan)).toEqual(["B"]);
    expect(row.extraScans.map((x) => x.jan)).toEqual(["C"]);
    expect(row.unusualCount).toBe(2);
    expect(row.overScanned).toEqual([]);
  });

  it("prefers a cleaner receipt batch over a later broad recount batch", () => {
    const inventory = {
      stockOrderRegistry: {
        order2: {
          name: "Order 2",
          usesZeroedQuantities: true,
          costRows: [
            { jan: "A", qty: 10, unitCostJpy: 100 },
            { jan: "B", qty: 10, unitCostJpy: 100 },
            { jan: "C", qty: 10, unitCostJpy: 100 },
          ],
        },
      },
    };
    const audit = buildStockOrderScanBatchAudit(inventory as any, [
      scanAction("a1", "A", 10, "2024-10-10T12:00:00Z", "A"),
      scanAction("b1", "B", 10, "2024-10-10T12:01:00Z", "B"),
      scanAction("a2", "A", 8, "2025-05-04T12:00:00Z", "A recount"),
      scanAction("b2", "B", 8, "2025-05-04T12:01:00Z", "B recount"),
      scanAction("c2", "C", 8, "2025-05-04T12:02:00Z", "C recount"),
      scanAction("x1", "X", 8, "2025-05-04T12:03:00Z", "Extra 1"),
      scanAction("x2", "Y", 8, "2025-05-04T12:04:00Z", "Extra 2"),
      scanAction("x3", "Z", 8, "2025-05-04T12:05:00Z", "Extra 3"),
    ]);

    const row = audit[0];
    expect(new Date(row.startAt!).toISOString().slice(0, 10)).toBe(
      "2024-10-10",
    );
    expect(row.missingOrShort.map((x) => x.jan)).toEqual(["C"]);
    expect(row.extraScans).toEqual([]);
  });

  it("includes scan stragglers around the main receipt cohort", () => {
    const inventory = {
      stockOrderRegistry: {
        order1: {
          name: "Order 1",
          usesZeroedQuantities: true,
          costRows: [
            { jan: "A", qty: 20, unitCostJpy: 100 },
            { jan: "B", qty: 10, unitCostJpy: 100 },
            { jan: "C", qty: 10, unitCostJpy: 100 },
          ],
        },
      },
    };
    const audit = buildStockOrderScanBatchAudit(inventory as any, [
      scanAction("a1", "A", 20, "2023-11-13T20:53:30Z", "Early A"),
      scanAction("x1", "X", 5, "2023-11-14T12:00:00Z", "Other order"),
      scanAction("x2", "Y", 5, "2023-11-15T12:00:00Z", "Other order"),
      scanAction("x3", "Z", 5, "2023-11-15T12:05:00Z", "Other order"),
      scanAction("b1", "B", 10, "2023-11-16T12:00:00Z", "B"),
      scanAction("c1", "C", 10, "2023-11-17T12:00:00Z", "C"),
      scanAction("a2", "A", 14, "2025-05-04T12:00:00Z", "Later A recount"),
    ]);

    const row = audit[0];
    expect(new Date(row.startAt!).toISOString().slice(0, 10)).toBe(
      "2023-11-13",
    );
    expect(row.missingOrShort).toEqual([]);
    expect(row.scannedOrderQty).toBe(40);
  });

  it("skips orders whose imported quantities were not zeroed", () => {
    const audit = buildStockOrderScanBatchAudit(
      {
        stockOrderRegistry: {
          normalOrder: {
            name: "Normal receipt import",
            usesZeroedQuantities: false,
            costRows: [{ jan: "A", qty: 10, unitCostJpy: 100 }],
          },
          zeroedOrder: {
            name: "Zeroed import",
            usesZeroedQuantities: true,
            costRows: [{ jan: "A", qty: 10, unitCostJpy: 100 }],
          },
        },
      } as any,
      [scanAction("a1", "A", 10, "2025-01-25T12:00:00Z", "A")],
    );

    expect(audit.map((row) => row.orderId)).toEqual(["zeroedOrder"]);
  });

  it("summarizes scanner dates with scans that never matched an order", () => {
    const audit = buildStockOrderScannerAudit(
      {
        stockOrderRegistry: {
          order1: {
            name: "Order 1",
            receivedAt: Date.parse("2025-01-20T00:00:00Z"),
            usesZeroedQuantities: true,
            costRows: [
              { jan: "A", qty: 10, unitCostJpy: 100 },
              { jan: "B", qty: 10, unitCostJpy: 100 },
            ],
          },
          orderWithX: {
            name: "Supplier X",
            receivedAt: Date.parse("2025-01-10T00:00:00Z"),
            usesZeroedQuantities: false,
            costRows: [{ jan: "X", qty: 4, unitCostJpy: 200 }],
          },
          laterOrderWithX: {
            name: "Later Supplier X",
            receivedAt: Date.parse("2025-01-30T00:00:00Z"),
            usesZeroedQuantities: false,
            costRows: [{ jan: "X", qty: 4, unitCostJpy: 200 }],
          },
        },
      } as any,
      [
        scanAction("a1", "A", 10, "2025-01-25T12:00:00Z", "A"),
        scanAction("x1", "X", 4, "2025-01-25T12:05:00Z", "Extra"),
        scanAction("b1", "B", 10, "2025-01-26T12:00:00Z", "B"),
      ],
    );

    expect(audit.rows[0].extraScans.map((row) => row.jan)).toEqual(["X"]);
    expect(audit.unmatchedScanDays).toEqual([
      {
        date: "2025-01-25",
        at: Date.parse("2025-01-25T00:00:00Z"),
        unmatchedScanCount: 1,
        matchedScanCount: 1,
        unmatchedQty: 4,
        matchedQty: 10,
        unmatchedUniqueJans: 1,
        unmatchedJans: ["X"],
        unmatchedJanOrderRefs: [
          {
            jan: "X",
            orders: [
              {
                orderId: "orderWithX",
                label: "Order #1",
                name: "Supplier X",
                receivedAt: Date.parse("2025-01-10T00:00:00Z"),
              },
            ],
          },
        ],
      },
    ]);
  });

  it("attaches late expected-JAN scans without widening the core batch", () => {
    const inventory = {
      stockOrderRegistry: {
        order1: {
          name: "Order 1",
          receivedAt: Date.parse("2025-01-01T00:00:00Z"),
          usesZeroedQuantities: true,
          costRows: [
            { jan: "A", qty: 10, unitCostJpy: 100 },
            { jan: "B", qty: 10, unitCostJpy: 100 },
          ],
        },
      },
    };
    const audit = buildStockOrderScannerAudit(inventory as any, [
      scanAction("a1", "A", 10, "2025-01-02T12:00:00Z", "A"),
      scanAction("x1", "X", 4, "2025-01-20T12:00:00Z", "Unrelated"),
      scanAction("b1", "B", 10, "2025-01-20T12:05:00Z", "Late B"),
    ]);

    const row = audit.rows[0];
    expect(new Date(row.startAt!).toISOString().slice(0, 10)).toBe(
      "2025-01-02",
    );
    expect(new Date(row.endAt! - 1).toISOString().slice(0, 10)).toBe(
      "2025-01-08",
    );
    expect(row.stragglerScanCount).toBe(1);
    expect(row.stragglerScans?.map((scan) => scan.jan)).toEqual(["B"]);
    expect(row.missingOrShort).toEqual([]);
    expect(row.scannedOrderQty).toBe(20);
    expect(row.extraScans).toEqual([]);
    expect(audit.unmatchedScanDays.map((day) => day.date)).toEqual([
      "2025-01-20",
    ]);
    expect(audit.unmatchedScanDays[0].unmatchedJans).toEqual(["X"]);
  });

  it("does not attach expected-JAN stragglers after the next stock order date", () => {
    const inventory = {
      stockOrderRegistry: {
        order1: {
          name: "Order 1",
          receivedAt: Date.parse("2025-01-01T00:00:00Z"),
          usesZeroedQuantities: true,
          costRows: [{ jan: "A", qty: 20, unitCostJpy: 100 }],
        },
        order2: {
          name: "Order 2",
          receivedAt: Date.parse("2025-01-15T00:00:00Z"),
          usesZeroedQuantities: false,
          costRows: [{ jan: "B", qty: 1, unitCostJpy: 100 }],
        },
      },
    };
    const audit = buildStockOrderScannerAudit(inventory as any, [
      scanAction("a1", "A", 10, "2025-01-02T12:00:00Z", "A"),
      scanAction("a2", "A", 10, "2025-01-20T12:00:00Z", "Too late A"),
    ]);

    const row = audit.rows[0];
    expect(row.stragglerScanCount).toBe(0);
    expect(row.missingOrShort[0].gap).toBe(10);
    expect(audit.unmatchedScanDays[0].unmatchedJans).toEqual(["A"]);
  });
});

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

  it("sorts stock orders by receipt date with unknown dates last", () => {
    const rows = selectOrderExceptions({
      stockOrderRegistry: {
        later: {
          name: "B Later",
          receivedAt: Date.parse("2025-02-01T00:00:00Z"),
        },
        unknown: { name: "C Unknown" },
        earlier: {
          name: "A Earlier",
          receivedAt: Date.parse("2025-01-01T00:00:00Z"),
        },
      },
      costLedger: {},
    } as any);

    expect(rows.map((row) => row.orderId)).toEqual([
      "earlier",
      "later",
      "unknown",
    ]);
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

  it("fix_stock_order can price eligible zeroed scan receipts once the real order date is known", () => {
    let s = rootReducer(undefined, { type: "@@INIT" });
    s = rootReducer(s, {
      ...update_item({ id: `${JAN}Blue`, item: scanItem("Blue", 12) }),
      timestamp: { _seconds: 200, _nanoseconds: 0 },
    } as any);
    s = rootReducer(s, {
      ...update_item({ id: `${JAN}Pink`, item: scanItem("Pink", 12) }),
      timestamp: { _seconds: 210, _nanoseconds: 0 },
    } as any);

    const richTsv = [
      "JAN code\tUNIT PRICE (YEN)\tQuantity\tCountry of Origin\tWeight in Grams per piece",
      `${JAN}\t100\t24\tJapan\t42`,
    ].join("\n");

    const preview = previewStockOrderFix(s.inventory, "fc", {
      meta: {
        receivedAt: 150_000,
        valueOfGoodsJpy: 2400,
        valueOfOrderJpy: 2400,
        paidCurrency: "EUR",
        paidAmount: 24,
      },
      rawPaste: richTsv,
      overrideExisting: false,
      approveDiscrepancy: false,
    });

    expect(
      preview.items.map((item) => [
        item.key,
        item.oldCostJpy,
        item.newCostJpy,
        item.oldCostEur,
        item.newCostEur,
      ]),
    ).toEqual([
      [`${JAN}Blue`, 0, 100, 0, 1],
      [`${JAN}Pink`, 0, 100, 0, 1],
    ]);
    expect(
      preview.matchRows.map((row) => [
        row.key,
        row.status,
        row.canFixCountryOfOrigin,
        row.canFixWeight,
      ]),
    ).toEqual([
      [`${JAN}Blue`, "Fix cost", true, true],
      [`${JAN}Pink`, "Metadata match", true, true],
    ]);

    s = rootReducer(s, {
      ...fix_stock_order({
        orderId: "fc",
        meta: {
          receivedAt: 150_000,
          valueOfGoodsJpy: 2400,
          valueOfOrderJpy: 2400,
          paidCurrency: "EUR",
          paidAmount: 24,
        },
        costTsv: richTsv,
        overrideExisting: false,
        approveDiscrepancy: false,
        fixCountryOfOrigin: true,
        fixWeights: true,
      }),
      timestamp: TS,
    } as any);

    expect(
      (s.inventory.costLedger![`${JAN}Blue`] as any[]).map((e) => [
        e.qty,
        e.unitCostJpy,
        e.unitCostEur,
        e.costOrderId,
      ]),
    ).toEqual([[12, 100, 1, "fc"]]);
    expect(
      (s.inventory.costLedger![`${JAN}Pink`] as any[]).map((e) => [
        e.qty,
        e.unitCostJpy,
        e.unitCostEur,
        e.costOrderId,
      ]),
    ).toEqual([[12, 100, 1, "fc"]]);
    expect(s.inventory.idToItem[`${JAN}Blue`].countryOfOrigin).toBe("Japan");
    expect(s.inventory.idToItem[`${JAN}Blue`].weight).toBe(42);
    expect(s.inventory.idToItem[`${JAN}Pink`].countryOfOrigin).toBe("Japan");
    expect(s.inventory.idToItem[`${JAN}Pink`].weight).toBe(42);
  });

  it("aggregates duplicate stock-order rows before matching scan receipts", () => {
    let s = rootReducer(undefined, { type: "@@INIT" });
    s = rootReducer(s, {
      ...update_item({ id: `${JAN}Blue`, item: scanItem("Blue", 20) }),
      timestamp: { _seconds: 200, _nanoseconds: 0 },
    } as any);

    const duplicateRows = [
      "JAN code\tUNIT PRICE (YEN)\tQuantity",
      `${JAN}\t200\t10`,
      `${JAN}\t200\t10`,
    ].join("\n");
    const meta = {
      receivedAt: 150_000,
      valueOfGoodsJpy: 4000,
      valueOfOrderJpy: 4000,
      expectedItemCount: 20,
      paidCurrency: "EUR",
      paidAmount: 40,
    } as const;

    const preview = previewStockOrderFix(s.inventory, "fc", {
      meta,
      rawPaste: duplicateRows,
      overrideExisting: false,
      approveDiscrepancy: false,
    });

    expect(preview.reconciliation?.rows).toHaveLength(2);
    expect(preview.reconciliation?.qtySum).toBe(20);
    expect(preview.items.map((item) => [item.key, item.newCostJpy])).toEqual([
      [`${JAN}Blue`, 200],
    ]);
    expect(preview.blocked).toBe(false);

    s = rootReducer(s, {
      ...fix_stock_order({
        orderId: "fc",
        meta,
        costTsv: duplicateRows,
        overrideExisting: false,
        approveDiscrepancy: false,
      }),
      timestamp: TS,
    } as any);

    const receipt = s.inventory.costLedger![`${JAN}Blue`][0] as any;
    expect(receipt.qty).toBe(20);
    expect(receipt.unitCostJpy).toBe(200);
    expect(receipt.unitCostEur).toBe(2);
    expect(receipt.costOrderId).toBe("fc");
    expect(receipt.auditSeverity).toBeUndefined();
    expect(receipt.auditComment).toBeUndefined();
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

  it("blocks item-count discrepancies unless explicitly approved", () => {
    const s0 = unpricedOrder();
    const key = Object.keys(s0.inventory.costLedger!).find((k) =>
      k.startsWith(JAN),
    )!;

    const blockedPreview = previewStockOrderFix(s0.inventory, "fc", {
      meta: { valueOfGoodsJpy: 2000, expectedItemCount: 9 },
      rawPaste: tsvPaste,
      overrideExisting: false,
      approveDiscrepancy: false,
    });
    expect(blockedPreview.reconciliation?.qtySum).toBe(10);
    expect(blockedPreview.reconciliation?.itemCountDiscrepancy).toBe(1);
    expect(blockedPreview.blocked).toBe(true);

    const s1 = rootReducer(s0, {
      ...fix_stock_order({
        orderId: "fc",
        meta: { valueOfGoodsJpy: 2000, expectedItemCount: 9 },
        costTsv: tsvPaste,
        overrideExisting: false,
        approveDiscrepancy: false,
      }),
      timestamp: TS,
    } as any);
    expect(s1.inventory.stockOrderRegistry!["fc"].expectedItemCount).toBe(9);
    expect(s1.inventory.costLedger![key][0].unitCostJpy).toBe(0);

    const s2 = rootReducer(s0, {
      ...fix_stock_order({
        orderId: "fc",
        meta: { valueOfGoodsJpy: 2000, expectedItemCount: 9 },
        costTsv: tsvPaste,
        overrideExisting: false,
        approveDiscrepancy: true,
      }),
      timestamp: TS,
    } as any);
    expect(s2.inventory.costLedger![key][0].unitCostJpy).toBe(200);
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

  it("recomputes auto interpretation on replay when no manual override is stored", () => {
    const s0 = unpricedOrder();
    const key = Object.keys(s0.inventory.costLedger!).find((k) =>
      k.startsWith(JAN),
    )!;
    const ambiguousTsv = [
      "JAN code\tUNIT PRICE (YEN)\tQuantity\tTOTAL (YEN)",
      `${JAN}\t200\t10\t1500`,
    ].join("\n");
    const s1 = rootReducer(s0, {
      ...fix_stock_order({
        orderId: "fc",
        meta: { valueOfGoodsJpy: 1500 },
        costTsv: ambiguousTsv,
        overrideExisting: false,
        approveDiscrepancy: false,
      }),
      timestamp: TS,
    } as any);

    expect(s1.inventory.costLedger![key][0].unitCostJpy).toBe(150);
  });

  it("forces stored interpretation on replay when marked manual", () => {
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

    const committed = rootReducer(s, {
      ...fix_stock_order({
        orderId: "fc",
        meta: { valueOfGoodsJpy: 2100 },
        costTsv: withExtra,
        overrideExisting: false,
        approveDiscrepancy: false,
        ignoreUnmatchedRows: true,
      }),
      timestamp: TS,
    } as any);
    expect(committed.inventory.stockOrderRegistry!["fc"].costIssues).toEqual([
      {
        kind: "unmatched-row",
        jan: "9999999999999",
        qty: 1,
        expectedQty: 1,
        matchedQty: 0,
        unitCostJpy: 100,
        lineCostJpy: 100,
      },
    ]);
  });

  it("treats existing inventory metadata without an order lot as unmatched", () => {
    const extraJan = "9999999999999";
    let s = unpricedOrder();
    s = rootReducer(s, {
      ...update_item({
        id: extraJan,
        item: {
          ...scanItem("", 1),
          janCode: extraJan,
          description: "Extra item",
        },
      }),
      timestamp: TS,
    } as any);
    const withExtra = [
      "JAN code\tUNIT PRICE (YEN)\tQuantity",
      `${JAN}\t200\t10`,
      `${extraJan}\t100\t1`,
    ].join("\n");

    const blocked = previewStockOrderFix(s.inventory, "fc", {
      meta: { valueOfGoodsJpy: 2100 },
      rawPaste: withExtra,
      overrideExisting: false,
      approveDiscrepancy: false,
    });

    expect(blocked.unmatchedJans).toEqual([extraJan]);
    expect(blocked.blocked).toBe(true);
    expect(
      blocked.matchRows
        .filter((row) => row.jan === extraJan)
        .map((row) => [row.key, row.status, row.isUnmatched]),
    ).toEqual([[extraJan, "No lot in this order", true]]);
  });

  it("does not block after creating a stock-order inventory receipt", () => {
    const extraJan = "9999999999999";
    let s = unpricedOrder();
    s = rootReducer(s, {
      ...update_item({
        id: extraJan,
        item: {
          ...scanItem("", 1),
          janCode: extraJan,
          description: "Extra item",
        },
      }),
      timestamp: TS,
    } as any);
    const withExtra = [
      "JAN code\tUNIT PRICE (YEN)\tQuantity",
      `${JAN}\t200\t10`,
      `${extraJan}\t100\t1`,
    ].join("\n");
    s = rootReducer(s, {
      ...fix_stock_order({
        orderId: "fc",
        meta: { valueOfGoodsJpy: 2100 },
        costTsv: withExtra,
        overrideExisting: false,
        approveDiscrepancy: false,
        ignoreUnmatchedRows: true,
      }),
      timestamp: TS,
    } as any);
    const receiptAction = create_stock_order_receipt({
      orderId: "fc",
      itemKey: extraJan,
    });
    s = rootReducer(s, {
      ...receiptAction,
      timestamp: TS,
    } as any);
    s = rootReducer(s, {
      ...receiptAction,
      timestamp: TS,
    } as any);

    expect(
      s.inventory.costLedger![extraJan].filter(
        (entry: any) =>
          entry.kind === "receipt" && entry.source === "stockOrder:fc",
      ),
    ).toHaveLength(1);
    expect(s.inventory.idToItem[extraJan].qty).toBe(2);
    const preview = previewStockOrderFix(s.inventory, "fc", {
      meta: { valueOfGoodsJpy: 2100 },
      rawPaste: withExtra,
      overrideExisting: false,
      approveDiscrepancy: false,
    });

    expect(preview.unmatchedJans).toEqual([]);
    expect(preview.blocked).toBe(false);
    expect(
      preview.matchRows
        .filter((row) => row.jan === extraJan)
        .map((row) => [row.key, row.status, row.isUnmatched]),
    ).toEqual([[extraJan, "Matched, existing cost", false]]);
  });

  it("records stock order overmatches when attached lots exceed row qty", () => {
    const s = unpricedOrder();
    const shortPaste = [
      "JAN code\tUNIT PRICE (YEN)\tQuantity",
      `${JAN}\t200\t9`,
    ].join("\n");

    const committed = rootReducer(s, {
      ...fix_stock_order({
        orderId: "fc",
        meta: { valueOfGoodsJpy: 1800 },
        costTsv: shortPaste,
        overrideExisting: false,
        approveDiscrepancy: false,
      }),
      timestamp: TS,
    } as any);
    expect(committed.inventory.stockOrderRegistry!["fc"].costIssues).toEqual([
      {
        kind: "overmatched-row",
        jan: JAN,
        qty: 1,
        expectedQty: 9,
        matchedQty: 10,
        unitCostJpy: 200,
        lineCostJpy: 200,
      },
    ]);
  });

  it("materializes late stock order scans in the cost issue refresh pass", () => {
    const orderId = "order-late-refresh";
    const jan = "4560103149144";
    const key = `${jan}Bear`;
    const firstScanAt = Date.parse("2023-11-13T20:52:47Z");
    const lateScanAt = Date.parse("2025-05-04T14:48:55Z");
    let s = rootReducer(undefined, { type: "@@INIT" });
    s = {
      ...s,
      inventory: {
        ...s.inventory,
        idToItem: {
          [key]: {
            janCode: jan,
            subtype: "Bear",
            description: "Mini Card Set",
            hsCode: "49090000",
            image: "",
            qty: 18,
            pieces: 1,
            shipped: 0,
            creationDate: "May 4, 2025 (18)",
            timestamp: lateScanAt,
            cost: 100,
          },
        },
        costLedger: {
          [key]: [
            {
              kind: "receipt",
              at: firstScanAt,
              seq: 0,
              qty: 20,
              unitCostJpy: 100,
              unitCostEur: 0.65,
              source: "update_item",
              costOrderId: orderId,
            },
            {
              kind: "receipt",
              at: lateScanAt,
              seq: 1,
              qty: 18,
              unitCostJpy: 100,
              unitCostEur: 0.65,
              source: "update_item",
              costOrderId: orderId,
            },
          ],
        },
        stockOrderRegistry: {
          [orderId]: {
            name: "Order with late recount",
            receivedAt: Date.parse("2023-08-23T00:00:00Z"),
            usesZeroedQuantities: true,
            costRows: [{ jan, unitCostJpy: 100, qty: 20 }],
            costIssues: [],
          },
        },
      },
    } as any;

    const refreshed = rootReducer(s, {
      ...apply_stock_order_costs({
        orderId,
        rows: [{ jan, unitCostJpy: 100, qty: 20 }],
        overrideExisting: false,
      }),
      timestamp: TS,
    } as any);

    expect(refreshed.inventory.stockOrderRegistry![orderId].costIssues).toEqual(
      [
        {
          kind: "late-scan",
          jan,
          itemKey: key,
          qty: 18,
          expectedQty: 0,
          matchedQty: 18,
          unitCostJpy: 100,
          lineCostJpy: 1800,
          scanAt: lateScanAt,
          source: "update_item",
        },
      ],
    );
  });

  it("refreshes stock order match issues after a manual ledger qty adjustment", () => {
    const s = unpricedOrder();
    const shortPaste = [
      "JAN code\tUNIT PRICE (YEN)\tQuantity",
      `${JAN}\t200\t9`,
    ].join("\n");

    let committed = rootReducer(s, {
      ...fix_stock_order({
        orderId: "fc",
        meta: { valueOfGoodsJpy: 1800 },
        costTsv: shortPaste,
        overrideExisting: false,
        approveDiscrepancy: false,
      }),
      timestamp: TS,
    } as any);
    expect(committed.inventory.stockOrderRegistry!["fc"].costIssues).toEqual([
      expect.objectContaining({
        kind: "overmatched-row",
        jan: JAN,
        expectedQty: 9,
        matchedQty: 10,
      }),
    ]);

    const key = Object.keys(committed.inventory.costLedger!).find((k) =>
      k.startsWith(JAN),
    )!;
    const entry = committed.inventory.costLedger![key][0] as any;
    committed = rootReducer(committed, {
      ...set_cost_ledger_entry_qty({
        itemKey: key,
        ref: {
          kind: "receipt",
          at: entry.at,
          seq: entry.seq,
          qty: entry.qty,
          unitCostJpy: entry.unitCostJpy,
          unitCostEur: entry.unitCostEur,
          source: entry.source || "",
          costOrderId: entry.costOrderId || "",
        },
        qty: 9,
        note: "operator confirmed one less unit",
      }),
      timestamp: TS,
    } as any);

    expect(committed.inventory.stockOrderRegistry!["fc"].costIssues).toEqual(
      [],
    );
  });

  it("refreshes stock order match issues after ledger rows are ignored or restored", () => {
    const s = unpricedOrder();
    const shortPaste = [
      "JAN code\tUNIT PRICE (YEN)\tQuantity",
      `${JAN}\t200\t9`,
    ].join("\n");

    let committed = rootReducer(s, {
      ...fix_stock_order({
        orderId: "fc",
        meta: { valueOfGoodsJpy: 1800 },
        costTsv: shortPaste,
        overrideExisting: false,
        approveDiscrepancy: false,
      }),
      timestamp: TS,
    } as any);
    expect(committed.inventory.stockOrderRegistry!["fc"].costIssues).toEqual([
      expect.objectContaining({
        kind: "overmatched-row",
        jan: JAN,
        expectedQty: 9,
        matchedQty: 10,
      }),
    ]);

    const key = Object.keys(committed.inventory.costLedger!).find((k) =>
      k.startsWith(JAN),
    )!;
    const entry = committed.inventory.costLedger![key][0] as any;
    const ref = {
      kind: "receipt" as const,
      at: entry.at,
      seq: entry.seq,
      qty: entry.qty,
      unitCostJpy: entry.unitCostJpy,
      unitCostEur: entry.unitCostEur,
      source: entry.source || "",
      costOrderId: entry.costOrderId || "",
    };

    committed = rootReducer(committed, {
      ...set_cost_ledger_entries_ignored({
        itemKey: key,
        refs: [ref],
        ignored: true,
        reason: "not part of this order",
      }),
      timestamp: TS,
    } as any);

    expect(committed.inventory.stockOrderRegistry!["fc"].costIssues).toEqual([
      expect.objectContaining({
        kind: "unmatched-row",
        jan: JAN,
        expectedQty: 9,
        matchedQty: 0,
      }),
    ]);

    committed = rootReducer(committed, {
      ...set_cost_ledger_entries_ignored({
        itemKey: key,
        refs: [ref],
        ignored: false,
      }),
      timestamp: TS,
    } as any);

    expect(committed.inventory.stockOrderRegistry!["fc"].costIssues).toEqual([
      expect.objectContaining({
        kind: "overmatched-row",
        jan: JAN,
        expectedQty: 9,
        matchedQty: 10,
      }),
    ]);
  });

  it("derives stock order match issues from effective ledger entries", () => {
    const orderId = "order-1";
    const jan = "4902778185650";
    const receiptAt = Date.parse("2023-11-16T19:16:48.833Z");
    const s = rootReducer(undefined, { type: "@@INIT" }) as any;
    s.inventory = {
      ...s.inventory,
      idToItem: {
        [jan]: {
          janCode: jan,
          subtype: "",
          description: "Mechanical Pencil",
          hsCode: "96084000",
          image: "",
          qty: 0,
          pieces: 1,
          shipped: 0,
          creationDate: "Nov 16, 2023 (20)",
          timestamp: receiptAt,
          cost: 282.7,
        },
      },
      costLedger: {
        [jan]: [
          {
            kind: "receipt",
            at: receiptAt,
            seq: 0,
            qty: 20,
            unitCostJpy: 282.7,
            unitCostEur: 1.8,
            source: "update_item",
            costOrderId: orderId,
          },
          {
            kind: "receipt",
            at: receiptAt,
            seq: 0.001,
            qty: -10,
            unitCostJpy: 0,
            unitCostEur: 0,
            source: "update_item",
            originalQty: 20,
            auditComment:
              "Reducer qty correction reduced this receipt by 10 unit(s).",
            adjustmentEntry: true,
            adjustmentMode: "apply-to-target",
            adjustmentTarget: { at: receiptAt, seq: 0 },
            ignored: true,
            ignoreReason: "Ignore mistaken qty correction; all inventory sold",
          },
        ],
      },
      stockOrderRegistry: {
        [orderId]: {
          receivedAt: Date.parse("2023-08-23T00:00:00Z"),
          usesZeroedQuantities: true,
          costRows: [{ jan, unitCostJpy: 282.7, qty: 20 }],
          costIssues: [
            {
              kind: "unmatched-row",
              jan,
              qty: 10,
              expectedQty: 20,
              matchedQty: 10,
              unitCostJpy: 282.7,
              lineCostJpy: 2827,
            },
          ],
        },
      },
    };

    expect(selectStockOrderCostIssues(s.inventory, orderId)).toEqual([]);
  });

  it("reconstructs the full zeroed-order receipt, ignores the recount, and records a historical sale", () => {
    const orderId = "order1";
    const jan = "4977564720711";
    const key = `${jan}Lightbulbs`;
    const receivedAt = Date.parse("2023-08-23T00:00:00Z");
    const scanAt = Date.parse("2025-05-04T14:36:01Z");
    const saleAt = Date.parse("2025-05-10T00:00:00Z");
    let s = rootReducer(undefined, { type: "@@INIT" });
    s = {
      ...s,
      inventory: {
        ...s.inventory,
        idToItem: {
          [key]: {
            janCode: jan,
            subtype: "Lightbulbs",
            description: "Plus Deco Rush",
            hsCode: "39191080",
            image: "",
            qty: 9,
            pieces: 1,
            shipped: 1,
            creationDate: "May 4, 2025 (9)",
            timestamp: scanAt,
            cost: 178.2,
          },
        },
        costLedger: {
          [key]: [
            {
              kind: "receipt",
              at: scanAt,
              seq: 0,
              qty: 9,
              unitCostJpy: 178.2,
              unitCostEur: 1.1,
              source: "update_item",
              costOrderId: orderId,
            },
            {
              kind: "sale",
              at: Date.parse("2026-01-27T21:19:18Z"),
              seq: 1,
              qty: 1,
            },
          ],
        },
        idToHistory: { [key]: [] },
        stockOrderRegistry: {
          [orderId]: {
            name: "Order 1",
            receivedAt,
            usesZeroedQuantities: true,
            valueOfOrderJpy: 90559,
            paidAmount: 1150.46,
            paidCurrency: "BGN",
            totalOrderEur: 1150.46 / 1.95583,
            costRows: [{ jan, unitCostJpy: 178.2, qty: 10 }],
            costIssues: [
              {
                kind: "unmatched-row",
                jan,
                qty: 1,
                expectedQty: 10,
                matchedQty: 9,
                unitCostJpy: 178.2,
                lineCostJpy: 178.2,
              },
            ],
          },
        },
      },
    } as any;

    const next = rootReducer(s, {
      ...reconstruct_stock_order_unmatched_receipt({
        orderId,
        itemKey: key,
        saleAt,
        note: "operator confirmed one unit was sold at Japan Festival 2025",
        saleNote: "sold at Japan Festival 2025",
      }),
      timestamp: TS,
    } as any);

    const ledger = next.inventory.costLedger![key] as any[];
    expect(ledger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "receipt",
          at: receivedAt,
          qty: 10,
          unitCostJpy: 178.2,
          source: `stockOrder:${orderId}`,
          costOrderId: orderId,
          auditComment: expect.stringContaining(
            "Reconstructed stock order receipt",
          ),
        }),
        expect.objectContaining({
          kind: "sale",
          at: saleAt,
          qty: 1,
          auditComment: expect.stringContaining("Historical sale adjustment"),
        }),
      ]),
    );
    expect(ledger[0]).toEqual(
      expect.objectContaining({
        kind: "receipt",
        qty: 9,
        ignored: true,
        auditComment: expect.stringContaining("Ignored recount receipt"),
      }),
    );
    expect(next.inventory.stockOrderRegistry![orderId].costIssues).toEqual([]);
    expect(next.inventory.idToHistory[key]).toEqual([
      expect.objectContaining({
        desc: expect.stringContaining(
          "Reconstructed full 10 unit stock order receipt",
        ),
      }),
    ]);
  });

  it("marks an unmatched stock order row as not accepted or received", () => {
    const orderId = "order-rejected";
    const jan = "4901680123187";
    let s = rootReducer(undefined, { type: "@@INIT" });
    s = {
      ...s,
      inventory: {
        ...s.inventory,
        costLedger: {},
        stockOrderRegistry: {
          [orderId]: {
            name: "Rejected Item Order",
            receivedAt: Date.parse("2025-01-25T00:00:00Z"),
            usesZeroedQuantities: true,
            costRows: [{ jan, unitCostJpy: 120, qty: 4 }],
            costIssues: [
              {
                kind: "unmatched-row",
                jan,
                qty: 4,
                expectedQty: 4,
                matchedQty: 0,
                unitCostJpy: 120,
                lineCostJpy: 480,
              },
            ],
          },
        },
      },
    } as any;

    const next = rootReducer(s, {
      ...mark_stock_order_row_not_received({
        orderId,
        jan,
        note: "Rejected from inventory on receipt inspection",
      }),
      timestamp: TS,
    } as any);

    expect(next.inventory.stockOrderRegistry![orderId].notReceivedRows).toEqual(
      [
        expect.objectContaining({
          jan,
          qty: 4,
          unitCostJpy: 120,
          note: "Rejected from inventory on receipt inspection",
        }),
      ],
    );
    expect(next.inventory.stockOrderRegistry![orderId].costIssues).toEqual([]);
  });

  it("reconstructs an order-date receipt for a late scan", () => {
    const orderId = "order-late";
    const jan = "4542804085181";
    const key = `${jan}Blue`;
    const otherKey = "4542804000000";
    const receivedAt = Date.parse("2025-01-25T00:00:00Z");
    const firstScanAt = Date.parse("2025-01-26T12:00:00Z");
    const lateScanAt = Date.parse("2025-04-10T12:00:00Z");
    let s = rootReducer(undefined, { type: "@@INIT" });
    s = {
      ...s,
      inventory: {
        ...s.inventory,
        idToItem: {
          [key]: {
            janCode: jan,
            subtype: "Blue",
            description: "Late scanned item",
            hsCode: "39191080",
            image: "",
            qty: 5,
            pieces: 1,
            shipped: 0,
            creationDate: "Apr 10, 2025 (5)",
            timestamp: lateScanAt,
            cost: 80,
          },
          [otherKey]: {
            janCode: "4542804000000",
            subtype: "",
            description: "Earlier scanned item",
            hsCode: "39191080",
            image: "",
            qty: 1,
            pieces: 1,
            shipped: 0,
            creationDate: "Jan 26, 2025 (1)",
            timestamp: firstScanAt,
            cost: 10,
          },
        },
        costLedger: {
          [key]: [
            {
              kind: "receipt",
              at: lateScanAt,
              seq: 0,
              qty: 5,
              unitCostJpy: 80,
              unitCostEur: 0.5,
              source: "update_item",
              costOrderId: orderId,
            },
          ],
          [otherKey]: [
            {
              kind: "receipt",
              at: firstScanAt,
              seq: 0,
              qty: 1,
              unitCostJpy: 10,
              unitCostEur: 0.06,
              source: "update_item",
              costOrderId: orderId,
            },
          ],
        },
        idToHistory: { [key]: [] },
        stockOrderRegistry: {
          [orderId]: {
            name: "Late Scan Order",
            receivedAt,
            usesZeroedQuantities: true,
            valueOfOrderJpy: 400,
            totalOrderEur: 2.5,
            costRows: [{ jan, unitCostJpy: 80, qty: 5 }],
            costIssues: [],
          },
        },
      },
    } as any;

    const next = rootReducer(s, {
      ...reconstruct_stock_order_late_scan_receipt({
        orderId,
        itemKey: key,
        note: "late scan should become an order-date receipt",
      }),
      timestamp: TS,
    } as any);

    const ledger = next.inventory.costLedger![key] as any[];
    expect(ledger[0]).toEqual(
      expect.objectContaining({
        kind: "receipt",
        qty: 5,
        ignored: true,
        auditComment: expect.stringContaining("Ignored late scan receipt"),
      }),
    );
    expect(ledger).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "receipt",
          at: receivedAt,
          qty: 5,
          source: `stockOrder:${orderId}`,
          costOrderId: orderId,
          auditComment: expect.stringContaining(
            "Reconstructed stock order receipt",
          ),
        }),
      ]),
    );
    expect(next.inventory.stockOrderRegistry![orderId].costIssues).toEqual([]);
    expect(next.inventory.idToHistory[key]).toEqual([
      expect.objectContaining({
        desc: expect.stringContaining("Reconstructed 5 stock order unit"),
      }),
    ]);
  });

  it("splits a reconstructed late-scan receipt across subtypes for the same JAN", () => {
    const orderId = "order-late-subtypes";
    const jan = "4542804085181";
    const blueKey = `${jan}Blue`;
    const pinkKey = `${jan}Pink`;
    const otherKey = "4542804000000";
    const receivedAt = Date.parse("2025-01-25T00:00:00Z");
    const firstScanAt = Date.parse("2025-01-26T12:00:00Z");
    const lateScanAt = Date.parse("2025-05-04T12:00:00Z");
    let s = rootReducer(undefined, { type: "@@INIT" });
    s = {
      ...s,
      inventory: {
        ...s.inventory,
        idToItem: {
          [blueKey]: {
            janCode: jan,
            subtype: "Blue",
            description: "Late scanned item",
            hsCode: "39191080",
            image: "",
            qty: 12,
            pieces: 1,
            shipped: 0,
            creationDate: "May 4, 2025 (12)",
            timestamp: lateScanAt,
            cost: 65,
          },
          [pinkKey]: {
            janCode: jan,
            subtype: "Pink",
            description: "Late scanned item",
            hsCode: "39191080",
            image: "",
            qty: 12,
            pieces: 1,
            shipped: 0,
            creationDate: "May 4, 2025 (12)",
            timestamp: lateScanAt,
            cost: 65,
          },
          [otherKey]: {
            janCode: "4542804000000",
            subtype: "",
            description: "Earlier scanned item",
            hsCode: "39191080",
            image: "",
            qty: 1,
            pieces: 1,
            shipped: 0,
            creationDate: "Jan 26, 2025 (1)",
            timestamp: firstScanAt,
            cost: 10,
          },
        },
        costLedger: {
          [blueKey]: [
            {
              kind: "receipt",
              at: lateScanAt,
              seq: 0,
              qty: 12,
              unitCostJpy: 65,
              unitCostEur: 0.4,
              source: "update_item",
              costOrderId: orderId,
            },
          ],
          [pinkKey]: [
            {
              kind: "receipt",
              at: lateScanAt,
              seq: 0,
              qty: 12,
              unitCostJpy: 65,
              unitCostEur: 0.4,
              source: "update_item",
              costOrderId: orderId,
            },
          ],
          [otherKey]: [
            {
              kind: "receipt",
              at: firstScanAt,
              seq: 0,
              qty: 1,
              unitCostJpy: 10,
              unitCostEur: 0.06,
              source: "update_item",
              costOrderId: orderId,
            },
          ],
        },
        idToHistory: { [blueKey]: [], [pinkKey]: [] },
        stockOrderRegistry: {
          [orderId]: {
            name: "Late Scan Order",
            receivedAt,
            usesZeroedQuantities: true,
            valueOfOrderJpy: 780,
            totalOrderEur: 4.8,
            costRows: [{ jan, unitCostJpy: 65, qty: 12 }],
            costIssues: [],
          },
        },
      },
    } as any;

    const next = rootReducer(s, {
      ...reconstruct_stock_order_late_scan_receipt({
        orderId,
        itemKey: blueKey,
        note: "late subtype scans should split the order row",
      }),
      timestamp: TS,
    } as any);

    const blueLedger = next.inventory.costLedger![blueKey] as any[];
    const pinkLedger = next.inventory.costLedger![pinkKey] as any[];
    expect(
      blueLedger.find((entry) => entry.at === lateScanAt && entry.qty === 12),
    ).toEqual(expect.objectContaining({ ignored: true }));
    expect(
      pinkLedger.find((entry) => entry.at === lateScanAt && entry.qty === 12),
    ).toEqual(expect.objectContaining({ ignored: true }));
    expect(
      blueLedger.find((entry) => entry.source === `stockOrder:${orderId}`),
    ).toEqual(
      expect.objectContaining({
        kind: "receipt",
        at: receivedAt,
        qty: 6,
        auditComment: expect.stringContaining("split from 12 order unit"),
      }),
    );
    expect(
      pinkLedger.find((entry) => entry.source === `stockOrder:${orderId}`),
    ).toEqual(
      expect.objectContaining({
        kind: "receipt",
        at: receivedAt,
        qty: 6,
        auditComment: expect.stringContaining("split from 12 order unit"),
      }),
    );
    expect(next.inventory.stockOrderRegistry![orderId].costIssues).toEqual([]);
  });

  it("reconstructs only the unmatched remainder when sibling subtypes already matched the order", () => {
    const orderId = "order-late-partial-subtypes";
    const jan = "4542804108644";
    const blueKey = `${jan}Blue`;
    const brownKey = `${jan}Brown`;
    const otherKey = "4542804000000";
    const receivedAt = Date.parse("2024-07-02T00:00:00Z");
    const firstScanAt = Date.parse("2024-10-09T12:00:00Z");
    const lateScanAt = Date.parse("2025-05-05T12:00:00Z");
    let s = rootReducer(undefined, { type: "@@INIT" });
    s = {
      ...s,
      inventory: {
        ...s.inventory,
        idToItem: {
          [blueKey]: {
            janCode: jan,
            subtype: "Blue",
            description: "Partially matched item",
            hsCode: "48211010",
            image: "",
            qty: 2,
            pieces: 1,
            shipped: 0,
            creationDate: "Oct 9, 2024 (8)",
            timestamp: lateScanAt,
            cost: 65,
          },
          [brownKey]: {
            janCode: jan,
            subtype: "Brown",
            description: "Partially matched item",
            hsCode: "48211010",
            image: "",
            qty: 4,
            pieces: 1,
            shipped: 0,
            creationDate: "Oct 9, 2024 (8)",
            timestamp: lateScanAt,
            cost: 65,
          },
          [otherKey]: {
            janCode: "4542804000000",
            subtype: "",
            description: "Earlier scanned item",
            hsCode: "39191080",
            image: "",
            qty: 1,
            pieces: 1,
            shipped: 0,
            creationDate: "Oct 9, 2024 (1)",
            timestamp: firstScanAt,
            cost: 10,
          },
        },
        costLedger: {
          [blueKey]: [
            {
              kind: "receipt",
              at: firstScanAt,
              seq: 0,
              qty: 8,
              unitCostJpy: 65,
              unitCostEur: 0.4,
              source: "update_item",
              costOrderId: orderId,
            },
            {
              kind: "sale",
              at: Date.parse("2025-05-02T12:00:00Z"),
              seq: 1,
              qty: 8,
              isArchive: true,
            },
            {
              kind: "receipt",
              at: lateScanAt,
              seq: 2,
              qty: 2,
              receivedQty: 0,
              unitCostJpy: 65,
              unitCostEur: 0.4,
              source: "update_item",
              costOrderId: orderId,
            },
          ],
          [brownKey]: [
            {
              kind: "receipt",
              at: firstScanAt + 1,
              seq: 0,
              qty: 8,
              unitCostJpy: 65,
              unitCostEur: 0.4,
              source: "update_item",
              costOrderId: orderId,
            },
            {
              kind: "sale",
              at: Date.parse("2025-05-02T12:00:00Z"),
              seq: 1,
              qty: 8,
              isArchive: true,
            },
            {
              kind: "receipt",
              at: lateScanAt + 1,
              seq: 2,
              qty: 4,
              receivedQty: 0,
              unitCostJpy: 65,
              unitCostEur: 0.4,
              source: "update_item",
              costOrderId: orderId,
            },
          ],
          [otherKey]: [
            {
              kind: "receipt",
              at: firstScanAt,
              seq: 0,
              qty: 1,
              unitCostJpy: 10,
              unitCostEur: 0.06,
              source: "update_item",
              costOrderId: orderId,
            },
          ],
        },
        idToHistory: { [blueKey]: [], [brownKey]: [] },
        stockOrderRegistry: {
          [orderId]: {
            name: "Partial Late Scan Order",
            receivedAt,
            usesZeroedQuantities: true,
            valueOfOrderJpy: 1560,
            totalOrderEur: 9.6,
            costRows: [{ jan, unitCostJpy: 65, qty: 24 }],
            costIssues: [],
          },
        },
      },
    } as any;

    const next = rootReducer(s, {
      ...reconstruct_stock_order_late_scan_receipt({
        orderId,
        itemKey: blueKey,
        note: "late recount should only reconstruct the unmatched remainder",
      }),
      timestamp: TS,
    } as any);

    const blueLedger = next.inventory.costLedger![blueKey] as any[];
    const brownLedger = next.inventory.costLedger![brownKey] as any[];
    expect(
      blueLedger.find((entry) => entry.at === lateScanAt && entry.qty === 2),
    ).toEqual(
      expect.objectContaining({
        receivedQty: 0,
        auditComment: expect.stringContaining(
          "post-reconstruction stocktake recount",
        ),
      }),
    );
    expect(
      blueLedger.find((entry) => entry.at === lateScanAt && entry.qty === 2)
        ?.costOrderId,
    ).toBeUndefined();
    expect(
      brownLedger.find(
        (entry) => entry.at === lateScanAt + 1 && entry.qty === 4,
      ),
    ).toEqual(
      expect.objectContaining({
        receivedQty: 0,
        auditComment: expect.stringContaining(
          "post-reconstruction stocktake recount",
        ),
      }),
    );
    expect(
      brownLedger.find(
        (entry) => entry.at === lateScanAt + 1 && entry.qty === 4,
      )?.costOrderId,
    ).toBeUndefined();
    expect(
      blueLedger.find((entry) => entry.source === `stockOrder:${orderId}`),
    ).toEqual(
      expect.objectContaining({
        kind: "receipt",
        at: receivedAt,
        qty: 8,
      }),
    );
    expect(
      blueLedger.find(
        (entry) =>
          entry.kind === "sale" &&
          entry.isArchive &&
          entry.qty === 8 &&
          entry.auditComment?.includes("Stocktake adjustment consumed"),
      ),
    ).toBeTruthy();
    expect(
      brownLedger.find((entry) => entry.source === `stockOrder:${orderId}`),
    ).toBeUndefined();
    expect(next.inventory.stockOrderRegistry![orderId].costIssues).toEqual([]);

    const reconstructed = blueLedger.find(
      (entry) => entry.source === `stockOrder:${orderId}`,
    )!;
    const ignored = rootReducer(next, {
      ...set_cost_ledger_entries_ignored({
        itemKey: blueKey,
        refs: [
          {
            kind: reconstructed.kind,
            at: reconstructed.at,
            seq: reconstructed.seq,
            qty: reconstructed.qty,
            unitCostJpy: reconstructed.unitCostJpy,
            unitCostEur: reconstructed.unitCostEur,
            source: reconstructed.source,
            costOrderId: reconstructed.costOrderId,
          },
        ],
        ignored: true,
        reason: "already corrected manually",
      }),
      timestamp: TS,
    } as any);
    const ignoredLedger = ignored.inventory.costLedger![blueKey] as any[];
    expect(
      ignoredLedger.find((entry) => entry.source === `stockOrder:${orderId}`),
    ).toEqual(expect.objectContaining({ ignored: true }));
    expect(
      ignoredLedger.find((entry) =>
        entry.auditComment?.includes("Stocktake adjustment consumed"),
      ),
    ).toEqual(expect.objectContaining({ ignored: true }));
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

  it("combined preview shows historical receipt lot repricing even when current average stays zero", () => {
    const historicalReceiptAt = Date.parse("2023-11-16T12:00:00Z");
    const laterReceiptAt = Date.parse("2025-05-04T12:00:00Z");
    const inventory = {
      stockOrderRegistry: {
        fp: {
          receivedAt: Date.parse("2023-08-23T00:00:00Z"),
          valueOfGoodsJpy: 2000,
          expectedItemCount: 10,
          valueOfOrderJpy: 2000,
          paidAmount: 20,
          paidCurrency: "EUR",
        },
      },
      idToItem: {
        [JAN]: scanItem("", 5),
      },
      costLedger: {
        [JAN]: [
          {
            kind: "receipt" as const,
            at: historicalReceiptAt,
            seq: 0,
            qty: 10,
            unitCostJpy: 0,
            unitCostEur: 0,
            source: "update_item",
          },
          {
            kind: "sale" as const,
            at: historicalReceiptAt + 1,
            seq: 1,
            qty: 10,
          },
          {
            kind: "receipt" as const,
            at: laterReceiptAt,
            seq: 2,
            qty: 5,
            unitCostJpy: 0,
            unitCostEur: 0,
            source: "update_item",
          },
        ],
      },
    };

    const pv = previewStockOrderFix(inventory as any, "fp", {
      meta: {},
      rawPaste: tsv,
      overrideExisting: false,
      approveDiscrepancy: false,
    });

    expect(pv.reconciliation?.reconciled).toBe(true);
    expect(pv.items).toEqual([
      expect.objectContaining({
        key: JAN,
        oldCostJpy: 0,
        newCostJpy: 200,
        oldCostEur: 0,
        newCostEur: 2,
      }),
    ]);
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
