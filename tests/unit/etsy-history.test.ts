import { describe, it, expect } from "vitest";
import {
  inventory,
  etsy_order_created,
  etsy_order_reconciled,
  etsy_order_updated,
  update_item,
  initialState as inventoryInitialState,
} from "../../src/lib/inventory";
import { configureStore } from "@reduxjs/toolkit";

describe("Etsy Order History logging", () => {
  const itemKey = "1234567890123";
  const testItem = {
    janCode: "1234567890123",
    subtype: "",
    qty: 10,
    shipped: 0,
    description: "Test Item",
  };

  function setupStore() {
    const store = configureStore({
      reducer: { inventory },
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware({
          serializableCheck: false,
        }),
    });

    // Initialize item via reducer to get bindings
    store.dispatch({
      ...update_item({ id: itemKey, item: testItem as any }),
      timestamp: { seconds: 500, nanoseconds: 0 },
      id: "initial-setup",
    } as any);

    return store;
  }

  it("logs Etsy Created and Reconciled events, and calculates shipped qty", () => {
    const store = setupStore();

    const receiptId = "98765";
    const etsyOrderID = `etsy:${receiptId}`;

    // 1. Dispatch Created (T=1000)
    store.dispatch({
      ...etsy_order_created({
        raw: {
          receipt_id: receiptId,
          create_timestamp: 1000,
          status: "paid",
          transactions: [{ transaction_id: "tx1", sku: itemKey, quantity: 2 }],
        },
        topic: "receipt.created",
      }),
      timestamp: { seconds: 1000, nanoseconds: 0 },
    } as any);

    let history = store.getState().inventory.idToHistory[itemKey];
    expect(history.some((h) => h.desc.includes("Etsy Order Created"))).toBe(
      true,
    );
    expect(store.getState().inventory.idToItem[itemKey].shipped).toBe(2);

    // 2. Dispatch Reconciled (T=2000)
    store.dispatch({
      ...etsy_order_reconciled({
        raw: {
          receipt_id: receiptId,
          create_timestamp: 1000,
          updated_timestamp: 2000,
          status: "paid",
          transactions: [{ transaction_id: "tx1", sku: itemKey, quantity: 2 }],
        },
        topic: "reconcile",
      }),
      timestamp: { seconds: 2000, nanoseconds: 0 },
    } as any);

    history = store.getState().inventory.idToHistory[itemKey];
    expect(store.getState().inventory.idToItem[itemKey].shipped).toBe(2);
  });

  it("handles Etsy cancellations correctly", () => {
    const store = setupStore();

    const receiptId = "112233";

    // 1. Created
    store.dispatch({
      ...etsy_order_created({
        raw: {
          receipt_id: receiptId,
          create_timestamp: 1000,
          status: "paid",
          transactions: [{ transaction_id: "tx1", sku: itemKey, quantity: 5 }],
        },
        topic: "receipt.created",
      }),
      timestamp: { seconds: 1200, nanoseconds: 0 },
    } as any);

    expect(store.getState().inventory.idToItem[itemKey].shipped).toBe(5);

    // 2. Cancelled via Update
    store.dispatch({
      ...etsy_order_updated({
        raw: {
          receipt_id: receiptId,
          create_timestamp: 1000,
          updated_timestamp: 1500,
          status: "canceled",
          transactions: [{ transaction_id: "tx1", sku: itemKey, quantity: 5 }],
        },
        topic: "receipt.updated",
      }),
      timestamp: { seconds: 1500, nanoseconds: 0 },
    } as any);

    expect(store.getState().inventory.idToItem[itemKey].shipped).toBe(0);
    const history = store.getState().inventory.idToHistory[itemKey];
    expect(history.some((h) => h.desc.includes("Etsy Order Updated"))).toBe(
      true,
    );
    expect(history.some((h) => h.desc.includes("diff -5"))).toBe(true);
  });
});
