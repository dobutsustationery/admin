import { describe, expect, it } from "vitest";
import { rootReducer as rawRootReducer } from "$lib/root-reducer";
import {
  archive_inventory,
  new_order,
  package_item,
  replace_subtype,
  resolve_subtype_exception,
  update_item,
  type Item,
} from "$lib/inventory";
import { effectiveLedgerEntries, walkLedger } from "$lib/cost-engine";
import {
  previewSplitBareToSubtypes,
  selectSubtypeExceptions,
} from "$lib/subtype-exceptions";

const ts = (seconds: number) => ({
  _seconds: seconds,
  _nanoseconds: 0,
});

function reduce(state: any, action: any, seconds = 1_700_000_000) {
  return rawRootReducer(
    state,
    action && action.type && !action.timestamp
      ? { ...action, timestamp: ts(seconds) }
      : action,
  );
}

function item(janCode: string, subtype: string, qty: number): Item {
  return {
    janCode,
    subtype,
    description: "Subtype test item",
    hsCode: "48211010",
    image: "",
    qty,
    pieces: 1,
    shipped: 0,
    creationDate: "",
    timestamp: 0,
  };
}

describe("subtype exception selection and remediation", () => {
  it("finds mixed bare/subtyped JAN groups and previews a split", () => {
    const jan = "1111111111111";
    let state: any = reduce(undefined, { type: "@@INIT" });
    state = reduce(
      state,
      update_item({ id: jan, item: item(jan, "", 10) }),
      100,
    );
    state = reduce(
      state,
      update_item({ id: `${jan}Blue`, item: item(jan, "Blue", 0) }),
      101,
    );

    const exceptions = selectSubtypeExceptions(state.inventory);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0].janCode).toBe(jan);

    const preview = previewSplitBareToSubtypes(
      exceptions[0],
      [{ subtype: "Blue", qty: 10 }],
      [],
    );
    expect(preview.blocked).toBe(false);
    expect(preview.targets[0]).toMatchObject({
      key: `${jan}Blue`,
      finalQty: 10,
      finalShipped: 0,
    });
  });

  it("splits a bare JAN into subtype rows, moves order references, and removes the bare ledger", () => {
    const jan = "2222222222222";
    let state: any = reduce(undefined, { type: "@@INIT" });
    state = reduce(
      state,
      update_item({ id: jan, item: item(jan, "", 10) }),
      100,
    );
    state = reduce(
      state,
      update_item({ id: `${jan}Blue`, item: item(jan, "Blue", 0) }),
      101,
    );
    state = reduce(
      state,
      update_item({ id: `${jan}Red`, item: item(jan, "Red", 0) }),
      102,
    );
    state = reduce(
      state,
      new_order({
        orderID: "order-1",
        date: new Date("2026-01-01"),
        email: "test@example.com",
        product: "Test",
      }),
      103,
    );
    state = reduce(
      state,
      package_item({ orderID: "order-1", itemKey: jan as any, qty: 2 }),
      104,
    );

    state = reduce(
      state,
      resolve_subtype_exception({
        janCode: jan,
        mode: "split_bare_to_subtypes",
        allocations: [
          { subtype: "Blue", qty: 6 },
          { subtype: "Red", qty: 4 },
        ],
        orderMoves: [{ orderID: "order-1", subtype: "Red", qty: 2 }],
      }),
      105,
    );

    expect(state.inventory.idToItem[jan]).toBeUndefined();
    expect(state.inventory.idToItem[`${jan}Blue`]).toMatchObject({
      qty: 6,
      shipped: 0,
    });
    expect(state.inventory.idToItem[`${jan}Red`]).toMatchObject({
      qty: 4,
      shipped: 2,
    });
    expect(state.inventory.orderIdToOrder["order-1"].items).toEqual([
      { itemKey: `${jan}Red`, qty: 2 },
    ]);
    expect(state.inventory.costLedger[jan]).toBeUndefined();
    const receiptQty = [
      ...state.inventory.costLedger[`${jan}Blue`],
      ...state.inventory.costLedger[`${jan}Red`],
    ]
      .filter((entry: any) => entry.kind === "receipt")
      .reduce((sum: number, entry: any) => sum + entry.qty, 0);
    expect(receiptQty).toBe(10);
  });

  it("allows archived zero-residue bare order references to move without changing shipped", () => {
    const jan = "4444444444444";
    let state: any = reduce(undefined, { type: "@@INIT" });
    state = reduce(
      state,
      update_item({ id: jan, item: item(jan, "", 1) }),
      100,
    );
    state = reduce(
      state,
      update_item({ id: `${jan}Blue`, item: item(jan, "Blue", 0) }),
      101,
    );
    state = reduce(
      state,
      new_order({
        orderID: "order-1",
        date: new Date("2026-01-01"),
        email: "test@example.com",
        product: "Test",
      }),
      102,
    );
    state = reduce(
      state,
      package_item({ orderID: "order-1", itemKey: jan as any, qty: 1 }),
      103,
    );
    state = reduce(state, archive_inventory({ archiveName: "Stocktake" }), 104);

    const exception = selectSubtypeExceptions(state.inventory).find(
      (row) => row.janCode === jan,
    );
    expect(exception).toBeDefined();
    expect(exception).toMatchObject({
      status: "zero-residue",
      bare: { qty: 0, shipped: 0 },
    });

    const preview = previewSplitBareToSubtypes(
      exception!,
      [{ subtype: "Blue", qty: 0 }],
      [{ orderID: "order-1", subtype: "Blue", qty: 1 }],
    );
    expect(preview.blocked).toBe(false);
    expect(preview.targets[0]).toMatchObject({
      key: `${jan}Blue`,
      finalQty: 0,
      finalShipped: 0,
    });

    state = reduce(
      state,
      resolve_subtype_exception({
        janCode: jan,
        mode: "split_bare_to_subtypes",
        allocations: [{ subtype: "Blue", qty: 0 }],
        orderMoves: [{ orderID: "order-1", subtype: "Blue", qty: 1 }],
      }),
      105,
    );

    expect(state.inventory.idToItem[jan]).toBeUndefined();
    expect(state.inventory.idToItem[`${jan}Blue`]).toMatchObject({
      qty: 0,
      shipped: 0,
    });
    expect(state.inventory.orderIdToOrder["order-1"].items).toEqual([
      { itemKey: `${jan}Blue`, qty: 1 },
    ]);
    expect(state.inventory.idToHistory[`${jan}Blue`]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          desc: expect.stringContaining(
            "reassigned historical order order-1 qty 1 from bare JAN",
          ),
        }),
      ]),
    );
  });

  it("merges subtype rows back into the bare JAN and rewrites subtype orders", () => {
    const jan = "3333333333333";
    let state: any = reduce(undefined, { type: "@@INIT" });
    state = reduce(
      state,
      update_item({ id: jan, item: item(jan, "", 1) }),
      100,
    );
    state = reduce(
      state,
      update_item({ id: `${jan}Blue`, item: item(jan, "Blue", 3) }),
      101,
    );
    state = reduce(
      state,
      new_order({
        orderID: "order-1",
        date: new Date("2026-01-01"),
        email: "test@example.com",
        product: "Test",
      }),
      102,
    );
    state = reduce(
      state,
      package_item({
        orderID: "order-1",
        itemKey: `${jan}Blue` as any,
        qty: 2,
      }),
      103,
    );

    state = reduce(
      state,
      resolve_subtype_exception({
        janCode: jan,
        mode: "merge_subtypes_to_bare",
      }),
      104,
    );

    expect(state.inventory.idToItem[`${jan}Blue`]).toBeUndefined();
    expect(state.inventory.idToItem[jan]).toMatchObject({
      subtype: "",
      qty: 4,
      shipped: 2,
    });
    expect(state.inventory.orderIdToOrder["order-1"].items).toEqual([
      { itemKey: jan, qty: 2 },
    ]);
  });

  it("replaces an inactive subtype with a recounted subtype and carries the source cost basis", () => {
    const jan = "4542804104370";
    const brownKey = `${jan}Brown`;
    const beigeKey = `${jan}Beige`;
    let state: any = reduce(undefined, { type: "@@INIT" });

    state = reduce(
      state,
      update_item({ id: brownKey, item: item(jan, "Brown", 5) }),
      100,
    );
    state = {
      ...state,
      inventory: {
        ...state.inventory,
        costLedger: {
          ...state.inventory.costLedger,
          [brownKey]: state.inventory.costLedger[brownKey].map((entry: any) =>
            entry.kind === "receipt"
              ? { ...entry, unitCostJpy: 65, unitCostEur: 0.4 }
              : entry,
          ),
        },
      },
    };
    state = reduce(
      state,
      archive_inventory({ archiveName: "Japan Festival" }),
      101,
    );
    state = reduce(
      state,
      update_item({ id: beigeKey, item: item(jan, "Beige", 5) }),
      102,
    );

    state = reduce(
      state,
      replace_subtype({
        sourceKey: brownKey as any,
        targetKey: beigeKey as any,
        reason: "Beige replaces Brown",
      }),
      103,
    );

    expect(state.inventory.idToItem[brownKey]).toBeUndefined();
    expect(state.inventory.idToItem[beigeKey]).toMatchObject({
      qty: 5,
      shipped: 0,
    });
    expect(state.inventory.idToHistory[beigeKey]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          desc: expect.stringContaining("Subtype replacement resolved"),
        }),
      ]),
    );

    const ledger = state.inventory.costLedger[beigeKey];
    expect(state.inventory.costLedger[brownKey]).toBeUndefined();
    expect(
      ledger.some(
        (entry: any) =>
          entry.kind === "sale" && entry.isArchive && entry.ignored,
      ),
    ).toBe(true);
    expect(
      ledger.some(
        (entry: any) =>
          entry.kind === "receipt" &&
          entry.unitCostJpy === 0 &&
          entry.ignored &&
          String(entry.auditComment || "").includes("replacement/recount"),
      ),
    ).toBe(true);

    const walked = walkLedger(effectiveLedgerEntries(ledger));
    expect(walked.onHand).toBe(5);
    expect(walked.avgJpy).toBe(65);
  });
});
