import { describe, expect, it } from "vitest";
import { makeInventoryItemKey } from "$lib/sku";
import {
  initialState,
  inventory,
  shopify_order_created,
  shopify_order_updated,
  shopify_order_cancelled,
  shopify_refund_created,
  shopify_order_reconciled,
  update_item,
  type Item,
} from "$lib/inventory";

describe("Shopify Sync Reducer", () => {
  const testItem: Item = {
    janCode: "4542804115635",
    subtype: "Silver",
    description: "Test Item",
    hsCode: "49090000",
    image: "http://example.com/image.jpg",
    qty: 100,
    pieces: 1,
    shipped: 0,
    creationDate: "2024-01-01",
    timestamp: 0,
  };
  const itemKey = makeInventoryItemKey(testItem.janCode, testItem.subtype);

  it("handles shopify_order_created and updates shipped quantity", () => {
    let state = inventory(
      initialState,
      update_item({ id: itemKey, item: testItem }),
    );

    const orderID = "shopify:123";
    const action = shopify_order_created({
      raw: {
        id: "123",
        created_at: "2024-01-01T12:00:00Z",
        email: "customer@example.com",
        line_items: [{ id: "li1", sku: itemKey, quantity: 2 }],
      },
      topic: "orders/create",
    });

    state = inventory(state, action);

    expect(state.idToItem[itemKey].shipped).toBe(2);
    expect(state.orderIdToOrder[orderID].items).toEqual([{ itemKey, qty: 2 }]);
    expect(
      state.orderIdToOrder[orderID].shopifyFacts?.lines["li1"].placed,
    ).toBe(2);
  });

  it("handles shopify_order_created idempotently", () => {
    let state = inventory(
      initialState,
      update_item({ id: itemKey, item: testItem }),
    );

    const orderID = "shopify:123";
    const action = shopify_order_created({
      raw: {
        id: "123",
        created_at: "2024-01-01T12:00:00Z",
        email: "customer@example.com",
        line_items: [{ id: "li1", sku: itemKey, quantity: 2 }],
      },
      topic: "orders/create",
    });

    state = inventory(state, action);
    state = inventory(state, action); // Repeat same action

    expect(state.idToItem[itemKey].shipped).toBe(2); // Should not be 4
    expect(state.orderIdToOrder[orderID].items[0].qty).toBe(2);
  });

  it("handles shopify_order_cancelled", () => {
    let state = inventory(
      initialState,
      update_item({ id: itemKey, item: testItem }),
    );

    const orderID = "shopify:123";
    state = inventory(
      state,
      shopify_order_created({
        raw: {
          id: "123",
          created_at: "2024-01-01T12:00:00Z",
          email: "customer@example.com",
          line_items: [{ id: "li1", sku: itemKey, quantity: 2 }],
        },
        topic: "orders/create",
      }),
    );

    state = inventory(
      state,
      shopify_order_cancelled({
        raw: {
          id: "123",
          line_items: [{ id: "li1", sku: itemKey, quantity: 2 }],
        },
        topic: "orders/cancelled",
      }),
    );

    expect(state.idToItem[itemKey].shipped).toBe(0);
    expect(state.orderIdToOrder[orderID].items).toEqual([]);
    expect(
      state.orderIdToOrder[orderID].shopifyFacts?.lines["li1"].cancelled,
    ).toBe(2);
  });

  it("handles shopify_refund_created", () => {
    let state = inventory(
      initialState,
      update_item({ id: itemKey, item: testItem }),
    );

    const orderID = "shopify:123";
    state = inventory(
      state,
      shopify_order_created({
        raw: {
          id: "123",
          created_at: "2024-01-01T12:00:00Z",
          email: "customer@example.com",
          line_items: [{ id: "li1", sku: itemKey, quantity: 5 }],
        },
        topic: "orders/create",
      }),
    );

    state = inventory(
      state,
      shopify_refund_created({
        raw: {
          id: "ref1",
          order_id: "123",
          refund_line_items: [{ line_item_id: "li1", quantity: 2 }],
        },
        topic: "refunds/create",
      }),
    );

    expect(state.idToItem[itemKey].shipped).toBe(3);
    expect(state.orderIdToOrder[orderID].items).toEqual([{ itemKey, qty: 3 }]);
    expect(
      state.orderIdToOrder[orderID].shopifyFacts?.lines["li1"].refunded,
    ).toBe(2);
  });

  it("handles shopify_refund_created idempotently using refundID", () => {
    let state = inventory(
      initialState,
      update_item({ id: itemKey, item: testItem }),
    );

    const orderID = "shopify:123";
    state = inventory(
      state,
      shopify_order_created({
        raw: {
          id: "123",
          created_at: "2024-01-01T12:00:00Z",
          email: "customer@example.com",
          line_items: [{ id: "li1", sku: itemKey, quantity: 5 }],
        },
        topic: "orders/create",
      }),
    );

    const action = shopify_refund_created({
      raw: {
        id: "ref1",
        order_id: "123",
        refund_line_items: [{ line_item_id: "li1", quantity: 2 }],
      },
      topic: "refunds/create",
    });

    state = inventory(state, action);
    state = inventory(state, action); // Repeat same refund

    expect(state.idToItem[itemKey].shipped).toBe(3); // Should not be 1
  });

  it("handles shopify_order_reconciled as ground truth", () => {
    let state = inventory(
      initialState,
      update_item({ id: itemKey, item: testItem }),
    );

    const orderID = "shopify:123";
    // Initially placed 5
    state = inventory(
      state,
      shopify_order_created({
        raw: {
          id: "123",
          created_at: "2024-01-01T12:00:00Z",
          email: "customer@example.com",
          line_items: [{ id: "li1", sku: itemKey, quantity: 5 }],
        },
        topic: "orders/create",
      }),
    );

    // Reconcile says only 3 items now (e.g. some missed event)
    state = inventory(
      state,
      shopify_order_reconciled({
        raw: {
          id: "123",
          updated_at: new Date().toISOString(),
          line_items: [
            { id: "li1", sku: itemKey, quantity: 5, refund_quantity: 2 },
          ],
        },
        topic: "reconcile",
      }),
    );

    expect(state.idToItem[itemKey].shipped).toBe(3);
    expect(state.orderIdToOrder[orderID].items).toEqual([{ itemKey, qty: 3 }]);
  });

  it("handles shopify_order_updated as reconciliation", () => {
    let state = inventory(
      initialState,
      update_item({ id: itemKey, item: testItem }),
    );

    const orderID = "shopify:123";
    // Initially placed 5
    state = inventory(
      state,
      shopify_order_created({
        raw: {
          id: "123",
          created_at: "2024-01-01T12:00:00Z",
          email: "customer@example.com",
          line_items: [{ id: "li1", sku: itemKey, quantity: 5 }],
        },
        topic: "orders/create",
      }),
    );

    // Update says only 3 items now
    state = inventory(
      state,
      shopify_order_updated({
        raw: {
          id: "123",
          updated_at: new Date().toISOString(),
          line_items: [
            { id: "li1", sku: itemKey, quantity: 5, refund_quantity: 2 },
          ],
        },
        topic: "orders/updated",
      }),
    );

    expect(state.idToItem[itemKey].shipped).toBe(3);
    expect(state.orderIdToOrder[orderID].items).toEqual([{ itemKey, qty: 3 }]);
  });

  it("ignores actions older than reconciliation", () => {
    let state = inventory(
      initialState,
      update_item({ id: itemKey, item: testItem }),
    );

    const orderID = "shopify:123";
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    // Reconcile with current time
    state = inventory(
      state,
      shopify_order_reconciled({
        raw: {
          id: "123",
          updated_at: nowIso,
          line_items: [{ id: "li1", sku: itemKey, quantity: 3 }],
        },
        topic: "reconcile",
      }),
    );

    // Try to apply an older "created" fact (e.g. delayed webhook)
    const oldAction = shopify_order_created({
      raw: {
        id: "123",
        created_at: new Date(now - 10000).toISOString(),
        line_items: [{ id: "li1", sku: itemKey, quantity: 5 }],
      },
      topic: "orders/create",
    });
    // Attach older timestamp to the action as middleware would
    (oldAction as any).timestamp = { seconds: Math.floor((now - 5000) / 1000) };

    state = inventory(state, oldAction);

    expect(state.idToItem[itemKey].shipped).toBe(3); // Should NOT change to 5 or anything else
    expect(state.orderIdToOrder[orderID].items[0].qty).toBe(3);
  });
});
