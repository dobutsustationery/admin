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

  it("handles authoritative reconciliation: removes deleted transactions", () => {
    const store = setupStore();
    const receiptId = "auth-123";

    // 1. Initial creation with 2 transactions
    store.dispatch({
      ...etsy_order_created({
        raw: {
          receipt_id: receiptId,
          create_timestamp: 1000,
          status: "paid",
          transactions: [
            { transaction_id: "tx1", sku: itemKey, quantity: 2 },
            { transaction_id: "tx2", sku: itemKey, quantity: 3 },
          ],
        },
        topic: "receipt.created",
      }),
      timestamp: { seconds: 1200, nanoseconds: 0 },
    } as any);

    expect(store.getState().inventory.idToItem[itemKey].shipped).toBe(5);

    // 2. Reconcile with tx2 removed
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

    // Total shipped should drop to 2
    expect(store.getState().inventory.idToItem[itemKey].shipped).toBe(2);
    const history = store.getState().inventory.idToHistory[itemKey];
    expect(history.some((h) => h.desc.includes("diff -3"))).toBe(true);
  });

  it("integrates with temporal bindings: renames follow Etsy facts", () => {
    const store = setupStore();
    const receiptId = "rename-123";

    // 1. Order for itemKey
    store.dispatch({
      ...etsy_order_created({
        raw: {
          receipt_id: receiptId,
          create_timestamp: 1000,
          status: "paid",
          transactions: [{ transaction_id: "tx1", sku: itemKey, quantity: 1 }],
        },
        topic: "receipt.created",
      }),
      timestamp: { seconds: 1200, nanoseconds: 0 },
    } as any);

    // 2. Setup New Item (same JAN) and Rename itemKey -> newItemKey
    const newItemKey = `${itemKey}New`;
    store.dispatch({
      ...update_item({
        id: newItemKey,
        item: { ...testItem, subtype: "New" } as any,
      }),
      timestamp: { seconds: 1300, nanoseconds: 0 },
      id: "new-item-setup",
    } as any);

    store.dispatch({
      type: "update_field",
      payload: { id: itemKey, field: "subtype", to: "New", from: "" },
      timestamp: { seconds: 1500, nanoseconds: 0 },
      id: "rename-action",
    } as any);

    // After rename, facts and items should be updated
    const order =
      store.getState().inventory.orderIdToOrder[`etsy:${receiptId}`];
    expect(order.items[0].itemKey).toBe(newItemKey);
    expect(order.etsyFacts!.lines["tx1"].itemKey).toBe(newItemKey);

    // 3. Reconcile - should NOT revert to old key
    store.dispatch({
      ...etsy_order_reconciled({
        raw: {
          receipt_id: receiptId,
          create_timestamp: 1000,
          updated_timestamp: 2000,
          status: "paid",
          transactions: [{ transaction_id: "tx1", sku: itemKey, quantity: 1 }],
        },
        topic: "reconcile",
      }),
      timestamp: { seconds: 2000, nanoseconds: 0 },
    } as any);

    expect(
      store.getState().inventory.orderIdToOrder[`etsy:${receiptId}`].items[0]
        .itemKey,
    ).toBe(newItemKey);
  });

  it("is idempotent for duplicate created events", () => {
    const store = setupStore();
    const receiptId = "idempotent-123";
    const action = {
      ...etsy_order_created({
        raw: {
          receipt_id: receiptId,
          create_timestamp: 1000,
          status: "paid",
          transactions: [{ transaction_id: "tx1", sku: itemKey, quantity: 1 }],
        },
        topic: "receipt.created",
      }),
      timestamp: { seconds: 1200, nanoseconds: 0 },
    };

    store.dispatch(action as any);
    expect(store.getState().inventory.idToItem[itemKey].shipped).toBe(1);

    // Dispatch again - should have no extra effect if order exists and items match
    store.dispatch(action as any);
    expect(store.getState().inventory.idToItem[itemKey].shipped).toBe(1);
  });

  it("resolves items using fallback mapper (title/variations)", () => {
    const store = setupStore();
    const receiptId = "fallback-123";

    store.dispatch({
      ...etsy_order_created({
        raw: {
          receipt_id: receiptId,
          create_timestamp: 1000,
          status: "paid",
          transactions: [
            {
              transaction_id: "tx1",
              sku: "", // Missing SKU
              title: `Some item with JAN ${itemKey} in title`,
              variations: [
                { formatted_value: "Blue" },
                { formatted_value: "Small" },
              ],
              quantity: 1,
            },
          ],
        },
        topic: "receipt.created",
      }),
      timestamp: { seconds: 1200, nanoseconds: 0 },
    } as any);

    // Should resolve to itemKey + "Blue Small"
    const expectedKey = `${itemKey}Blue Small`;
    // We didn't setup this item, so it should be an exception
    const state = store.getState().inventory;
    expect(state.etsyExceptions![`etsy:${receiptId}`][0]).toContain(
      `Unknown SKU: ${expectedKey}`,
    );
  });

  it("records exception for missing historical binding", () => {
    const store = setupStore();
    const receiptId = "hist-123";

    // Item was created at T=500 (setupStore)
    // Dispatch order with T=400 (before item existed)
    store.dispatch({
      ...etsy_order_created({
        raw: {
          receipt_id: receiptId,
          create_timestamp: 400,
          status: "paid",
          transactions: [{ transaction_id: "tx1", sku: itemKey, quantity: 1 }],
        },
        topic: "receipt.created",
      }),
      timestamp: { seconds: 1200, nanoseconds: 0 },
    } as any);

    const state = store.getState().inventory;
    expect(state.etsyExceptions![`etsy:${receiptId}`][0]).toContain(
      "Unknown SKU",
    );
    // Impact should be 0 because resolution failed
    expect(state.idToItem[itemKey].shipped).toBe(0);
  });

  it("handles full refunds correctly (authoritative fix)", () => {
    const store = setupStore();
    const receiptId = "refund-123";

    // 1. Paid
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

    // 2. Refunded
    store.dispatch({
      ...etsy_order_updated({
        raw: {
          receipt_id: receiptId,
          create_timestamp: 1000,
          updated_timestamp: 1500,
          status: "refunded",
          transactions: [{ transaction_id: "tx1", sku: itemKey, quantity: 5 }],
        },
        topic: "receipt.updated",
      }),
      timestamp: { seconds: 1500, nanoseconds: 0 },
    } as any);

    // Total shipped should be 0, not -5 (double deduction fix)
    expect(store.getState().inventory.idToItem[itemKey].shipped).toBe(0);
  });

  it("handles partial refunds conservatively (no impact change yet)", () => {
    const store = setupStore();
    const receiptId = "partial-refund-123";

    // 1. Paid
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

    // 2. Partially Refunded
    store.dispatch({
      ...etsy_order_updated({
        raw: {
          receipt_id: receiptId,
          create_timestamp: 1000,
          updated_timestamp: 1500,
          status: "partially_refunded",
          transactions: [{ transaction_id: "tx1", sku: itemKey, quantity: 5 }],
        },
        topic: "receipt.updated",
      }),
      timestamp: { seconds: 1500, nanoseconds: 0 },
    } as any);

    // Should stay at 5 because we don't handle partial amounts yet (conservative)
    expect(store.getState().inventory.idToItem[itemKey].shipped).toBe(5);
  });

  it("preserves manual retypes through authoritative reconciliation", () => {
    const store = setupStore();
    const receiptId = "manual-retype-123";
    const manualKey = "4900000000000" as any;

    // Create manual target item
    store.dispatch({
      ...update_item({
        id: manualKey,
        item: { ...testItem, janCode: "4900000000000" } as any,
      }),
      timestamp: { seconds: 600, nanoseconds: 0 },
      id: "manual-setup",
    } as any);

    // 1. Order arrives for itemKey
    store.dispatch({
      ...etsy_order_created({
        raw: {
          receipt_id: receiptId,
          create_timestamp: 1000,
          status: "paid",
          transactions: [{ transaction_id: "tx1", sku: itemKey, quantity: 1 }],
        },
        topic: "receipt.created",
      }),
      timestamp: { seconds: 1200, nanoseconds: 0 },
    } as any);

    expect(store.getState().inventory.idToItem[itemKey].shipped).toBe(1);

    // 2. Manual Retype itemKey -> manualKey for this order
    store.dispatch({
      type: "retype_item",
      payload: {
        itemKey: itemKey,
        janCode: "4900000000000",
        subtype: "",
        qty: 1,
        orderID: `etsy:${receiptId}`,
      },
      timestamp: { seconds: 1300, nanoseconds: 0 },
      id: "retype-action",
    } as any);

    expect(store.getState().inventory.idToItem[itemKey].shipped).toBe(0);
    expect(store.getState().inventory.idToItem[manualKey].shipped).toBe(1);

    // 3. Reconcile with same ground truth
    store.dispatch({
      ...etsy_order_reconciled({
        raw: {
          receipt_id: receiptId,
          create_timestamp: 1000,
          updated_timestamp: 2000,
          status: "paid",
          transactions: [{ transaction_id: "tx1", sku: itemKey, quantity: 1 }],
        },
        topic: "reconcile",
      }),
      timestamp: { seconds: 2000, nanoseconds: 0 },
    } as any);

    // Should STILL be manualKey
    expect(store.getState().inventory.idToItem[manualKey].shipped).toBe(1);
    expect(store.getState().inventory.idToItem[itemKey].shipped).toBe(0);
    const order =
      store.getState().inventory.orderIdToOrder[`etsy:${receiptId}`];
    expect(order.items[0].itemKey).toBe(manualKey);
  });

  it("ignores out-of-order updates (older than reconciledTimestamp)", () => {
    const store = setupStore();
    const receiptId = "ooo-123";

    // 1. Reconciled at T=2000
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

    expect(store.getState().inventory.idToItem[itemKey].shipped).toBe(2);

    // 2. Delayed webhook arrives with T=1500 (older than 2000)
    store.dispatch({
      ...etsy_order_updated({
        raw: {
          receipt_id: receiptId,
          create_timestamp: 1000,
          updated_timestamp: 1500,
          status: "canceled", // Would normally zero it out
          transactions: [{ transaction_id: "tx1", sku: itemKey, quantity: 2 }],
        },
        topic: "receipt.updated",
      }),
      timestamp: { seconds: 2500, nanoseconds: 0 },
    } as any);

    // Should STILL be 2
    expect(store.getState().inventory.idToItem[itemKey].shipped).toBe(2);
  });

  it("resolves items using fallback mapper - happy path", () => {
    const store = setupStore();
    const receiptId = "fallback-happy-123";
    const blueLargeKey = `${itemKey}Blue Large`;

    // Setup the item with both variations
    store.dispatch({
      ...update_item({
        id: blueLargeKey,
        item: { ...testItem, subtype: "Blue Large" } as any,
      }),
      timestamp: { seconds: 600, nanoseconds: 0 },
      id: "blue-large-setup",
    } as any);

    store.dispatch({
      ...etsy_order_created({
        raw: {
          receipt_id: receiptId,
          create_timestamp: 1000,
          status: "paid",
          transactions: [
            {
              transaction_id: "tx1",
              sku: "",
              title: `JAN ${itemKey} is here`,
              variations: [
                { formatted_value: "Blue" },
                { formatted_value: "Large" },
              ],
              quantity: 3,
            },
          ],
        },
        topic: "receipt.created",
      }),
      timestamp: { seconds: 1200, nanoseconds: 0 },
    } as any);

    expect(store.getState().inventory.idToItem[blueLargeKey].shipped).toBe(3);
    expect(
      store.getState().inventory.etsyExceptions?.[`etsy:${receiptId}`],
    ).toBeUndefined();
  });
});
