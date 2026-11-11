import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  inventory,
  amazon_order_reconciled,
  package_item,
  cancel_order,
  type Item,
} from "$lib/inventory";
import { recoverAmazonOrderEvents } from "$lib/amazon-order-recovery";
import { canonicalizeInventoryItemKey } from "$lib/sku";
import { amazonOrderLabel } from "$lib/amazon-orders";
const require = createRequire(import.meta.url);
const {
  normalizeOrder,
  orderDocumentId,
  parseNotification,
  createWorker,
} = require("../../functions/shared/amazon-order-logic.cjs");
const sku = canonicalizeInventoryItemKey("4542804110050For You");
const config = {
  endpoint: "https://amazon.example",
  marketplaceId: "UK",
  sellerId: "SELLER",
  userAgent: "test",
  sqsQueueUrl: "queue",
};
function raw(status = "PENDING", time = "2026-11-11T14:39:00Z") {
  return {
    orderId: "203-8484700-7132328",
    createdTime: "2026-11-11T14:37:00Z",
    lastUpdatedTime: time,
    salesChannel: { marketplaceId: "UK" },
    fulfillment: { fulfillmentStatus: status, fulfilledBy: "MERCHANT" },
    orderItems: [
      {
        orderItemId: "line1",
        quantityOrdered: 2,
        product: { sellerSku: sku, title: "Gift tags" },
        fulfillment: { quantityFulfilled: 0 },
      },
    ],
  };
}
function initial() {
  const state = structuredClone(inventory(undefined, { type: "init" }));
  state.idToItem[sku] = {
    janCode: "4542804110050",
    subtype: "For You",
    description: "Tags",
    qty: 10,
    shipped: 0,
    pieces: 1,
    image: "",
    hsCode: "",
    creationDate: "",
    timestamp: 0,
  } as Item;
  state.keyIdentity = {
    intervalsByKey: {
      [sku]: [
        {
          key: sku as any,
          entityId: "test-entity" as any,
          validFromMs: 0,
          openedByActionType: "fixture",
        },
      ],
    },
    currentKeyByEntityId: { "test-entity": sku as any },
    entityIdByCurrentKey: { [sku]: "test-entity" as any },
  };
  return state;
}
function apply(state: any, r: any) {
  return inventory(state, {
    ...amazon_order_reconciled({
      order: normalizeOrder(r),
      source: "reconcile",
    }),
    timestamp: { seconds: 1794408000, nanoseconds: 0 },
    id: orderDocumentId(normalizeOrder(r), "SELLER"),
  });
}
describe("Amazon order inventory", () => {
  it("reserves pending stock once, becomes ready without a second sale, and reverses cancellation once", () => {
    let s = apply(initial(), raw());
    const id = "amazon:203-8484700-7132328";
    expect(s.idToItem[sku].shipped).toBe(2);
    expect(amazonOrderLabel(s.orderIdToOrder[id])).toContain("do not ship");
    const duplicate = apply(s, raw());
    expect(duplicate).toEqual(s);
    s = apply(s, raw("UNSHIPPED", "2026-11-11T15:00:00Z"));
    expect(s.idToItem[sku].shipped).toBe(2);
    expect(amazonOrderLabel(s.orderIdToOrder[id])).toBe("Ready to ship");
    s = apply(s, raw("CANCELLED", "2026-11-11T16:00:00Z"));
    expect(s.idToItem[sku].shipped).toBe(0);
    expect(s.orderIdToOrder[id].items).toEqual([]);
    expect(apply(s, raw())).toEqual(s); // stale notification cannot resurrect stock
    expect(apply(s, raw("CANCELLED", "2026-11-11T16:00:00Z"))).toEqual(s);
  });
  it("recovers events skipped by an old cached build without moving its event cursor", () => {
    let state = initial();
    const order = normalizeOrder(raw());
    const actions: any[] = [];
    const cachedStore = {
      dispatch: (action: any) => {
        actions.push(action);
        state = inventory(state, action) as typeof state;
      },
    };
    recoverAmazonOrderEvents(cachedStore, [
      {
        id: "earlier-event",
        timestamp: { seconds: 1794408000 },
        type: "amazon_order_reconciled",
        payload: { order, source: "reconcile" },
      },
    ]);
    expect(state.idToItem[sku].shipped).toBe(2);
    expect(state.amazonOrdersRecovered).toBe(true);
    expect(actions.every((a) => !a.id)).toBe(true);
    recoverAmazonOrderEvents(cachedStore, [
      {
        id: "earlier-event",
        type: "amazon_order_reconciled",
        payload: { order, source: "reconcile" },
      },
    ]);
    expect(state.idToItem[sku].shipped).toBe(2);
  });
  it("reports ambiguous/unknown SKUs without allocating a guessed variant", () => {
    const r: any = raw();
    r.orderItems[0].product.sellerSku = "4542804110050Unknown";
    const s = apply(initial(), r);
    expect(s.idToItem[sku].shipped).toBe(0);
    expect(s.orderIdToOrder["amazon:" + r.orderId].unmatchedLines).toHaveLength(
      1,
    );
  });
  it("retains stock when shipped, applies item cancellation, and doesn't treat a cancellation request as cancelled", () => {
    let r: any = raw("UNSHIPPED");
    r.orderItems[0].cancellation = {
      cancellationRequest: { requester: "BUYER" },
    };
    let s = apply(initial(), r);
    expect(s.idToItem[sku].shipped).toBe(2);
    expect(amazonOrderLabel(s.orderIdToOrder["amazon:" + r.orderId])).toContain(
      "Cancellation requested",
    );
    r = raw("SHIPPED", "2026-11-11T15:00:00Z");
    s = apply(s, r);
    expect(s.idToItem[sku].shipped).toBe(2);
    r = raw("PARTIALLY_SHIPPED", "2026-11-11T16:00:00Z");
    r.orderItems[0].cancellation = {
      cancellationExecution: { cancelledBy: "MERCHANT" },
    };
    s = apply(s, r);
    expect(s.idToItem[sku].shipped).toBe(0);
  });
  it("doesn't double deduct through the local packing screen or locally cancel an Amazon order", () => {
    const s = apply(initial(), raw("UNSHIPPED"));
    const orderID = "amazon:203-8484700-7132328";
    expect(
      inventory(s, package_item({ orderID, itemKey: sku as any, qty: 1 })),
    ).toEqual(s);
    expect(inventory(s, cancel_order({ orderID }))).toEqual(s);
  });
});
function notification(seller = "SELLER") {
  return JSON.stringify({
    NotificationType: "ORDER_CHANGE",
    Payload: {
      OrderChangeNotification: {
        SellerId: seller,
        AmazonOrderId: raw().orderId,
        Summary: { MarketplaceId: "UK" },
      },
    },
  });
}
function harness(responses: any[], failWrite = false) {
  let state: any = {};
  const events = new Map();
  const removed: string[] = [];
  const requests: string[] = [];
  const worker = createWorker({
    db: {
      runTransaction: async (fn: any) =>
        fn({
          get: async () => ({ data: () => state }),
          set: (_ref: any, v: any) => {
            state = { ...state, ...v };
          },
        }),
      collection: () => ({
        doc: () => ({
          get: async () => ({ data: () => state }),
          set: async (v: any) => {
            state = { ...state, ...v };
          },
        }),
      }),
    },
    getConfig: () => config,
    getToken: async () => "token",
    now: () => Date.parse("2026-11-11T18:00:00Z"),
    fetchImpl: async (url: string) => {
      requests.push(url);
      const data = responses.shift();
      return {
        ok: !data?.error,
        status: data?.error ? 403 : 200,
        json: async () => data,
      };
    },
    writeOnce: async (e: any) => {
      if (failWrite) throw Error("Firestore unavailable");
      const written = !events.has(e.documentId);
      events.set(e.documentId, e);
      return { written };
    },
    sqsFactory: () => ({
      receive: async () => [{ Body: notification(), ReceiptHandle: "receipt" }],
      remove: async (r: string) => {
        removed.push(r);
      },
    }),
  });
  return { worker, events, removed, requests, getState: () => state };
}
describe("Amazon order transport", () => {
  it("normalizes only operational facts, rejects incomplete snapshots, and scopes notifications", () => {
    const r: any = raw();
    r.buyer = { buyerName: "Private", buyerEmail: "private@example.com" };
    expect(JSON.stringify(normalizeOrder(r))).not.toContain("Private");
    expect(() => normalizeOrder({ ...r, orderItems: [] })).toThrow();
    expect(parseNotification(notification("OTHER"), config)).toBeNull();
    expect(parseNotification(notification(), config).orderId).toBe(r.orderId);
  });
  it("paginates, checkpoints only a complete import, and deduplicates identical snapshots", async () => {
    const h = harness([
      { orders: [raw()], pagination: { nextToken: "next" } },
      { orders: [raw()] },
    ]);
    expect(await h.worker.reconcile()).toEqual({ count: 1 });
    expect(h.events.size).toBe(1);
    expect(h.requests[1]).toContain("paginationToken=next");
    expect(h.getState().cursorMs).toBe(Date.parse("2026-11-11T17:58:00Z"));
  });
  it("doesn't advance the cursor after an API failure and makes the error visible", async () => {
    const h = harness([
      { error: true, errors: [{ code: "Forbidden", message: "Missing role" }] },
    ]);
    await expect(h.worker.reconcile()).rejects.toThrow("403");
    expect(h.getState().cursorMs).toBeUndefined();
    expect(h.getState().lastError).toContain("Missing role");
  });
  it("resumes a failed paginated reconciliation without losing its window", async () => {
    const h = harness([
      { orders: [raw()], pagination: { nextToken: "resume" } },
      { error: true, errors: [{ code: "Throttled", message: "retry" }] },
      { orders: [raw()] },
    ]);
    await expect(h.worker.reconcile()).rejects.toThrow();
    expect(h.getState().cursorMs).toBeUndefined();
    expect(h.getState().page.token).toBe("resume");
    await h.worker.reconcile();
    expect(h.requests[2]).toContain("paginationToken=resume");
    expect(h.events.size).toBe(1);
    expect(h.getState().lastError).toBe("");
  });
  it("acknowledges notification only after persisting canonical order state", async () => {
    const h = harness([{ order: raw("UNSHIPPED") }]);
    await h.worker.notifications();
    expect(h.removed).toEqual(["receipt"]);
    expect(h.events.size).toBe(1);
    const fail = harness([{ order: raw() }], true);
    await expect(fail.worker.notifications()).rejects.toThrow("Firestore");
    expect(fail.removed).toEqual([]);
    expect(fail.getState().notificationError).toContain("Firestore");
  });
});
