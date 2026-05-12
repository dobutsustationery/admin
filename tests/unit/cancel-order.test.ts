import { describe, expect, it } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import {
  cancel_order,
  etsy_order_created,
  inventory,
  new_order,
  package_item,
  prepareCancelOrder,
  update_item,
} from "../../src/lib/inventory";

const itemKey = "1234567890123Cat";

function setupStore() {
  const store = configureStore({
    reducer: { inventory },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({ serializableCheck: false }),
  });
  store.dispatch({
    ...update_item({
      id: itemKey,
      item: {
        janCode: "1234567890123",
        subtype: "Cat",
        qty: 20,
        shipped: 0,
      } as any,
    }),
    timestamp: { seconds: 500, nanoseconds: 0 },
    id: "seed",
  } as any);
  return store;
}

describe("cancel_order", () => {
  it("reverses shipped impact and marks status canceled on a non-marketplace order", () => {
    const store = setupStore();
    const orderID = "PAY-12345";

    // Build a PayPal-style order via new_order + package_item.
    store.dispatch({
      ...new_order({
        orderID,
        date: new Date("2026-01-01"),
        email: "buyer@example.com",
        product: "Some Product",
      }),
      timestamp: { seconds: 1000, nanoseconds: 0 },
      id: "new-order",
    } as any);
    store.dispatch({
      ...package_item({ orderID, itemKey: itemKey as any, qty: 3 }),
      timestamp: { seconds: 1100, nanoseconds: 0 },
      id: "pkg",
    } as any);

    expect(store.getState().inventory.idToItem[itemKey].shipped).toBe(3);

    store.dispatch({
      ...cancel_order({ orderID }),
      timestamp: { seconds: 1200, nanoseconds: 0 },
      id: "cancel",
    } as any);

    const state = store.getState().inventory;
    expect(state.idToItem[itemKey].shipped).toBe(0);
    expect(state.orderIdToOrder[orderID].status).toBe("Canceled");
    expect(state.orderIdToOrder[orderID].items).toEqual([]);
  });

  it("zeros etsyFacts impact and re-derives items for marketplace orders", () => {
    const store = setupStore();
    const receiptId = "9999";
    const orderID = `etsy:${receiptId}`;

    store.dispatch({
      ...etsy_order_created({
        raw: {
          receipt_id: receiptId,
          create_timestamp: 1000,
          status: "Paid",
          transactions: [{ transaction_id: "tx1", sku: itemKey, quantity: 4 }],
        },
        topic: "receipt.created",
      }),
      timestamp: { seconds: 1100, nanoseconds: 0 },
    } as any);
    expect(store.getState().inventory.idToItem[itemKey].shipped).toBe(4);

    store.dispatch({
      ...cancel_order({ orderID }),
      timestamp: { seconds: 1200, nanoseconds: 0 },
      id: "cancel",
    } as any);

    const state = store.getState().inventory;
    expect(state.idToItem[itemKey].shipped).toBe(0);
    expect(state.orderIdToOrder[orderID].status).toBe("Canceled");
    expect(state.orderIdToOrder[orderID].items).toEqual([]);
    // Facts are updated so a future reconcile sees a zero-impact record.
    const fact = state.orderIdToOrder[orderID].etsyFacts!.lines["tx1"];
    expect(fact.placed).toBe(4);
    expect(fact.cancelled).toBe(4);
    expect(fact.refunded).toBe(0);
  });

  describe("prepareCancelOrder (UI click guard)", () => {
    it("returns null when uid is undefined (the crash bug)", () => {
      // Reproduces the production crash: $user is the writable<User>() store's
      // initial value (undefined), so $user.uid would throw.  The helper
      // accepts undefined uid and returns null without throwing.
      expect(prepareCancelOrder("etsy:123", undefined, false)).toBeNull();
      expect(prepareCancelOrder("etsy:123", null, false)).toBeNull();
      expect(prepareCancelOrder("etsy:123", "", false)).toBeNull();
    });

    it("returns null when orderID is missing", () => {
      expect(prepareCancelOrder(null, "uid-1", false)).toBeNull();
      expect(prepareCancelOrder(undefined, "uid-1", false)).toBeNull();
      expect(prepareCancelOrder("", "uid-1", false)).toBeNull();
    });

    it("returns null when the order is already canceled (no double-cancel)", () => {
      expect(prepareCancelOrder("etsy:123", "uid-1", true)).toBeNull();
    });

    it("returns a valid plan when all preconditions are met", () => {
      const plan = prepareCancelOrder("etsy:123", "uid-1", false);
      expect(plan).not.toBeNull();
      expect(plan!.uid).toBe("uid-1");
      expect(plan!.action.type).toBe("cancel_order");
      expect((plan!.action as any).payload).toEqual({ orderID: "etsy:123" });
    });
  });

  it("is a no-op for unknown order ids", () => {
    const store = setupStore();
    store.dispatch({
      ...cancel_order({ orderID: "does-not-exist" }),
      timestamp: { seconds: 1, nanoseconds: 0 },
      id: "noop",
    } as any);
    // Nothing should crash; nothing should change.
    expect(store.getState().inventory.idToItem[itemKey].shipped).toBe(0);
  });
});
