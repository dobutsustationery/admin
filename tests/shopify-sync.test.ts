import { describe, expect, it } from "vitest";
import { makeInventoryItemKey } from "$lib/sku";
import {
  initialState,
  inventory,
  shopify_order_placed,
  shopify_order_cancelled,
  shopify_order_refunded,
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

  it("handles shopify_order_placed and updates shipped quantity", () => {
    let state = inventory(
      initialState,
      update_item({ id: itemKey, item: testItem }),
    );

    const orderID = "shopify:123";
    const action = shopify_order_placed({
      orderID,
      date: new Date("2024-01-01T12:00:00Z"),
      email: "customer@example.com",
      lines: [{ itemKey, qty: 2, lineItemID: "li1" }],
    });

    state = inventory(state, action);

    expect(state.idToItem[itemKey].shipped).toBe(2);
    expect(state.orderIdToOrder[orderID].items).toEqual([{ itemKey, qty: 2 }]);
    expect(
      state.orderIdToOrder[orderID].shopifyFacts?.lines["li1"].placed,
    ).toBe(2);
  });

  it("handles shopify_order_placed idempotently", () => {
    let state = inventory(
      initialState,
      update_item({ id: itemKey, item: testItem }),
    );

    const orderID = "shopify:123";
    const action = shopify_order_placed({
      orderID,
      date: new Date("2024-01-01T12:00:00Z"),
      email: "customer@example.com",
      lines: [{ itemKey, qty: 2, lineItemID: "li1" }],
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
      shopify_order_placed({
        orderID,
        date: new Date("2024-01-01T12:00:00Z"),
        email: "customer@example.com",
        lines: [{ itemKey, qty: 2, lineItemID: "li1" }],
      }),
    );

    state = inventory(
      state,
      shopify_order_cancelled({
        orderID,
        lines: [{ itemKey, qty: 2, lineItemID: "li1" }],
      }),
    );

    expect(state.idToItem[itemKey].shipped).toBe(0);
    expect(state.orderIdToOrder[orderID].items).toEqual([]);
    expect(
      state.orderIdToOrder[orderID].shopifyFacts?.lines["li1"].cancelled,
    ).toBe(2);
  });

  it("handles shopify_order_refunded", () => {
    let state = inventory(
      initialState,
      update_item({ id: itemKey, item: testItem }),
    );

    const orderID = "shopify:123";
    state = inventory(
      state,
      shopify_order_placed({
        orderID,
        date: new Date("2024-01-01T12:00:00Z"),
        email: "customer@example.com",
        lines: [{ itemKey, qty: 5, lineItemID: "li1" }],
      }),
    );

    state = inventory(
      state,
      shopify_order_refunded({
        orderID,
        refundID: "ref1",
        lines: [{ itemKey, qty: 2, lineItemID: "li1" }],
      }),
    );

    expect(state.idToItem[itemKey].shipped).toBe(3);
    expect(state.orderIdToOrder[orderID].items).toEqual([{ itemKey, qty: 3 }]);
    expect(
      state.orderIdToOrder[orderID].shopifyFacts?.lines["li1"].refunded,
    ).toBe(2);
  });

  it("handles shopify_order_refunded idempotently using refundID", () => {
    let state = inventory(
      initialState,
      update_item({ id: itemKey, item: testItem }),
    );

    const orderID = "shopify:123";
    state = inventory(
      state,
      shopify_order_placed({
        orderID,
        date: new Date("2024-01-01T12:00:00Z"),
        email: "customer@example.com",
        lines: [{ itemKey, qty: 5, lineItemID: "li1" }],
      }),
    );

    const action = shopify_order_refunded({
      orderID,
      refundID: "ref1",
      lines: [{ itemKey, qty: 2, lineItemID: "li1" }],
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
      shopify_order_placed({
        orderID,
        date: new Date("2024-01-01T12:00:00Z"),
        email: "customer@example.com",
        lines: [{ itemKey, qty: 5, lineItemID: "li1" }],
      }),
    );

    // Reconcile says only 3 items now (e.g. some missed event)
    state = inventory(
      state,
      shopify_order_reconciled({
        orderID,
        timestamp: Date.now(),
        lines: [{ itemKey, currentQty: 3 }],
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

    // Reconcile with current time
    state = inventory(
      state,
      shopify_order_reconciled({
        orderID,
        timestamp: now,
        lines: [{ itemKey, currentQty: 3 }],
      }),
    );

    // Try to apply an older "placed" fact (e.g. delayed webhook)
    const oldAction = shopify_order_placed({
      orderID,
      date: new Date(now - 10000),
      email: "customer@example.com",
      lines: [{ itemKey, qty: 5, lineItemID: "li1" }],
    });
    // Attach older timestamp to the action as middleware would
    (oldAction as any).timestamp = { seconds: Math.floor((now - 5000) / 1000) };

    state = inventory(state, oldAction);

    expect(state.idToItem[itemKey].shipped).toBe(3); // Should NOT change to 5 or anything else
    expect(state.orderIdToOrder[orderID].items[0].qty).toBe(3);
  });
});
