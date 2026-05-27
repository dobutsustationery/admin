import { describe, it, expect } from "vitest";
import {
  inventory,
  shopify_order_created,
  shopify_order_reconciled,
  shopify_order_updated,
  shopify_order_cancelled,
  update_item,
} from "../../src/lib/inventory";
import { configureStore } from "@reduxjs/toolkit";

describe("Shopify Order History logging", () => {
  const withBroadcastMeta = <T extends { type: string }>(
    action: T,
    id: string,
    ms: number,
  ) =>
    ({
      ...action,
      id,
      timestamp: {
        seconds: Math.floor(ms / 1000),
        nanoseconds: (ms % 1000) * 1_000_000,
      },
    }) as T & {
      id: string;
      timestamp: { seconds: number; nanoseconds: number };
    };

  const itemKey = "1234567890123";
  const initialState = {
    idToItem: {},
    idToHistory: {},
    orderIdToOrder: {},
    initialized: true,
  };

  it("logs Created and Reconciled events, and sorts them by val", () => {
    const store = configureStore({
      reducer: { inventory },
      preloadedState: { inventory: initialState as any },
    });

    // Create item first
    store.dispatch(
      withBroadcastMeta(
        update_item({
          id: itemKey,
          item: {
            janCode: "1234567890123",
            subtype: "",
            qty: 10,
            shipped: 0,
            description: "Test Item",
          } as any,
        }),
        "create-item",
        5000,
      ),
    );

    const orderId = "123";
    const shopifyOrderId = `shopify:${orderId}`;

    // 1. Dispatch Reconciled (T=20) first (simulating poller hitting before webhook)
    store.dispatch(
      withBroadcastMeta(
        shopify_order_reconciled({
          raw: {
            id: orderId,
            updated_at: "2023-01-01T10:00:20Z",
            line_items: [{ id: "li1", sku: itemKey, quantity: 1 }],
          },
          topic: "reconcile",
        }),
        "order-reconcile",
        20000,
      ),
    );

    // 2. Dispatch Created (T=10) later
    store.dispatch(
      withBroadcastMeta(
        shopify_order_created({
          raw: {
            id: orderId,
            created_at: "2023-01-01T10:00:10Z",
            line_items: [{ id: "li1", sku: itemKey, quantity: 1 }],
          },
          topic: "orders/create",
        }),
        "order-create",
        10000,
      ),
    );

    const history = store.getState().inventory.idToHistory[itemKey];
    expect(history).toHaveLength(3); // +1 for update_item

    // Should be sorted by val (5000, 10000, then 20000)
    expect(history[0].val).toBe(5000);
    expect(history[1].val).toBe(10000);
    expect(history[1].desc).toContain("Shopify Order Created");
    expect(history[2].val).toBe(20000);
    expect(history[2].desc).toContain("Shopify Order Reconciled");

    // Shipped count should be correct (1, not 2)
    expect(store.getState().inventory.idToItem[itemKey].shipped).toBe(1);
  });

  it("uses correct labels for updated and cancelled", () => {
    const store = configureStore({
      reducer: { inventory },
      preloadedState: { inventory: initialState as any },
    });

    // Create item first
    store.dispatch(
      withBroadcastMeta(
        update_item({
          id: itemKey,
          item: {
            janCode: "1234567890123",
            subtype: "",
            qty: 10,
            shipped: 0,
            description: "Test Item",
          } as any,
        }),
        "create-item",
        5000,
      ),
    );

    const orderId = "456";

    store.dispatch(
      withBroadcastMeta(
        shopify_order_created({
          raw: {
            id: orderId,
            created_at: "2023-01-01T10:00:00Z",
            line_items: [{ id: "li1", sku: itemKey, quantity: 1 }],
          },
          topic: "orders/create",
        }),
        "order-create",
        10000,
      ),
    );

    store.dispatch(
      withBroadcastMeta(
        shopify_order_updated({
          raw: {
            id: orderId,
            updated_at: "2023-01-01T10:00:05Z",
            line_items: [{ id: "li1", sku: itemKey, quantity: 2 }],
          },
          topic: "orders/updated",
        }),
        "order-update",
        15000,
      ),
    );

    store.dispatch(
      withBroadcastMeta(
        shopify_order_cancelled({
          raw: {
            id: orderId,
            updated_at: "2023-01-01T10:00:10Z",
            cancelled_at: "2023-01-01T10:00:10Z",
            line_items: [{ id: "li1", sku: itemKey, quantity: 2 }],
          },
          topic: "orders/cancelled",
        }),
        "order-cancel",
        20000,
      ),
    );

    const history = store.getState().inventory.idToHistory[itemKey];
    expect(history).toHaveLength(4); // +1 for update_item
    expect(history[1].desc).toContain("Shopify Order Created");
    expect(history[2].desc).toContain("Shopify Order Updated");
    expect(history[3].desc).toContain("Shopify Order Cancelled");

    expect(store.getState().inventory.idToItem[itemKey].shipped).toBe(0);
  });

  it("records Shopify sales in the cost ledger at the order date", () => {
    const store = configureStore({
      reducer: { inventory },
      preloadedState: { inventory: initialState as any },
    });

    store.dispatch(
      withBroadcastMeta(
        update_item({
          id: itemKey,
          item: {
            janCode: "1234567890123",
            subtype: "",
            qty: 10,
            shipped: 0,
            description: "Test Item",
          } as any,
        }),
        "create-item",
        Date.parse("2022-12-31T00:00:00Z"),
      ),
    );

    store.dispatch(
      withBroadcastMeta(
        shopify_order_reconciled({
          raw: {
            id: "dated-sale",
            created_at: "2023-01-01T09:00:00Z",
            updated_at: "2023-01-15T10:00:00Z",
            line_items: [{ id: "li1", sku: itemKey, quantity: 2 }],
          },
          topic: "reconcile",
        }),
        "order-reconcile",
        Date.parse("2023-02-01T00:00:00Z"),
      ),
    );

    const sale = store
      .getState()
      .inventory.costLedger![
        itemKey
      ].find((entry: any) => entry.kind === "sale");
    expect(sale?.at).toBe(Date.parse("2023-01-01T09:00:00Z"));
  });
});
