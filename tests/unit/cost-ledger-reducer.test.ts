import { describe, expect, it, vi } from "vitest";
import { rootReducer } from "$lib/root-reducer";
import {
  update_item,
  bulk_import_items,
  fix_jancode,
  type Item,
} from "$lib/inventory";

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
                unitCostJpy: 65,
                unitCostEur: 0,
                receivedAt: Date.parse("Nov 9, 2023"),
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
                unitCostJpy: 65,
                unitCostEur: 0,
                receivedAt: Date.parse("Nov 9, 2023"),
              },
            },
          ],
        }),
        200,
      ),
    );
    // Re-order: +12 units @ ¥62.
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
                unitCostJpy: 62,
                unitCostEur: 0,
                receivedAt: Date.parse("Mar 2, 2026"),
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

  it("the ledger follows the item across a JAN re-key", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let s = rootReducer(undefined, { type: "@@INIT" });
      s = rootReducer(
        s,
        withTs(update_item({ id: KEY, item: baseItem(6) }), 100),
      );
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
                  unitCostJpy: 62,
                  unitCostEur: 0,
                  receivedAt: Date.parse("Mar 2, 2026"),
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
});
