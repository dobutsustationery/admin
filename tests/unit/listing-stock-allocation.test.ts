import { describe, it, expect } from "vitest";
import { rootReducer } from "../../src/lib/root-reducer";
import { totalCumulativeValues } from "../../src/lib/inventory-value";
import { totalValuation, valueAt } from "../../src/lib/cost-engine";
import { POOLED_LISTING_STOCK } from "../../src/lib/listing-stock-allocation";
const jan = "4571207041654",
  at = Date.UTC(2026, 10, 6);
const event = (type: string, payload: any, id = type) => ({
  type,
  payload,
  id,
  timestamp: { _seconds: at / 1000, _nanoseconds: 0 },
});
function fixture(shipped = 0, mixed = false) {
  let s: any = rootReducer(undefined, { type: "@@INIT" });
  for (const subtype of ["Blue", "Grey"])
    s = rootReducer(
      s,
      event(
        "update_item",
        {
          id: jan + subtype,
          item: {
            janCode: jan,
            subtype,
            description: "Pocket scissors",
            qty: 12 + (subtype === "Blue" ? shipped : 0),
            shipped: subtype === "Blue" ? shipped : 0,
            pieces: 1,
            price: 4.95,
          },
        },
        subtype,
      ),
      () => {},
    );
  const receipt = (id: string, qty: number, cost: number) => ({
    id,
    kind: "receipt",
    at: at - 1000,
    seq: 0,
    qty,
    receivedQty: qty,
    unitCostJpy: cost,
    unitCostEur: cost / 100,
    source: "stockOrder:" + id,
    costOrderId: id,
  });
  const blue = mixed
    ? [receipt("blue-old", 8, 100), { ...receipt("blue-new", 8, 200), seq: 1 }]
    : [receipt("blue", 12 + shipped, 100)];
  const sales = shipped
    ? [{ id: "sale", kind: "sale", at: at - 500, seq: 2, qty: shipped }]
    : [];
  return {
    ...s,
    inventory: {
      ...s.inventory,
      costLedger: {
        [jan + "Blue"]: [...blue, ...sales],
        [jan + "Grey"]: [receipt("grey", 12, mixed ? 300 : 200)],
      },
    },
  };
}
function propose(s: any, names = ["Blue", "Grey", "Pink"], pooled = true) {
  return rootReducer(
    s,
    event("listingCreation/add_proposals", [
      {
        janCode: jan,
        ...(pooled ? { allocationMode: POOLED_LISTING_STOCK } : {}),
        title: "Pocket scissors",
        bodyHtml: "<p>Scissors</p>",
        productCategory: "Stationery",
        vendor: "Senshu",
        tags: [],
        option1Name: "Colour",
        status: "draft",
        photoGroupIds: [],
        variants: names.map((name, i) => ({ id: "v" + i, option1Value: name })),
      },
    ]),
    () => {},
  );
}
const stock = (s: any) =>
  Object.fromEntries(
    Object.entries(s.inventory.idToItem).map(([k, v]: any) => [
      k,
      v.qty - v.shipped,
    ]),
  );
const approve = (s: any) =>
  rootReducer(
    s,
    event("listingCreation/approve_proposal", { janCode: jan }),
    () => {},
  );
