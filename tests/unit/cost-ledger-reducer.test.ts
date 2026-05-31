import { describe, expect, it, vi } from "vitest";
import { rootReducer } from "$lib/root-reducer";
import {
  archive_inventory,
  update_item,
  update_field,
  bulk_import_items,
  fix_jancode,
  new_order,
  package_item,
  quantify_item,
  set_cost_ledger_entry_qty,
  set_cost_ledger_entries_ignored,
  set_stock_order_meta,
  type Item,
} from "$lib/inventory";
import {
  effectiveLedgerEntries,
  walkLedger,
  type ReceiptEntry,
} from "$lib/cost-engine";

// M2: `cost` is derived from the per-item costLedger materialised in
// applyInventoryUpdate. Single priced lot -> cost == that lot (identical
// to old last-write). A genuine stock-order re-order appends a second
// lot -> receipt-weighted blend. Ledger follows the item across re-key.
// See docs/investigations/DESIGN_INVENTORY_COST_AND_VALUATION.md

function withTs(action: any, seconds: number) {
  return { ...action, timestamp: { _seconds: seconds, _nanoseconds: 0 } };
}

const JAN = "4542804109245";
const KEY = `${JAN}Blue`;

const baseItem = (qty: number, extra: Partial<Item> = {}): Item => ({
  janCode: JAN,
  subtype: "Blue",
  description: "Amifa Sticker",
  hsCode: "48211010",
  image: "",
  qty,
  pieces: 1,
  shipped: 0,
  creationDate: "Nov 9, 2023 (6)",
  timestamp: 0,
  ...extra,
});

function withStockOrderMeta(
  state: ReturnType<typeof rootReducer>,
  orderId: string,
  unitCostJpy: number,
  qty: number,
  receivedAt = 90_000,
  unitCostEur = 0,
) {
  return rootReducer(
    state,
    withTs(
      set_stock_order_meta({
        orderId,
        meta: {
          receivedAt,
          valueOfOrderJpy: unitCostJpy * qty,
          totalOrderEur: unitCostEur * qty,
          costRows: [{ jan: JAN, unitCostJpy, qty }],
        },
      }),
      Math.floor(receivedAt / 1000),
    ),
  );
}

