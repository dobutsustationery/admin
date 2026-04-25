import { describe, it, expect } from "vitest";
import {
  inventory,
  shopify_order_created,
  shopify_order_reconciled,
  shopify_order_updated,
  shopify_order_cancelled,
} from "../../src/lib/inventory";
import { configureStore } from "@reduxjs/toolkit";

describe("Shopify Order History logging", () => {
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
    initialized: true,
  };

  it("logs Created and Reconciled events, and sorts them by val", () => {
    const store = configureStore({
      reducer: { inventory },
      preloadedState: { inventory: initialState as any },
    });

    const orderId = "123";
    const shopifyOrderId = `shopify:${orderId}`;

    // 1. Dispatch Reconciled (T=20) first (simulating poller hitting before webhook)
    store.dispatch({
      ...shopify_order_reconciled({
        raw: {
          id: orderId,
          updated_at: "2023-01-01T10:00:20Z",
          line_items: [{ id: "li1", sku: itemKey, quantity: 1 }],
        },
        topic: "reconcile",
      }),
      timestamp: 20000, // Action timestamp
    } as any);

    // 2. Dispatch Created (T=10) later
    store.dispatch({
      ...shopify_order_created({
        raw: {
          id: orderId,
          created_at: "2023-01-01T10:00:10Z",
          line_items: [{ id: "li1", sku: itemKey, quantity: 1 }],
        },
        topic: "orders/create",
      }),
      timestamp: 10000, // Action timestamp
    } as any);

    const history = store.getState().inventory.idToHistory[itemKey];
    expect(history).toHaveLength(2);

    // Should be sorted by val (10000, then 20000)
    expect(history[0].val).toBe(10000);
    expect(history[0].desc).toContain("Shopify Order Created");
    expect(history[1].val).toBe(20000);
    expect(history[1].desc).toContain("Shopify Order Reconciled");

    // Shipped count should be correct (1, not 2)
    expect(store.getState().inventory.idToItem[itemKey].shipped).toBe(1);
  });

  it("uses correct labels for updated and cancelled", () => {
    const store = configureStore({
      reducer: { inventory },
      preloadedState: { inventory: initialState as any },
    });

    const orderId = "456";

    store.dispatch({
      ...shopify_order_created({
        raw: {
          id: orderId,
          created_at: "2023-01-01T10:00:00Z",
          line_items: [{ id: "li1", sku: itemKey, quantity: 1 }],
        },
        topic: "orders/create",
      }),
      timestamp: 10000,
    } as any);

    store.dispatch({
      ...shopify_order_updated({
        raw: {
          id: orderId,
          updated_at: "2023-01-01T10:00:05Z",
          line_items: [{ id: "li1", sku: itemKey, quantity: 2 }],
        },
        topic: "orders/updated",
      }),
      timestamp: 15000,
    } as any);

    store.dispatch({
      ...shopify_order_cancelled({
        raw: {
          id: orderId,
          updated_at: "2023-01-01T10:00:10Z",
          cancelled_at: "2023-01-01T10:00:10Z",
          line_items: [{ id: "li1", sku: itemKey, quantity: 2 }],
        },
        topic: "orders/cancelled",
      }),
      timestamp: 20000,
    } as any);

    const history = store.getState().inventory.idToHistory[itemKey];
    expect(history).toHaveLength(3);
    expect(history[0].desc).toContain("Shopify Order Created");
    expect(history[1].desc).toContain("Shopify Order Updated");
    expect(history[2].desc).toContain("Shopify Order Cancelled");

    expect(store.getState().inventory.idToItem[itemKey].shipped).toBe(0);
  });
});