describe("pooled listing stock", () => {
  it("allocates both received subtypes across three variants and conserves quantities, cost and source receipts on approval", () => {
    const before = fixture(),
      draft = propose(before);
    expect(
      draft.listingCreation.proposals[jan].variants.map((v: any) => v.qty),
    ).toEqual([8, 8, 8]);
    const after = approve(draft);
    expect(stock(after)).toEqual({
      [jan + "Blue"]: 8,
      [jan + "Grey"]: 8,
      [jan + "Pink"]: 8,
    });
    expect(totalValuation(Object.values(after.inventory.costLedger))).toEqual(
      totalValuation(Object.values(before.inventory.costLedger)),
    );
    expect(
      totalCumulativeValues(Object.values(after.inventory.costLedger), at),
    ).toEqual(
      totalCumulativeValues(Object.values(before.inventory.costLedger), at),
    );
    for (const subtype of ["Blue", "Grey"])
      expect(after.inventory.costLedger[jan + subtype][0]).toEqual(
        before.inventory.costLedger[jan + subtype][0],
      );
    expect(
      after.inventory.costLedger[jan + "Pink"].map(
        (r: any) => r.inventoryTransfer.orderIds,
      ),
    ).toEqual([["blue"], ["grey"]]);
    expect(
      after.inventory.costLedger[jan + "Pink"].every(
        (r: any) => r.receivedQty === 0,
      ),
    ).toBe(true);
    expect(after.listings.idToHandle[jan + "Pink"]).toBeTruthy();
    expect(approve(after)).toEqual(after);
  });
  it("allows operator renaming Gray to Grey without changing the receiving inventory identities", () => {
    let draft = propose(fixture(), ["Blue", "Gray", "Pink"]);
    draft = rootReducer(
      draft,
      event("listingCreation/update_variant_value", {
        janCode: jan,
        variantId: "v1",
        value: "Grey",
      }),
      () => {},
    );
    expect(stock(approve(draft))).toEqual({
      [jan + "Blue"]: 8,
      [jan + "Grey"]: 8,
      [jan + "Pink"]: 8,
    });
  });
  it("preserves past sales, earlier valuations, and the current weighted cost of mixed receipts", () => {
    const before = fixture(4, true),
      after = approve(propose(before));
    expect(stock(after)).toEqual({
      [jan + "Blue"]: 8,
      [jan + "Grey"]: 8,
      [jan + "Pink"]: 8,
    });
    expect(after.inventory.idToItem[jan + "Blue"].shipped).toBe(4);
    expect(totalValuation(Object.values(after.inventory.costLedger))).toEqual(
      totalValuation(Object.values(before.inventory.costLedger)),
    );
    expect(
      totalValuation(Object.values(after.inventory.costLedger), at - 1),
    ).toEqual(
      totalValuation(Object.values(before.inventory.costLedger), at - 1),
    );
    expect(after.inventory.costLedger[jan + "Blue"].slice(0, 3)).toEqual(
      before.inventory.costLedger[jan + "Blue"],
    );
    expect(valueAt(after.inventory.costLedger[jan + "Pink"]).avgJpy).toBe(225);
  });
  it("leaves quantities and cost ledgers unchanged when the existing variants already have the right allocation", () => {
    const before = fixture(),
      after = approve(propose(before, ["Blue", "Grey"]));
    expect(stock(after)).toEqual(stock(before));
    expect(after.inventory.costLedger).toEqual(before.inventory.costLedger);
  });
  it("reports incomplete allocations and duplicate subtype names without applying a listing or moving inventory", () => {
    const before = fixture();
    let draft = propose(before);
    draft = rootReducer(
      draft,
      event("listingCreation/update_variant_qty", {
        janCode: jan,
        variantId: "v0",
        qty: 9,
      }),
      () => {},
    );
    const rejected = approve(draft);
    expect(rejected.listingCreation.proposals[jan].allocationError).toContain(
      "24",
    );
    expect(rejected.inventory).toEqual(before.inventory);
    expect(rejected.listings).toEqual(before.listings);
    expect(
      approve(propose(before, ["Blue", "Blue", "Pink"])).listingCreation
        .proposals[jan].allocationError,
    ).toContain("different subtype");
  });
  it("reuses zero-stock target inventory and preserves its earlier sales", () => {
    let before = fixture();
    before = rootReducer(
      before,
      event("update_item", {
        id: jan + "Pink",
        item: { janCode: jan, subtype: "Pink", qty: 2, shipped: 2 },
      }),
      () => {},
    );
    before = {
      ...before,
      inventory: {
        ...before.inventory,
        costLedger: {
          ...before.inventory.costLedger,
          [jan + "Pink"]: [
            ...before.inventory.costLedger[jan + "Pink"],
            { id: "pink-sale", kind: "sale", at: at - 1, seq: 1, qty: 2 },
          ],
        },
      },
    };
    const after = approve(propose(before));
    expect(stock(after)[jan + "Pink"]).toBe(8);
    expect(after.inventory.idToItem[jan + "Pink"].shipped).toBe(2);
  });
  it("keeps a single existing inventory identity when its listing option label changes", () => {
    let before = fixture();
    before = {
      ...before,
      inventory: {
        ...before.inventory,
        idToItem: { [jan + "Blue"]: before.inventory.idToItem[jan + "Blue"] },
      },
    };
    const after = approve(propose(before, ["Default"]));
    expect(Object.keys(after.inventory.idToItem)).toEqual([jan + "Blue"]);
    expect(stock(after)[jan + "Blue"]).toBe(12);
    expect(after.inventory.costLedger).toEqual(before.inventory.costLedger);
  });
  it("follows later purchase cost corrections through a mixed-source transfer", () => {
    let after = approve(propose(fixture(4, true)));
    after = rootReducer(
      after,
      event("apply_stock_order_costs", {
        orderId: "blue-old",
        rows: [{ jan, qty: 8, unitCostJpy: 200 }],
        overrideExisting: true,
      }),
      () => {},
    );
    expect(valueAt(after.inventory.costLedger[jan + "Pink"]).avgJpy).toBe(250);
    expect(stock(after)).toEqual({
      [jan + "Blue"]: 8,
      [jan + "Grey"]: 8,
      [jan + "Pink"]: 8,
    });
  });
  it("conserves value when one stock source has not yet been priced", () => {
    let before = fixture();
    before = {
      ...before,
      inventory: {
        ...before.inventory,
        costLedger: {
          ...before.inventory.costLedger,
          [jan + "Blue"]: before.inventory.costLedger[jan + "Blue"].map(
            (e: any) => ({ ...e, unitCostJpy: 0, unitCostEur: 0 }),
          ),
        },
      },
    };
    const after = approve(propose(before));
    expect(totalValuation(Object.values(after.inventory.costLedger))).toEqual(
      totalValuation(Object.values(before.inventory.costLedger)),
    );
    expect(valueAt(after.inventory.costLedger[jan + "Pink"]).avgJpy).toBe(100);
  });
  it("keeps each JAN's stock separate when proposals are merged into one listing", () => {
    const otherJan = "1234567890123";
    let draft = fixture();
    draft = rootReducer(
      draft,
      event("update_item", {
        id: otherJan,
        item: {
          janCode: otherJan,
          subtype: "",
          qty: 5,
          shipped: 0,
          pieces: 1,
        },
      }),
      () => {},
    );
    draft = propose(draft);
    draft = rootReducer(
      draft,
      event("listingCreation/add_proposals", [
        {
          janCode: otherJan,
          title: "Other scissors",
          allocationMode: POOLED_LISTING_STOCK,
          variants: [{ id: "other-v", option1Value: "Default" }],
          photoGroupIds: [],
          status: "draft",
        },
      ]),
      () => {},
    );
    draft = rootReducer(
      draft,
      event("listingCreation/merge_proposal", {
        sourceJan: otherJan,
        targetJan: jan,
      }),
      () => {},
    );
    const after = approve(draft);
    expect(stock(after)).toEqual({
      [jan + "Blue"]: 8,
      [jan + "Grey"]: 8,
      [jan + "Pink"]: 8,
      [otherJan]: 5,
    });
    expect(after.listings.idToHandle[otherJan]).toBe(
      after.listings.idToHandle[jan + "Blue"],
    );
  });
  it("allocates a split draft's shared stock once, then approves the remaining draft independently", () => {
    let draft = propose(fixture());
    draft = rootReducer(
      draft,
      event("listingCreation/split_variant", {
        janCode: jan,
        variantId: "v2",
        newHandle: "pink-scissors",
      }),
      () => {},
    );
    draft = rootReducer(
      draft,
      event("listingCreation/approve_proposal", { janCode: "v2" }),
      () => {},
    );
    expect(stock(draft)).toEqual({
      [jan + "Blue"]: 8,
      [jan + "Grey"]: 8,
      [jan + "Pink"]: 8,
    });
    expect(draft.inventory.idToItem[jan + "Pink"].handle).toBe("pink-scissors");
    expect(draft.inventory.idToItem[jan + "Blue"].handle || "").toBe("");
    expect(
      draft.listingCreation.proposals[jan].variants.map((v: any) => v.itemId),
    ).toEqual([jan + "Blue", jan + "Grey"]);
    const ledger = draft.inventory.costLedger;
    const after = approve(draft);
    expect(stock(after)).toEqual(stock(draft));
    expect(after.inventory.costLedger).toEqual(ledger);
    expect(after.inventory.idToItem[jan + "Blue"].handle).toBeTruthy();
  });
  it("retains the historical allocation and approval rules for old events", () => {
    const draft = propose(fixture(), ["Blue", "Grey", "Pink"], false);
    expect(
      draft.listingCreation.proposals[jan].variants.map((v: any) => v.qty),
    ).toEqual([4, 4, 4]);
    expect(stock(approve(draft))).toEqual({
      [jan + "Blue"]: 8,
      [jan + "Grey"]: 12,
      [jan + "Pink"]: 4,
    });
  });
});