describe("cost-ledger materialisation in the reducer", () => {
  it("single priced lot derives the attached cost (unchanged vs last-write)", () => {
    let s = rootReducer(undefined, { type: "@@INIT" });
    s = rootReducer(
      s,
      withTs(update_item({ id: KEY, item: baseItem(6) }), 100),
    );
    // no cost yet -> unpriced single lot -> cost stays undefined
    expect(s.inventory.idToItem[KEY].cost).toBeUndefined();
    expect(s.inventory.costLedger![KEY]).toHaveLength(1);

    // Original order (qty 0) attaches landed cost ¥65.
    s = withStockOrderMeta(s, "order-1", 65, 6);
    s = rootReducer(
      s,
      withTs(
        bulk_import_items({
          items: [
            {
              type: "update",
              id: KEY,
              item: baseItem(0),
              stockOrder: {
                orderId: "order-1",
              },
            },
          ],
        }),
        200,
      ),
    );
    expect(s.inventory.idToItem[KEY].cost).toBe(65);
    expect(s.inventory.costLedger![KEY]).toHaveLength(1);
  });

  it("a stock-order re-order appends a lot and blends qty-weighted", () => {
    let s = rootReducer(undefined, { type: "@@INIT" });
    s = rootReducer(
      s,
      withTs(update_item({ id: KEY, item: baseItem(6) }), 100),
    );
    s = withStockOrderMeta(s, "o1", 65, 6);
    s = rootReducer(
      s,
      withTs(
        bulk_import_items({
          items: [
            {
              type: "update",
              id: KEY,
              item: baseItem(0),
              stockOrder: {
                orderId: "o1",
              },
            },
          ],
        }),
        200,
      ),
    );
    // Re-order: +12 units @ ¥62.
    s = withStockOrderMeta(s, "o2", 62, 12);
    s = rootReducer(
      s,
      withTs(
        bulk_import_items({
          items: [
            {
              type: "update",
              id: KEY,
              item: baseItem(12),
              stockOrder: {
                orderId: "o2",
              },
            },
          ],
        }),
        300,
      ),
    );
    const led = s.inventory.costLedger![KEY];
    expect(led).toHaveLength(2);
    expect(led.map((e: any) => [e.kind, e.qty, e.unitCostJpy])).toEqual([
      ["receipt", 6, 65],
      ["receipt", 12, 62],
    ]);
    // (6*65 + 12*62) / 18 = 63
    expect(s.inventory.idToItem[KEY].cost).toBeCloseTo(63, 9);
    expect(s.inventory.idToItem[KEY].qty).toBe(18);
  });

  it("creates new stock-order inventory items with order receipt facts", () => {
    const orderId = "unmatched-order-row";
    const receivedAt = Date.parse("2025-01-25T00:00:00Z");
    let s = rootReducer(undefined, { type: "@@INIT" }) as any;
    s = {
      ...s,
      inventory: {
        ...s.inventory,
        stockOrderRegistry: {
          [orderId]: {
            name: "Order with unmatched row",
            receivedAt,
            usesZeroedQuantities: true,
            costRows: [{ jan: JAN, unitCostJpy: 65, qty: 4 }],
            costIssues: [
              {
                kind: "unmatched-row",
                jan: JAN,
                qty: 4,
                expectedQty: 4,
                matchedQty: 0,
                lineCostJpy: 260,
              },
            ],
          },
        },
      },
    };

    s = rootReducer(
      s,
      withTs(
        bulk_import_items({
          items: [
            {
              type: "new",
              id: KEY,
              item: baseItem(4, { cost: 999 }),
              stockOrder: {
                orderId,
                orderedQty: 4,
              },
            },
          ],
        }),
        200,
      ),
    );

    const ledger = s.inventory.costLedger![KEY] as ReceiptEntry[];
    expect(ledger[0]).toEqual(
      expect.objectContaining({
        kind: "receipt",
        at: receivedAt,
        qty: 4,
        source: `stockOrder:${orderId}`,
        costOrderId: orderId,
      }),
    );
    expect(s.inventory.idToItem[KEY].cost).toBe(65);
    expect(s.inventory.stockOrderRegistry![orderId].costIssues).toEqual([]);
  });

  it("creates stock-order receipts from order dates before server timestamps resolve", () => {
    const orderId = "pending-unmatched-order-row";
    const receivedAt = Date.parse("2025-01-25T00:00:00Z");
    const action = {
      ...bulk_import_items({
        items: [
          {
            type: "new" as const,
            id: KEY,
            item: baseItem(4, { cost: 999 }),
            stockOrder: {
              orderId,
              orderedQty: 4,
            },
          },
        ],
      }),
      id: "pending-stock-order-create",
      timestamp: null,
    };

    let s = rootReducer(undefined, { type: "@@INIT" }) as any;
    s = withStockOrderMeta(s, orderId, 65, 4, receivedAt, 0.42);
    s = rootReducer(s, action);

    expect(s.inventory.idToItem[KEY].qty).toBe(4);
    expect(s.inventory.idToItem[KEY].timestamp).toBe(receivedAt);
    expect(s.inventory.costLedger![KEY]).toEqual([
      expect.objectContaining({
        kind: "receipt",
        at: receivedAt,
        qty: 4,
        source: `stockOrder:${orderId}`,
        costOrderId: orderId,
        createdByActionId: "pending-stock-order-create",
      }),
    ]);

    s = rootReducer(
      s,
      withTs(
        {
          ...bulk_import_items({
            items: [
              {
                type: "new" as const,
                id: KEY,
                item: baseItem(4, { cost: 999 }),
                stockOrder: {
                  orderId,
                  orderedQty: 4,
                },
              },
            ],
          }),
          id: "pending-stock-order-create",
        },
        200,
      ),
    );

    expect(s.inventory.idToItem[KEY].qty).toBe(4);
    expect(s.inventory.idToItem[KEY].timestamp).toBe(200_000);
    expect(s.inventory.costLedger![KEY]).toHaveLength(1);
    expect(s.inventory.costLedger![KEY][0].qty).toBe(4);
  });

  it("keeps a same-scan receipt intact and audits stock-order over-consumption", () => {
    let s = rootReducer(undefined, { type: "@@INIT" });
    s = rootReducer(
      s,
      withTs(update_item({ id: KEY, item: baseItem(20) }), 100),
    );
    s = withStockOrderMeta(s, "o1", 282.7, 10, 90_000, 1.8);

    s = rootReducer(
      s,
      withTs(
        bulk_import_items({
          items: [
            {
              type: "update",
              id: KEY,
              item: baseItem(0),
              stockOrder: {
                orderId: "o1",
                orderedQty: 10,
              },
            },
          ],
        }),
        200,
      ),
    );

    const led = s.inventory.costLedger![KEY];
    expect(led).toHaveLength(1);
    expect(
      led.map((e: any) => [
        e.kind,
        e.qty,
        e.unitCostJpy,
        e.costOrderId,
        e.auditSeverity,
      ]),
    ).toEqual([["receipt", 20, 282.7, "o1", "danger"]]);
    expect((led[0] as any).unitCostEur).toBeCloseTo(1.8, 9);
    expect((led[0] as any).auditComment).toContain("over-consumed by 10");
    expect(s.inventory.idToItem[KEY].cost).toBeCloseTo(282.7, 9);
  });

  it("round-robins zeroed stock-order cost assignment across sibling SKUs after the order date", () => {
    const pinkKey = `${JAN}Pink`;
    let s = rootReducer(undefined, { type: "@@INIT" });
    s = rootReducer(
      s,
      withTs(update_item({ id: KEY, item: baseItem(5) }), 100),
    );
    s = rootReducer(
      s,
      withTs(update_item({ id: KEY, item: baseItem(12) }), 200),
    );
    s = rootReducer(
      s,
      withTs(
        update_item({
          id: pinkKey,
          item: baseItem(12, { subtype: "Pink" }),
        }),
        210,
      ),
    );
    s = rootReducer(
      s,
      withTs(update_item({ id: KEY, item: baseItem(8) }), 220),
    );
    s = rootReducer(
      s,
      withTs(
        update_item({
          id: pinkKey,
          item: baseItem(10, { subtype: "Pink" }),
        }),
        230,
      ),
    );

    const stockOrder = {
      orderId: "o1",
      orderedQty: 24,
    };
    s = withStockOrderMeta(s, "o1", 65, 24, 150_000);
    s = rootReducer(
      s,
      withTs(
        bulk_import_items({
          items: [
            {
              type: "update",
              id: KEY,
              item: baseItem(0),
              stockOrder,
            },
            {
              type: "update",
              id: pinkKey,
              item: baseItem(0, { subtype: "Pink" }),
              stockOrder,
            },
          ],
        }),
        300,
      ),
    );

    expect(
      effectiveLedgerEntries(s.inventory.costLedger![KEY] as any[])
        .filter((e): e is ReceiptEntry => e.kind === "receipt" && !e.ignored)
        .map((e) => [e.qty, e.unitCostJpy, e.costOrderId]),
    ).toEqual([[8, 65, "o1"]]);
    expect(
      effectiveLedgerEntries(s.inventory.costLedger![pinkKey] as any[])
        .filter((e): e is ReceiptEntry => e.kind === "receipt" && !e.ignored)
        .map((e) => [e.qty, e.unitCostJpy, e.costOrderId]),
    ).toEqual([[10, 65, "o1"]]);
  });

  it("reduces the newest scan receipt when a qty correction lowers inventory", () => {
    let s = rootReducer(undefined, { type: "@@INIT" });
    s = rootReducer(
      s,
      withTs(update_item({ id: KEY, item: baseItem(10) }), 100),
    );

    s = rootReducer(
      s,
      withTs(update_field({ id: KEY, field: "qty", from: 10, to: "5" }), 150),
    );

    expect(s.inventory.idToItem[KEY].qty).toBe(5);
    const rawLedger = s.inventory.costLedger![KEY] as any[];
    expect(rawLedger).toEqual([
      expect.objectContaining({
        kind: "receipt",
        qty: 10,
      }),
      expect.objectContaining({
        kind: "receipt",
        adjustmentEntry: true,
        adjustmentMode: "apply-to-target",
        qty: -5,
        originalQty: 10,
        quantityCorrections: [
          expect.objectContaining({
            actionType: "update_field",
            fromVisibleQty: 10,
            toVisibleQty: 5,
            reducedBy: 5,
          }),
        ],
        auditComment:
          "Reducer qty correction reduced this receipt by 5 unit(s), from visible qty 10 to visible qty 5.",
        auditSeverity: "warning",
      }),
    ]);
    expect(walkLedger(rawLedger).onHand).toBe(5);
    expect(s.inventory.idToHistory[KEY].at(-1)?.desc).toContain(
      "Cost ledger qty correction",
    );

    s = withStockOrderMeta(s, "o1", 65, 5);
    s = rootReducer(
      s,
      withTs(
        bulk_import_items({
          items: [
            {
              type: "update",
              id: KEY,
              item: baseItem(0),
              stockOrder: {
                orderId: "o1",
                orderedQty: 5,
              },
            },
          ],
        }),
        200,
      ),
    );

    const effectiveLedger = effectiveLedgerEntries(
      s.inventory.costLedger![KEY] as any[],
    );
    expect(effectiveLedger).toHaveLength(1);
    expect(effectiveLedger[0]).toEqual(
      expect.objectContaining({
        kind: "receipt",
        qty: 5,
        costOrderId: "o1",
      }),
    );
  });

  it("increases the open receipt when a qty correction raises inventory", () => {
    let s = rootReducer(undefined, { type: "@@INIT" });
    s = withStockOrderMeta(s, "o1", 140, 24, 90_000, 0.82);
    s = rootReducer(
      s,
      withTs(
        bulk_import_items({
          items: [
            {
              type: "update",
              id: KEY,
              item: baseItem(12, { cost: 140 }),
              stockOrder: {
                orderId: "o1",
                orderedQty: 24,
              },
            },
          ],
        }),
        100,
      ),
    );

    s = rootReducer(
      s,
      withTs(update_field({ id: KEY, field: "qty", from: 12, to: "24" }), 150),
    );

    expect(s.inventory.idToItem[KEY].qty).toBe(24);
    const rawLedger = s.inventory.costLedger![KEY] as any[];
    expect(rawLedger).toEqual([
      expect.objectContaining({
        kind: "receipt",
        at: 90_000,
        qty: 12,
        source: "stockOrder:o1",
        costOrderId: "o1",
      }),
      expect.objectContaining({
        kind: "receipt",
        adjustmentEntry: true,
        adjustmentMode: "apply-to-target",
        at: 90_000,
        qty: 12,
        source: "stockOrder:o1",
        costOrderId: "o1",
        originalQty: 12,
        quantityCorrections: [
          expect.objectContaining({
            actionType: "update_field",
            fromVisibleQty: 12,
            toVisibleQty: 24,
            increasedBy: 12,
          }),
        ],
        auditComment:
          "Reducer qty correction increased this receipt by 12 unit(s), from visible qty 12 to visible qty 24.",
        auditSeverity: "warning",
      }),
    ]);
    expect(walkLedger(rawLedger).onHand).toBe(24);
    expect(s.inventory.idToHistory[KEY].at(-1)?.desc).toContain(
      "Cost ledger qty correction: increased open receipt by 12 unit(s) to match visible qty 24",
    );
  });

  it("replaces qty on repeated update_item scans without creating duplicate receipt lots", () => {
    let s = rootReducer(undefined, { type: "@@INIT" });
    s = rootReducer(
      s,
      withTs(update_item({ id: KEY, item: baseItem(12) }), 100),
    );
    s = rootReducer(
      s,
      withTs(update_item({ id: KEY, item: baseItem(7) }), 110),
    );
    s = rootReducer(
      s,
      withTs(update_item({ id: KEY, item: baseItem(12) }), 120),
    );

    const ledger = s.inventory.costLedger![KEY] as any[];
    expect(s.inventory.idToItem[KEY].qty).toBe(12);
    expect(
      effectiveLedgerEntries(ledger)
        .filter((entry) => !entry.ignored)
        .map((entry) => [entry.kind, entry.qty, entry.ignored]),
    ).toEqual([["receipt", 12, undefined]]);
  });

  it("audits update_item qty replacement increases on the adjusted receipt", () => {
    let s = rootReducer(undefined, { type: "@@INIT" });
    s = rootReducer(
      s,
      withTs(update_item({ id: KEY, item: baseItem(12) }), 100),
    );
    s = rootReducer(
      s,
      withTs(update_item({ id: KEY, item: baseItem(3) }), 110),
    );
    s = rootReducer(
      s,
      withTs(update_item({ id: KEY, item: baseItem(12) }), 120),
    );

    const ledger = s.inventory.costLedger![KEY] as any[];
    const adjustment = ledger.find(
      (entry) =>
        entry.adjustmentEntry &&
        (entry.quantityCorrections?.at(-1)?.increasedBy || 0) > 0,
    );
    expect(adjustment).toEqual(
      expect.objectContaining({
        kind: "receipt",
        adjustmentEntry: true,
        adjustmentMode: "apply-to-target",
        originalQty: 12,
        auditComment:
          "Reducer qty correction increased this receipt by 9 unit(s), from visible qty 3 to visible qty 12.",
        auditSeverity: "warning",
      }),
    );
    expect(adjustment.quantityCorrections.at(-1)).toEqual(
      expect.objectContaining({
        actionType: "update_item",
        fromVisibleQty: 3,
        toVisibleQty: 12,
        increasedBy: 9,
      }),
    );
    expect(
      effectiveLedgerEntries(ledger).filter((entry) => !entry.ignored),
    ).toEqual([
      expect.objectContaining({
        kind: "receipt",
        qty: 12,
      }),
    ]);
    expect(s.inventory.idToHistory[KEY].at(-1)?.desc).toContain(
      "Cost ledger qty replacement: increased open receipt by 9 unit(s) to match visible qty 12",
    );
  });

  it("records same-qty update_item snapshots in history when shipped stock makes the scan look ignored", () => {
    let s = rootReducer(undefined, { type: "@@INIT" });
    s = rootReducer(
      s,
      withTs(update_item({ id: KEY, item: baseItem(20) }), 100),
    );
    s = rootReducer(
      s,
      withTs(
        package_item({ itemKey: KEY as any, qty: 20, orderID: "manual-1" }),
        150,
      ),
    );
    s = rootReducer(
      s,
      withTs(update_item({ id: KEY, item: baseItem(20) }), 200),
    );

    expect(s.inventory.idToItem[KEY].qty).toBe(20);
    expect(s.inventory.idToItem[KEY].shipped).toBe(0);
    expect(s.inventory.costLedger![KEY]).toHaveLength(3);
    expect(
      s.inventory.idToHistory[KEY].map((entry: { desc: string }) => entry.desc),
    ).toContain(
      "Quantity snapshot recorded no total change: incoming qty 20 matched existing total qty 20; shipped 20 -> 0; visible qty 0 -> 20",
    );
    expect(
      s.inventory.idToHistory[KEY].map((entry: { desc: string }) => entry.desc),
    ).toContain(
      "Cost ledger qty replacement: added 20 unit receipt to match visible qty 20",
    );
  });

  it("adds a new receipt when a post-archive update_item scan restores stock", () => {
    let s = rootReducer(undefined, { type: "@@INIT" });
    s = rootReducer(
      s,
      withTs(update_item({ id: KEY, item: baseItem(20, { cost: 65 }) }), 100),
    );
    s = rootReducer(
      s,
      withTs(archive_inventory({ archiveName: "Japan Festival" }), 200),
    );
    s = rootReducer(
      s,
      withTs(update_item({ id: KEY, item: baseItem(20) }), 300),
    );

    const ledger = s.inventory.costLedger![KEY] as any[];
    expect(s.inventory.idToItem[KEY].qty).toBe(20);
    expect(
      ledger.map((entry) => [
        entry.kind,
        entry.qty,
        entry.source,
        entry.isArchive,
        entry.at,
        entry.receivedQty,
      ]),
    ).toEqual([
      ["receipt", 20, "update_item", undefined, 100_000, undefined],
      ["sale", 20, undefined, true, 200_000, undefined],
      ["receipt", 20, "update_item", undefined, 300_000, 0],
    ]);
    expect(walkLedger(ledger).onHand).toBe(20);
    expect(walkLedger(ledger).avgJpy).toBe(65);
  });

  it("records legacy package and quantify actions as dated ledger sales", () => {
    let s = rootReducer(undefined, { type: "@@INIT" });
    s = rootReducer(
      s,
      withTs(update_item({ id: KEY, item: baseItem(20) }), 100),
    );
    s = rootReducer(
      s,
      withTs(
        package_item({ itemKey: KEY as any, qty: 5, orderID: "manual-1" }),
        150,
      ),
    );
    s = rootReducer(
      s,
      withTs(
        quantify_item({ itemKey: KEY as any, qty: 12, orderID: "manual-1" }),
        160,
      ),
    );

    const ledger = s.inventory.costLedger![KEY] as any[];
    expect(ledger.map((entry) => [entry.kind, entry.qty, entry.at])).toEqual([
      ["receipt", 20, 100_000],
      ["sale", 5, 150_000],
      ["sale", 7, 150_000],
    ]);
    expect(s.inventory.idToItem[KEY].shipped).toBe(12);
    expect(walkLedger(ledger).onHand).toBe(8);
  });

  it("records manual order package sales at the event date when present", () => {
    const entryDate = new Date("2025-05-26T12:00:00Z");
    const eventDate = new Date("2025-05-04T00:00:00Z");
    let s = rootReducer(undefined, { type: "@@INIT" });
    s = rootReducer(
      s,
      withTs(update_item({ id: KEY, item: baseItem(20) }), 100),
    );
    s = rootReducer(
      s,
      withTs(
        new_order({
          orderID: "event-order-1",
          date: entryDate,
          eventDate,
          email: "live-event",
          product: "Japan Festival",
        }),
        500,
      ),
    );
    s = rootReducer(
      s,
      withTs(
        package_item({
          itemKey: KEY as any,
          qty: 5,
          orderID: "event-order-1",
        }),
        600,
      ),
    );

    const sale = (s.inventory.costLedger![KEY] as any[]).find(
      (entry) => entry.kind === "sale",
    );
    expect(sale.at).toBe(eventDate.getTime());
  });

  it("can mark a specific ledger entry ignored and rederive cost", () => {
    let s = rootReducer(undefined, { type: "@@INIT" });
    s = rootReducer(
      s,
      withTs(update_item({ id: KEY, item: baseItem(10, { cost: 100 }) }), 100),
    );
    s = withStockOrderMeta(s, "o2", 50, 10);
    s = rootReducer(
      s,
      withTs(
        bulk_import_items({
          items: [
            {
              type: "update",
              id: KEY,
              item: baseItem(10),
              stockOrder: {
                orderId: "o2",
                orderedQty: 10,
              },
            },
          ],
        }),
        200,
      ),
    );
    expect(s.inventory.idToItem[KEY].cost).toBeCloseTo(75, 9);

    const entry = s.inventory.costLedger![KEY][1] as any;
    s = rootReducer(
      s,
      withTs(
        set_cost_ledger_entries_ignored({
          itemKey: KEY,
          ignored: true,
          refs: [
            {
              kind: "receipt",
              at: entry.at,
              seq: entry.seq,
              source: entry.source || "",
              costOrderId: entry.costOrderId || "",
            },
          ],
          reason: "duplicate scan",
        }),
        300,
      ),
    );

    expect(s.inventory.costLedger![KEY][1].ignored).toBe(true);
    expect(s.inventory.costLedger![KEY][1].ignoreReason).toBe("duplicate scan");
    expect(s.inventory.idToItem[KEY].cost).toBeCloseTo(100, 9);
    expect(s.inventory.idToHistory[KEY].at(-1)?.desc).toContain(
      "duplicate scan",
    );
  });

  it("can manually adjust a ledger entry quantity with an audit note", () => {
    let s = rootReducer(undefined, { type: "@@INIT" });
    s = rootReducer(
      s,
      withTs(update_item({ id: KEY, item: baseItem(10, { cost: 100 }) }), 100),
    );
    s = withStockOrderMeta(s, "o2", 50, 10);
    s = rootReducer(
      s,
      withTs(
        bulk_import_items({
          items: [
            {
              type: "update",
              id: KEY,
              item: baseItem(10),
              stockOrder: {
                orderId: "o2",
                orderedQty: 10,
              },
            },
          ],
        }),
        200,
      ),
    );

    const entry = s.inventory.costLedger![KEY][1] as any;
    s = rootReducer(
      s,
      withTs(
        set_cost_ledger_entry_qty({
          itemKey: KEY,
          ref: {
            kind: "receipt",
            at: entry.at,
            seq: entry.seq,
            source: entry.source || "",
            costOrderId: entry.costOrderId || "",
          },
          qty: 4,
          note: "matched operator recount",
        }),
        300,
      ),
    );

    const adjusted = s.inventory.costLedger![KEY][1] as any;
    expect(adjusted.qty).toBe(4);
    expect(adjusted.originalQty).toBe(10);
    expect(adjusted.auditSeverity).toBe("warning");
    expect(adjusted.auditComment).toContain("matched operator recount");
    expect(s.inventory.idToItem[KEY].cost).toBeCloseTo(
      (10 * 100 + 4 * 50) / 14,
      9,
    );
    expect(s.inventory.idToHistory[KEY].at(-1)?.desc).toContain(
      "matched operator recount",
    );
  });

  it("the ledger follows the item across a JAN re-key", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let s = rootReducer(undefined, { type: "@@INIT" });
      s = rootReducer(
        s,
        withTs(update_item({ id: KEY, item: baseItem(6) }), 100),
      );
      s = withStockOrderMeta(s, "o2", 62, 12);
      s = rootReducer(
        s,
        withTs(
          bulk_import_items({
            items: [
              {
                type: "update",
                id: KEY,
                item: baseItem(12, { cost: undefined }),
                stockOrder: {
                  orderId: "o2",
                },
              },
            ],
          }),
          200,
        ),
      );
      // First lot unpriced (6@0), re-order lot 12@62 -> avg = 744/18
      const before = s.inventory.idToItem[KEY].cost;
      expect(before).toBeCloseTo((12 * 62) / 18, 9);

      const NEWJAN = "4542804109999";
      const NEWKEY = `${NEWJAN}Blue`;
      s = rootReducer(
        s,
        withTs(fix_jancode({ itemKey: KEY as any, newJanCode: NEWJAN }), 300),
      );
      expect(s.inventory.costLedger![KEY]).toBeUndefined();
      expect(s.inventory.costLedger![NEWKEY]).toHaveLength(2);
      expect(s.inventory.idToItem[NEWKEY].cost).toBeCloseTo((12 * 62) / 18, 9);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("preserves raw receipt adjustment rows across a JAN re-key", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let s = rootReducer(undefined, { type: "@@INIT" });
      s = rootReducer(
        s,
        withTs(update_item({ id: KEY, item: baseItem(10) }), 100),
      );
      s = rootReducer(
        s,
        withTs(
          update_field({ id: KEY, field: "qty", from: 10, to: "12" }),
          150,
        ),
      );

      expect(s.inventory.costLedger![KEY]).toHaveLength(2);
      expect(s.inventory.costLedger![KEY][1]).toEqual(
        expect.objectContaining({
          adjustmentEntry: true,
          adjustmentMode: "apply-to-target",
          qty: 2,
        }),
      );
      expect(walkLedger(s.inventory.costLedger![KEY]).onHand).toBe(12);

      const NEWJAN = "4542804109999";
      const NEWKEY = `${NEWJAN}Blue`;
      s = rootReducer(
        s,
        withTs(fix_jancode({ itemKey: KEY as any, newJanCode: NEWJAN }), 300),
      );

      expect(s.inventory.costLedger![KEY]).toBeUndefined();
      expect(s.inventory.costLedger![NEWKEY]).toHaveLength(2);
      expect(s.inventory.costLedger![NEWKEY][1]).toEqual(
        expect.objectContaining({
          adjustmentEntry: true,
          adjustmentMode: "apply-to-target",
          qty: 2,
        }),
      );
      expect(walkLedger(s.inventory.costLedger![NEWKEY]).onHand).toBe(12);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
