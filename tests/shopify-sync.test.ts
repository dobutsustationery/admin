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
  rename_subtype,
  retype_item,
  update_item,
  type Item,
} from "$lib/inventory";

describe("Shopify Sync Reducer", () => {
  const withBroadcastMeta = <T extends { type: string }>(
    action: T,
    id: string,
    ms: number,
  ): T & { id: string; timestamp: { seconds: number; nanoseconds: number } } =>
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
      withBroadcastMeta(
        update_item({ id: itemKey, item: testItem }),
        "test-item",
        1000,
      ),
    );

    const orderID = "shopify:123";
    const action = withBroadcastMeta(
      shopify_order_created({
        raw: {
          id: "123",
          created_at: "2024-01-01T12:00:00Z",
          email: "customer@example.com",
          line_items: [{ id: "li1", sku: itemKey, quantity: 2 }],
        },
        topic: "orders/create",
      }),
      "order-123",
      2000,
    );

    state = inventory(state, action);

    expect(state.idToItem[itemKey].shipped).toBe(2);
    expect(state.orderIdToOrder[orderID].items).toEqual([{ itemKey, qty: 2 }]);
    expect(
      state.orderIdToOrder[orderID].shopifyFacts?.lines["li1"].placed,
    ).toBe(2);
  });

  it("maps Shopify Default-suffixed SKUs to the base JAN item", () => {
    const baseItem: Item = {
      ...testItem,
      janCode: "4542804154658",
      subtype: "",
    };
    const baseItemKey = makeInventoryItemKey(
      baseItem.janCode,
      baseItem.subtype,
    );
    let state = inventory(
      initialState,
      withBroadcastMeta(
        update_item({ id: baseItemKey, item: baseItem }),
        "base-item",
        1000,
      ),
    );

    const action = withBroadcastMeta(
      shopify_order_created({
        raw: {
          id: "default-sku-order",
          created_at: "2024-01-01T12:00:00Z",
          email: "customer@example.com",
          line_items: [
            { id: "li-default", sku: "4542804154658Default", quantity: 1 },
          ],
        },
        topic: "orders/create",
      }),
      "order-default",
      2000,
    );

    state = inventory(state, action);

    expect(state.idToItem[baseItemKey].shipped).toBe(1);
    expect(state.orderIdToOrder["shopify:default-sku-order"].items).toEqual([
      { itemKey: baseItemKey, qty: 1 },
    ]);
  });

  it("normalizes historical Default-suffixed update_item ids on replay", () => {
    const janCode = "4542804154658";
    const state = inventory(
      initialState,
      update_item({
        id: `${janCode}Default`,
        item: {
          ...testItem,
          janCode,
          subtype: "Default",
        },
      }),
    );

    expect(state.idToItem[janCode]).toBeDefined();
    expect(state.idToItem[janCode].subtype).toBe("");
    expect(state.idToItem[`${janCode}Default`]).toBeUndefined();
  });

  it("handles shopify_order_created idempotently", () => {
    let state = inventory(
      initialState,
      withBroadcastMeta(
        update_item({ id: itemKey, item: testItem }),
        "test-item",
        1000,
      ),
    );

    const orderID = "shopify:123";
    const action = withBroadcastMeta(
      shopify_order_created({
        raw: {
          id: "123",
          created_at: "2024-01-01T12:00:00Z",
          email: "customer@example.com",
          line_items: [{ id: "li1", sku: itemKey, quantity: 2 }],
        },
        topic: "orders/create",
      }),
      "order-123",
      2000,
    );

    state = inventory(state, action);
    state = inventory(state, action); // Repeat same action

    expect(state.idToItem[itemKey].shipped).toBe(2); // Should not be 4
    expect(state.orderIdToOrder[orderID].items[0].qty).toBe(2);
  });

  it("handles shopify_order_cancelled", () => {
    let state = inventory(
      initialState,
      withBroadcastMeta(
        update_item({ id: itemKey, item: testItem }),
        "test-item",
        1000,
      ),
    );

    const orderID = "shopify:123";
    state = inventory(
      state,
      withBroadcastMeta(
        shopify_order_created({
          raw: {
            id: "123",
            created_at: "2024-01-01T12:00:00Z",
            email: "customer@example.com",
            line_items: [{ id: "li1", sku: itemKey, quantity: 2 }],
          },
          topic: "orders/create",
        }),
        "order-123",
        2000,
      ),
    );

    state = inventory(
      state,
      withBroadcastMeta(
        shopify_order_cancelled({
          raw: {
            id: "123",
            cancelled_at: "2024-01-01T13:00:00Z",
            line_items: [{ id: "li1", sku: itemKey, quantity: 2 }],
          },
          topic: "orders/cancelled",
        }),
        "cancel-123",
        3000,
      ),
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
      withBroadcastMeta(
        update_item({ id: itemKey, item: testItem }),
        "test-item",
        1000,
      ),
    );

    const orderID = "shopify:123";
    state = inventory(
      state,
      withBroadcastMeta(
        shopify_order_created({
          raw: {
            id: "123",
            created_at: "2024-01-01T12:00:00Z",
            email: "customer@example.com",
            line_items: [{ id: "li1", sku: itemKey, quantity: 5 }],
          },
          topic: "orders/create",
        }),
        "order-123",
        2000,
      ),
    );

    state = inventory(
      state,
      withBroadcastMeta(
        shopify_refund_created({
          raw: {
            id: "ref1",
            order_id: "123",
            refund_line_items: [{ line_item_id: "li1", quantity: 2 }],
          },
          topic: "refunds/create",
        }),
        "refund-1",
        3000,
      ),
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
      withBroadcastMeta(
        update_item({ id: itemKey, item: testItem }),
        "test-item",
        1000,
      ),
    );

    const orderID = "shopify:123";
    state = inventory(
      state,
      withBroadcastMeta(
        shopify_order_created({
          raw: {
            id: "123",
            created_at: "2024-01-01T12:00:00Z",
            email: "customer@example.com",
            line_items: [{ id: "li1", sku: itemKey, quantity: 5 }],
          },
          topic: "orders/create",
        }),
        "order-123",
        2000,
      ),
    );

    const action = withBroadcastMeta(
      shopify_refund_created({
        raw: {
          id: "ref1",
          order_id: "123",
          refund_line_items: [{ line_item_id: "li1", quantity: 2 }],
        },
        topic: "refunds/create",
      }),
      "refund-1",
      3000,
    );

    state = inventory(state, action);
    state = inventory(state, action); // Repeat same refund

    expect(state.idToItem[itemKey].shipped).toBe(3); // Should not be 1
  });

  it("handles shopify_order_reconciled as ground truth", () => {
    let state = inventory(
      initialState,
      withBroadcastMeta(
        update_item({ id: itemKey, item: testItem }),
        "test-item",
        1000,
      ),
    );

    const orderID = "shopify:123";
    // Initially placed 5
    state = inventory(
      state,
      withBroadcastMeta(
        shopify_order_created({
          raw: {
            id: "123",
            created_at: "2024-01-01T12:00:00Z",
            email: "customer@example.com",
            line_items: [{ id: "li1", sku: itemKey, quantity: 5 }],
          },
          topic: "orders/create",
        }),
        "order-123",
        2000,
      ),
    );

    // Reconcile says only 3 items now (e.g. some missed event)
    state = inventory(
      state,
      withBroadcastMeta(
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
        "reconcile-123",
        3000,
      ),
    );

    expect(state.idToItem[itemKey].shipped).toBe(3);
    expect(state.orderIdToOrder[orderID].items).toEqual([{ itemKey, qty: 3 }]);
  });

  it("handles shopify_order_updated as reconciliation", () => {
    let state = inventory(
      initialState,
      withBroadcastMeta(
        update_item({ id: itemKey, item: testItem }),
        "test-item",
        1000,
      ),
    );

    const orderID = "shopify:123";
    // Initially placed 5
    state = inventory(
      state,
      withBroadcastMeta(
        shopify_order_created({
          raw: {
            id: "123",
            created_at: "2024-01-01T12:00:00Z",
            email: "customer@example.com",
            line_items: [{ id: "li1", sku: itemKey, quantity: 5 }],
          },
          topic: "orders/create",
        }),
        "order-123",
        2000,
      ),
    );

    // Update says only 3 items now
    state = inventory(
      state,
      withBroadcastMeta(
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
        "update-123",
        3000,
      ),
    );

    expect(state.idToItem[itemKey].shipped).toBe(3);
    expect(state.orderIdToOrder[orderID].items).toEqual([{ itemKey, qty: 3 }]);
  });

  it("reconciles an old Shopify SKU to the current inventory key after subtype retyping", () => {
    const janCode = "4901681382316";
    const originalKey = makeInventoryItemKey(janCode, "");
    const currentKey = makeInventoryItemKey(janCode, "Standard");
    const t0 = Date.parse("2024-01-01T00:00:00Z");
    const t10 = Date.parse("2024-01-01T00:00:10Z");
    const t30 = Date.parse("2024-01-01T00:00:30Z");

    let state = inventory(
      initialState,
      withBroadcastMeta(
        update_item({
          id: originalKey,
          item: {
            ...testItem,
            janCode,
            subtype: "",
            shipped: 0,
          },
        }),
        "create-original",
        t0,
      ),
    );

    state = inventory(
      state,
      withBroadcastMeta(
        rename_subtype({ itemKey: originalKey, subtype: "Standard" }),
        "rename-standard",
        t10,
      ),
    );

    state = inventory(
      state,
      withBroadcastMeta(
        shopify_order_reconciled({
          raw: {
            id: "late-reconcile",
            created_at: "2024-01-01T00:00:05Z",
            updated_at: "2024-01-01T00:00:30Z",
            line_items: [{ id: "li-old", sku: originalKey, quantity: 2 }],
          },
          topic: "reconcile",
        }),
        "reconcile-old-order",
        t30,
      ),
    );

    expect(state.idToItem[originalKey]).toBeUndefined();
    expect(state.idToItem[currentKey].shipped).toBe(2);
    expect(
      state.keyIdentity?.currentKeyByEntityId[`create-original:${originalKey}`],
    ).toBe(currentKey);
    expect(state.orderIdToOrder["shopify:late-reconcile"].items).toEqual([
      { itemKey: currentKey, qty: 2 },
    ]);
    expect(
      state.orderIdToOrder["shopify:late-reconcile"].shopifyFacts?.lines[
        "li-old"
      ].itemKey,
    ).toBe(currentKey);
    expect(
      state.orderIdToOrder["shopify:late-reconcile"].shopifyFacts?.lines[
        "li-old"
      ].entityId,
    ).toBe(`create-original:${originalKey}`);
    expect(state.shopifyExceptions?.["shopify:late-reconcile"]).toBeUndefined();
  });

  it("resolves chained renames and key reuse using the order's historical time", () => {
    const janCode = "CHAINED-RENAME";
    const keyA = makeInventoryItemKey(janCode, "");
    const keyB = makeInventoryItemKey(janCode, "B");
    const keyC = makeInventoryItemKey(janCode, "C");
    const t0 = Date.parse("2024-02-01T00:00:00Z");
    const t10 = Date.parse("2024-02-01T00:00:10Z");
    const t20 = Date.parse("2024-02-01T00:00:20Z");
    const t30 = Date.parse("2024-02-01T00:00:30Z");
    const t40 = Date.parse("2024-02-01T00:00:40Z");

    let state = inventory(
      initialState,
      withBroadcastMeta(
        update_item({
          id: keyA,
          item: { ...testItem, janCode, subtype: "", shipped: 0 },
        }),
        "create-a",
        t0,
      ),
    );
    state = inventory(
      state,
      withBroadcastMeta(
        rename_subtype({ itemKey: keyA, subtype: "B" }),
        "a-b",
        t10,
      ),
    );
    state = inventory(
      state,
      withBroadcastMeta(
        rename_subtype({ itemKey: keyB, subtype: "C" }),
        "b-c",
        t20,
      ),
    );
    state = inventory(
      state,
      withBroadcastMeta(
        update_item({
          id: keyA,
          item: {
            ...testItem,
            janCode,
            subtype: "",
            description: "Reused A",
            shipped: 0,
          },
        }),
        "reuse-a",
        t30,
      ),
    );

    state = inventory(
      state,
      withBroadcastMeta(
        shopify_order_reconciled({
          raw: {
            id: "before-rename",
            created_at: "2024-02-01T00:00:05Z",
            updated_at: "2024-02-01T00:00:40Z",
            line_items: [{ id: "li-before", sku: keyA, quantity: 1 }],
          },
          topic: "reconcile",
        }),
        "reconcile-before",
        t40,
      ),
    );
    state = inventory(
      state,
      withBroadcastMeta(
        shopify_order_reconciled({
          raw: {
            id: "after-reuse",
            created_at: "2024-02-01T00:00:35Z",
            updated_at: "2024-02-01T00:00:41Z",
            line_items: [{ id: "li-after", sku: keyA, quantity: 3 }],
          },
          topic: "reconcile",
        }),
        "reconcile-after",
        t40 + 1000,
      ),
    );

    expect(state.idToItem[keyC].shipped).toBe(1);
    expect(state.idToItem[keyA].shipped).toBe(3);
    expect(state.orderIdToOrder["shopify:before-rename"].items).toEqual([
      { itemKey: keyC, qty: 1 },
    ]);
    expect(state.orderIdToOrder["shopify:after-reuse"].items).toEqual([
      { itemKey: keyA, qty: 3 },
    ]);
  });

  it("ignores actions older than reconciliation", () => {
    let state = inventory(
      initialState,
      withBroadcastMeta(
        update_item({ id: itemKey, item: testItem }),
        "test-item",
        1000,
      ),
    );

    const orderID = "shopify:123";
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    // Reconcile with current time
    state = inventory(
      state,
      withBroadcastMeta(
        shopify_order_reconciled({
          raw: {
            id: "123",
            updated_at: nowIso,
            line_items: [{ id: "li1", sku: itemKey, quantity: 3 }],
          },
          topic: "reconcile",
        }),
        "reconcile-123",
        now,
      ),
    );

    // Try to apply an older "created" fact (e.g. delayed webhook)
    const oldAction = withBroadcastMeta(
      shopify_order_created({
        raw: {
          id: "123",
          created_at: new Date(now - 10000).toISOString(),
          line_items: [{ id: "li1", sku: itemKey, quantity: 5 }],
        },
        topic: "orders/create",
      }),
      "order-123-delayed",
      now - 5000,
    );

    state = inventory(state, oldAction);

    expect(state.idToItem[itemKey].shipped).toBe(3); // Should NOT change to 5 or anything else
    expect(state.orderIdToOrder[orderID].items[0].qty).toBe(3);
  });

  it("preserves retype_item correction across later shopify reconciliation", () => {
    const keyA = makeInventoryItemKey("JAN1", "");
    const keyB = makeInventoryItemKey("JAN2", "");
    const t0 = Date.parse("2024-03-01T00:00:00Z");
    const t10 = Date.parse("2024-03-01T00:00:10Z");
    const t20 = Date.parse("2024-03-01T00:00:20Z");
    const t30 = Date.parse("2024-03-01T00:00:30Z");

    let state = inventory(
      initialState,
      withBroadcastMeta(
        update_item({
          id: keyA,
          item: { ...testItem, janCode: "JAN1", subtype: "" },
        }),
        "create-a",
        t0,
      ),
    );
    state = inventory(
      state,
      withBroadcastMeta(
        update_item({
          id: keyB,
          item: { ...testItem, janCode: "JAN2", subtype: "" },
        }),
        "create-b",
        t0,
      ),
    );

    const orderID = "shopify:order1";
    state = inventory(
      state,
      withBroadcastMeta(
        shopify_order_created({
          raw: {
            id: "order1",
            created_at: "2024-03-01T00:00:05Z",
            line_items: [{ id: "li1", sku: "JAN1", quantity: 1 }],
          },
          topic: "orders/create",
        }),
        "shopify-create",
        t10,
      ),
    );

    expect(state.idToItem[keyA].shipped).toBe(1);
    expect(state.idToItem[keyB].shipped).toBe(0);

    // Now retype the order to JAN2
    state = inventory(
      state,
      withBroadcastMeta(
        retype_item({
          orderID,
          itemKey: keyA,
          janCode: "JAN2",
          subtype: "",
          qty: 1,
        }),
        "retype-to-b",
        t20,
      ),
    );

    expect(state.idToItem[keyA].shipped).toBe(0);
    expect(state.idToItem[keyB].shipped).toBe(1);
    expect(state.orderIdToOrder[orderID].items).toEqual([
      { itemKey: keyB, qty: 1 },
    ]);

    // Now reconcile with Shopify payload which STILL says JAN1
    state = inventory(
      state,
      withBroadcastMeta(
        shopify_order_reconciled({
          raw: {
            id: "order1",
            created_at: "2024-03-01T00:00:05Z",
            updated_at: "2024-03-01T00:00:25Z",
            line_items: [{ id: "li1", sku: "JAN1", quantity: 1 }],
          },
          topic: "reconcile",
        }),
        "shopify-reconcile",
        t30,
      ),
    );

    expect(state.idToItem[keyA].shipped).toBe(0);
    expect(state.idToItem[keyB].shipped).toBe(1);
    expect(state.orderIdToOrder[orderID].items).toEqual([
      { itemKey: keyB, qty: 1 },
    ]);
  });

  it("records an exception and does not mutate shipped counts if no historical binding interval exists", () => {
    const keyA = makeInventoryItemKey("JAN-FALLBACK", "");
    const t10 = Date.parse("2024-04-01T00:00:10Z");

    let state = inventory(
      initialState,
      withBroadcastMeta(
        update_item({
          id: keyA,
          item: { ...testItem, janCode: "JAN-FALLBACK", subtype: "" },
        }),
        "create-a",
        t10, // Created at t10
      ),
    );

    // Order created at t0 (BEFORE item was created in system)
    state = inventory(
      state,
      withBroadcastMeta(
        shopify_order_created({
          raw: {
            id: "order-early",
            created_at: "2024-04-01T00:00:00Z",
            line_items: [{ id: "li1", sku: "JAN-FALLBACK", quantity: 1 }],
          },
          topic: "orders/create",
        }),
        "shopify-create",
        t10 + 1000,
      ),
    );

    // Should NOT resolve to keyA because no interval existed at t0
    expect(state.idToItem[keyA].shipped).toBe(0);
    expect(state.shopifyExceptions?.["shopify:order-early"]).toBeDefined();
    expect(state.shopifyExceptions?.["shopify:order-early"][0]).toContain(
      "Missing historical binding",
    );
  });

  it("applies refund to the correct current key after a rename", () => {
    const keyA = makeInventoryItemKey("JAN-REFUND", "");
    const keyB = makeInventoryItemKey("JAN-REFUND", "Renamed");
    const t0 = Date.parse("2024-05-01T00:00:00Z");
    const t10 = Date.parse("2024-05-01T00:00:10Z");
    const t20 = Date.parse("2024-05-01T00:00:20Z");
    const t30 = Date.parse("2024-05-01T00:00:30Z");

    let state = inventory(
      initialState,
      withBroadcastMeta(
        update_item({
          id: keyA,
          item: { ...testItem, janCode: "JAN-REFUND", subtype: "" },
        }),
        "create-a",
        t0,
      ),
    );

    const orderID = "shopify:order-refund";
    state = inventory(
      state,
      withBroadcastMeta(
        shopify_order_created({
          raw: {
            id: "order-refund",
            created_at: "2024-05-01T00:00:05Z",
            line_items: [{ id: "li1", sku: "JAN-REFUND", quantity: 5 }],
          },
          topic: "orders/create",
        }),
        "shopify-create",
        t10,
      ),
    );

    expect(state.idToItem[keyA].shipped).toBe(5);

    // Rename A -> B
    state = inventory(
      state,
      withBroadcastMeta(
        rename_subtype({ itemKey: keyA, subtype: "Renamed" }),
        "rename-a-b",
        t20,
      ),
    );

    expect(state.idToItem[keyA]).toBeUndefined();
    expect(state.idToItem[keyB].shipped).toBe(5);

    // Refund 2 items
    state = inventory(
      state,
      withBroadcastMeta(
        shopify_refund_created({
          raw: {
            id: "refund1",
            order_id: "order-refund",
            created_at: "2024-05-01T00:00:25Z",
            refund_line_items: [{ line_item_id: "li1", quantity: 2 }],
          },
          topic: "refunds/create",
        }),
        "shopify-refund",
        t30,
      ),
    );

    // Net shipped should be 5 - 2 = 3 on keyB
    expect(state.idToItem[keyB].shipped).toBe(3);
  });

  it("guards against pending writes with atMs=0", () => {
    const keyA = makeInventoryItemKey("JAN-PENDING", "");
    const t10 = Date.parse("2024-06-01T00:00:10Z");

    // Simulate pending write with timestamp: null -> getTimestampMs returns 0
    let state = inventory(initialState, {
      ...update_item({
        id: keyA,
        item: { ...testItem, janCode: "JAN-PENDING", subtype: "" },
      }),
      id: "pending-create",
      timestamp: null,
    } as any);

    // Identity state should be empty because we guarded against atMs=0
    expect(state.keyIdentity?.intervalsByKey[keyA]).toBeUndefined();

    // Now simulate confirmation with real timestamp
    state = inventory(
      state,
      withBroadcastMeta(
        update_item({
          id: keyA,
          item: { ...testItem, janCode: "JAN-PENDING", subtype: "" },
        }),
        "pending-create",
        t10,
      ),
    );

    // Now it should be there
    expect(state.keyIdentity?.intervalsByKey[keyA]).toBeDefined();
    expect(state.keyIdentity?.intervalsByKey[keyA]![0].validFromMs).toBe(t10);
  });

  it("does not mutate shipped count for previously resolved lines if they later fail resolution (§3.1)", () => {
    const keyA = makeInventoryItemKey("JAN-A", "");
    const keyB = makeInventoryItemKey("JAN-B", "");
    const t10 = Date.parse("2024-01-01T00:00:10Z");
    const t20 = Date.parse("2024-01-01T00:00:20Z");

    let state = inventory(
      initialState,
      withBroadcastMeta(
        update_item({
          id: keyA,
          item: { ...testItem, janCode: "JAN-A", subtype: "" },
        }),
        "create-a",
        t10,
      ),
    );

    state = inventory(
      state,
      withBroadcastMeta(
        update_item({
          id: keyB,
          item: { ...testItem, janCode: "JAN-B", subtype: "" },
        }),
        "create-b",
        t20,
      ),
    );

    const orderID = "shopify:123";
    // 1. Initial reconciliation at t30 (both items exist)
    state = inventory(
      state,
      withBroadcastMeta(
        shopify_order_reconciled({
          raw: {
            id: "123",
            updated_at: "2024-01-01T00:00:30Z",
            line_items: [
              { id: "li1", sku: "JAN-A", quantity: 1 },
              { id: "li2", sku: "JAN-B", quantity: 1 },
            ],
          },
          topic: "reconcile",
        }),
        "reconcile-1",
        t20 + 10000,
      ),
    );

    expect(state.idToItem[keyA].shipped).toBe(1);
    expect(state.idToItem[keyB].shipped).toBe(1);

    // 2. Second reconciliation but with a very early effectiveAtMs (t0)
    // At t0, NEITHER JAN-A nor JAN-B had bindings.
    // The design says missing bindings should NOT mutate shipped counts.
    // If we have a bug, the "impact reset" logic will see 1 item for keyA and 1 for keyB
    // in order.items, and subtract them because they aren't in the new payload's itemQtyMap.
    state = inventory(
      state,
      withBroadcastMeta(
        shopify_order_reconciled({
          raw: {
            id: "123",
            // Simulating an action that forces an early effectiveAtMs (e.g. by using an old created_at)
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-01T00:00:40Z",
            line_items: [
              { id: "li1", sku: "JAN-A", quantity: 1 },
              { id: "li2", sku: "JAN-B", quantity: 1 },
            ],
          },
          topic: "reconcile",
        }),
        "reconcile-2",
        t20 + 20000,
      ),
    );

    // If bug 3.1 exists, these will be 0
    expect(state.idToItem[keyA].shipped).toBe(1);
    expect(state.idToItem[keyB].shipped).toBe(1);
    expect(state.shopifyExceptions?.[orderID]).toHaveLength(2);
  });

  it("handles retype_item pending -> confirmed lifecycle (§3.3)", () => {
    const keyA = makeInventoryItemKey("JAN-A", "");
    const keyB = makeInventoryItemKey("JAN-B", ""); // Already created
    const keyC = makeInventoryItemKey("JAN-C", ""); // BRAND NEW
    const t10 = Date.parse("2024-01-01T00:00:10Z");

    let state = inventory(
      initialState,
      withBroadcastMeta(
        update_item({
          id: keyA,
          item: { ...testItem, janCode: "JAN-A", subtype: "" },
        }),
        "create-a",
        t10,
      ),
    );

    const orderID = "shopify:123";
    state = inventory(
      state,
      withBroadcastMeta(
        shopify_order_created({
          raw: {
            id: "123",
            created_at: "2024-01-01T00:00:15Z",
            line_items: [{ id: "li1", sku: "JAN-A", quantity: 1 }],
          },
          topic: "orders/create",
        }),
        "order-1",
        t10 + 2000,
      ),
    );

    expect(state.idToItem[keyA].shipped).toBe(1);

    // 1. Pending retype to JAN-C (timestamp null -> atMs=0)
    state = inventory(state, {
      ...retype_item({
        orderID,
        itemKey: keyA,
        janCode: "JAN-C",
        subtype: "",
        qty: 1,
      }),
      id: "retype-1",
      timestamp: null,
    } as any);

    // Identity for JAN-C won't be created at atMs=0
    expect(state.keyIdentity?.intervalsByKey[keyC]).toBeUndefined();
    // manualEntityId will NOT be set on the fact because bind returned undefined
    expect(
      state.orderIdToOrder[orderID].shopifyFacts?.lines["li1"].manualEntityId,
    ).toBeUndefined();

    // 2. Confirmed retype
    // We must ensure JAN-C exists now for retype to work
    state = inventory(
      state,
      withBroadcastMeta(
        update_item({
          id: keyC,
          item: { ...testItem, janCode: "JAN-C", subtype: "" },
        }),
        "create-c",
        t10 + 2500,
      ),
    );

    state = inventory(
      state,
      withBroadcastMeta(
        retype_item({
          orderID,
          itemKey: keyA,
          janCode: "JAN-C",
          subtype: "",
          qty: 1,
        }),
        "retype-1",
        t10 + 3000,
      ),
    );

    // Now entity ID should be there
    expect(
      state.orderIdToOrder[orderID].shopifyFacts?.lines["li1"].manualEntityId,
    ).toBeDefined();
    expect(state.idToItem[keyC].shipped).toBe(1);
    expect(state.idToItem[keyA].shipped).toBe(0);
  });

  it("updates stored line facts when an item is renamed (§3.5)", () => {
    const janA = "1111111111111";
    const keyA = makeInventoryItemKey(janA, "");
    const t10 = Date.parse("2024-01-01T00:00:10Z");

    let state = inventory(
      initialState,
      withBroadcastMeta(
        update_item({
          id: keyA,
          item: { ...testItem, janCode: janA, subtype: "" },
        }),
        "create-a",
        t10,
      ),
    );

    const orderID = "shopify:123";
    state = inventory(
      state,
      withBroadcastMeta(
        shopify_order_created({
          raw: {
            id: "123",
            created_at: "2024-01-01T00:00:15Z",
            line_items: [{ id: "li1", sku: janA, quantity: 1 }],
          },
          topic: "orders/create",
        }),
        "order-1",
        t10 + 2000,
      ),
    );

    expect(
      state.orderIdToOrder[orderID].shopifyFacts?.lines["li1"].itemKey,
    ).toBe(keyA);
    expect(state.idToItem[keyA].shipped).toBe(1);

    // Now rename janA (Default) to janA (Renamed)
    state = inventory(
      state,
      withBroadcastMeta(
        rename_subtype({
          itemKey: keyA,
          subtype: "Renamed",
        }),
        "rename-a-to-b",
        t10 + 3000,
      ),
    );

    const keyARenamed = makeInventoryItemKey(janA, "Renamed");
    expect(
      state.orderIdToOrder[orderID].shopifyFacts?.lines["li1"].itemKey,
    ).toBe(keyARenamed);
    expect(state.idToItem[keyARenamed].shipped).toBe(1);
    expect(state.idToItem[keyA]).toBeUndefined();
  });
});
