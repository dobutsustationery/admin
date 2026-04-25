import { describe, it, expect } from "vitest";
import {
  inventory,
  etsy_order_created,
  etsy_order_reconciled,
  etsy_order_updated,
} from "../../src/lib/inventory";
import { configureStore } from "@reduxjs/toolkit";

describe("Etsy Order History logging", () => {
  const itemKey = "1234567890123";
  const initialState = {
    idToItem: {
      [itemKey]: {
        janCode: "1234567890123",
        subtype: "",
        qty: 10,
        shipped: 0,
        description: "Test Item",
      },
    },
    idToHistory: {},
    orderIdToOrder: {},
    etsyExceptions: {},
    initialized: true,
  };

  it("logs Etsy Created and Reconciled events, and calculates shipped qty", () => {
    const store = configureStore({
      reducer: { inventory },
      preloadedState: { inventory: initialState as any },
    });

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
      timestamp: 1000000,
    } as any);

    let history = store.getState().inventory.idToHistory[itemKey];
    expect(history).toHaveLength(1);
    expect(history[0].desc).toContain("Etsy Order Created");
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
      timestamp: 2000000,
    } as any);

    history = store.getState().inventory.idToHistory[itemKey];
    expect(history).toHaveLength(1); // No change in qty, so reconciliation might not log unless diff?
    // Actually applyEtsyOrderReconciliation logs if diff !== 0.

    expect(store.getState().inventory.idToItem[itemKey].shipped).toBe(2);
  });

  it("handles Etsy cancellations correctly", () => {
    const store = configureStore({
      reducer: { inventory },
      preloadedState: { inventory: initialState as any },
    });

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
      timestamp: 1500000,
    } as any);

    expect(store.getState().inventory.idToItem[itemKey].shipped).toBe(0);
    const history = store.getState().inventory.idToHistory[itemKey];
    expect(history.some((h) => h.desc.includes("Etsy Order Updated"))).toBe(
      true,
    );
    expect(history.some((h) => h.desc.includes("diff -5"))).toBe(true);
  });
});
