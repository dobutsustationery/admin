// Amazon Orders API 2026-01-01. Persist only operational, non-PII order facts.
const { createHash, randomUUID } = require("node:crypto");
const statuses = new Set([
  "PENDING_AVAILABILITY",
  "PENDING",
  "UNSHIPPED",
  "PARTIALLY_SHIPPED",
  "SHIPPED",
  "CANCELLED",
  "UNFULFILLABLE",
]);
function normalizeOrder(raw) {
  const status = raw?.fulfillment?.fulfillmentStatus;
  if (
    !raw?.orderId ||
    !statuses.has(status) ||
    !Number.isFinite(Date.parse(raw.lastUpdatedTime)) ||
    !Number.isFinite(Date.parse(raw.createdTime))
  )
    throw Error("Incomplete Amazon order identity, status or timestamps");
  if (raw.fulfillment.fulfilledBy !== "MERCHANT") return null;
  if (!Array.isArray(raw.orderItems) || !raw.orderItems.length)
    throw Error(`Amazon order ${raw.orderId} has no complete item snapshot`);
  const lines = raw.orderItems
    .map((i) => {
      if (
        !i.orderItemId ||
        !Number.isInteger(i.quantityOrdered) ||
        i.quantityOrdered < 0
      )
        throw Error(`Invalid Amazon order item in ${raw.orderId}`);
      return {
        id: i.orderItemId,
        sku: i.product?.sellerSku || "",
        title: i.product?.title || "",
        quantity: i.quantityOrdered,
        quantityShipped: i.fulfillment?.quantityFulfilled || 0,
        quantityCancelled: i.cancellation?.cancellationExecution?.cancelledBy
          ? i.quantityOrdered
          : 0,
        buyerRequestedCancel:
          i.cancellation?.cancellationRequest?.requester === "BUYER" &&
          !i.cancellation?.cancellationExecution,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(lines.map((l) => l.id)).size !== lines.length)
    throw Error("Duplicate Amazon order item IDs");
  return {
    orderId: raw.orderId,
    marketplaceId: raw.salesChannel?.marketplaceId || "",
    purchaseDate: raw.createdTime,
    lastUpdatedDate: raw.lastUpdatedTime,
    status,
    latestShipDate: raw.fulfillment.shipByWindow?.latestDateTime || "",
    lines,
  };
}
function orderDocumentId(order, sellerId) {
  return (
    "amazon-order-" +
    createHash("sha256")
      .update(JSON.stringify([sellerId, order]))
      .digest("hex")
  );
}
function parseNotification(body, config) {
  const message = JSON.parse(body);
  if (message.NotificationType !== "ORDER_CHANGE")
    throw Error("Expected ORDER_CHANGE notification");
  const order = message.Payload?.OrderChangeNotification;
  if (
    order?.SellerId !== config.sellerId ||
    order?.Summary?.MarketplaceId !== config.marketplaceId
  )
    return null;
  if (!/^\d{3}-\d{7}-\d{7}$/.test(order.AmazonOrderId || ""))
    throw Error("Invalid Amazon order ID");
  return {
    orderId: order.AmazonOrderId,
    notificationId: message.NotificationMetadata?.NotificationId || "",
    changeType: order.OrderChangeType || "",
  };
}
function createWorker({
  db,
  getConfig,
  getToken,
  writeOnce,
  now = Date.now,
  fetchImpl = fetch,
  sqsFactory,
}) {
  const stateRef = db.collection("amazon_order_sync_state").doc("default");
  async function api(config, token, path, params) {
    const response = await fetchImpl(
      config.endpoint + path + "?" + new URLSearchParams(params),
      {
        headers: {
          "x-amz-access-token": token,
          "user-agent": config.userAgent,
        },
        signal: AbortSignal.timeout(30000),
      },
    );
    const data = await response.json();
    if (!response.ok)
      throw Error(
        `Amazon orders API HTTP ${response.status}: ${(data.errors || []).map((e) => e.code + ": " + e.message).join("; ")}`,
      );
    return data;
  }
  async function persist(raw, config, source, notification = null) {
    const order = normalizeOrder(raw);
    if (!order || order.marketplaceId !== config.marketplaceId) return false;
    const result = await writeOnce({
      action: {
        type: "amazon_order_reconciled",
        payload: { order, source, ...(notification ? { notification } : {}) },
      },
      creator: "amazon-orders-worker",
      documentId: orderDocumentId(order, config.sellerId),
    });
    return result.written;
  }
  async function reconcile() {
    const config = getConfig();
    const start = now();
    const lease = randomUUID();
    const state = await db.runTransaction(async (tx) => {
      const current = (await tx.get(stateRef)).data() || {};
      if (current.leaseUntilMs > start) return null;
      tx.set(
        stateRef,
        { lease, leaseUntilMs: start + 360000 },
        { merge: true },
      );
      return current;
    });
    if (!state) return { busy: true, count: 0 };
    // Fix the upper bound before fetching; overlap catches late visibility and inclusive boundaries.
    const resume =
      state.page && start - state.page.startedAtMs < 23 * 3600000
        ? state.page
        : null;
    const until = resume?.until || start - 120000;
    const since =
      resume?.since ??
      Math.max(0, (state.cursorMs || start - 7 * 86400000) - 300000);
    let paginationToken = resume?.token || "",
      count = 0,
      pages = 0;
    try {
      const token = await getToken(config);
      do {
        const result = await api(config, token, "/orders/2026-01-01/orders", {
          marketplaceIds: config.marketplaceId,
          fulfilledBy: "MERCHANT",
          includedData: "FULFILLMENT,CANCELLATION",
          lastUpdatedAfter: new Date(since).toISOString(),
          lastUpdatedBefore: new Date(until).toISOString(),
          ...(paginationToken ? { paginationToken } : {}),
        });
        if (!Array.isArray(result.orders))
          throw Error("Amazon searchOrders returned no orders array");
        for (const raw of result.orders)
          if (await persist(raw, config, "reconcile")) count++;
        paginationToken =
          result.pagination?.nextToken || result.nextToken || "";
        await stateRef.set(
          {
            page: paginationToken
              ? {
                  token: paginationToken,
                  since,
                  until,
                  startedAtMs: resume?.startedAtMs || start,
                }
              : null,
          },
          { merge: true },
        );
        if (++pages >= 50 && paginationToken)
          throw Error(
            "Amazon order pagination exceeded 50 pages; cursor retained",
          );
      } while (paginationToken);
      await stateRef.set(
        {
          cursorMs: until,
          lastSuccessAtMs: now(),
          lastError: "",
          importedCount: count,
        },
        { merge: true },
      );
      return { count };
    } catch (error) {
      await stateRef.set(
        { lastError: error.message, lastErrorAtMs: now() },
        { merge: true },
      );
      throw error;
    } finally {
      await db.runTransaction(async (tx) => {
        if ((await tx.get(stateRef)).data()?.lease === lease)
          tx.set(stateRef, { leaseUntilMs: 0 }, { merge: true });
      });
    }
  }
  async function notifications() {
    const config = getConfig();
    if (!config.sqsQueueUrl) {
      await stateRef.set({ notificationsConfigured: false }, { merge: true });
      return;
    }
    try {
      const sqs = sqsFactory(config);
      const token = await getToken(config);
      const messages = await sqs.receive();
      for (const message of messages) {
        const notification = parseNotification(message.Body, config);
        if (notification) {
          const result = await api(
            config,
            token,
            "/orders/2026-01-01/orders/" +
              encodeURIComponent(notification.orderId),
            { includedData: "FULFILLMENT,CANCELLATION" },
          );
          // Fetch canonical state: notifications may omit items or arrive out of order.
          await persist(result.order, config, "notification", notification);
        }
        // Acknowledge only after the immutable order event is safely stored (or duplicate).
        await sqs.remove(message.ReceiptHandle);
      }
      await stateRef.set(
        {
          notificationsConfigured: true,
          lastNotificationPollAtMs: now(),
          notificationError: "",
        },
        { merge: true },
      );
    } catch (error) {
      await stateRef.set(
        { notificationError: error.message, notificationErrorAtMs: now() },
        { merge: true },
      );
      throw error;
    }
  }
  return { reconcile, notifications };
}
module.exports = {
  normalizeOrder,
  orderDocumentId,
  parseNotification,
  createWorker,
};
