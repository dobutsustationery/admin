const crypto = require("crypto");

/**
 * Verifies the HMAC signature of a Shopify webhook request.
 */
function verifyShopifyHmac(rawBody, hmacHeader, secret) {
  if (!hmacHeader || !secret) return false;
  const hash = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");
  return hash === hmacHeader;
}

/**
 * Maps a Shopify SKU to a local InventoryItemKey.
 * Fallback to JAN code in properties if SKU is missing.
 */
function mapSkuToItemKey(sku, lineItem) {
  let normalizedSku = String(sku || "").trim();
  if (normalizedSku && /^\d+/.test(normalizedSku)) {
    return normalizedSku;
  }

  // Fallback: search in properties
  const properties = lineItem.properties || [];
  const janProp = properties.find(
    (p) => /jan/i.test(p.name) || /barcode/i.test(p.name),
  );
  if (janProp && janProp.value) {
    const jan = String(janProp.value).trim().replace(/\s+/g, "");
    const variantTitle = String(lineItem.variant_title || "").trim();
    return jan + variantTitle;
  }

  return normalizedSku || null;
}

/**
 * Maps a Shopify order payload to a shopify_order_placed action.
 */
function mapShopifyOrderToPlacedAction(order) {
  const orderID = `shopify:${order.id}`;
  const lines = (order.line_items || [])
    .map((li) => ({
      itemKey: mapSkuToItemKey(li.sku, li),
      qty: li.quantity,
      lineItemID: String(li.id),
    }))
    .filter((l) => l.itemKey);

  return {
    type: "shopify_order_placed",
    payload: {
      orderID,
      date: order.created_at,
      email: order.email || order.contact_email || "",
      lines,
    },
  };
}

/**
 * Maps a Shopify order payload to a shopify_order_cancelled action.
 */
function mapShopifyOrderToCancelledAction(order) {
  const orderID = `shopify:${order.id}`;
  const lines = (order.line_items || [])
    .map((li) => ({
      itemKey: mapSkuToItemKey(li.sku, li),
      qty: li.quantity,
      lineItemID: String(li.id),
    }))
    .filter((l) => l.itemKey);

  return {
    type: "shopify_order_cancelled",
    payload: {
      orderID,
      lines,
    },
  };
}

/**
 * Maps a Shopify refund payload to a shopify_order_refunded action.
 */
function mapShopifyRefundToRefundedAction(refund) {
  const orderID = `shopify:${refund.order_id}`;
  const lines = (refund.refund_line_items || [])
    .map((rli) => ({
      itemKey: mapSkuToItemKey(rli.line_item?.sku, rli.line_item || {}),
      qty: rli.quantity,
      lineItemID: String(rli.line_item_id),
    }))
    .filter((l) => l.itemKey);

  return {
    type: "shopify_order_refunded",
    payload: {
      orderID,
      refundID: String(refund.id),
      lines,
    },
  };
}

/**
 * Maps a Shopify order payload to a shopify_order_reconciled action.
 */
function mapShopifyOrderToReconciledAction(order) {
  const orderID = `shopify:${order.id}`;
  const itemQtyMap = {};
  (order.line_items || []).forEach((li) => {
    const key = mapSkuToItemKey(li.sku, li);
    if (key) {
      // currentQty is quantity - refund_quantity (cancelled items are also reflected in quantity in some API versions,
      // but usually quantity is the original ordered amount.
      // However, for reconciliation we want the current "to be shipped" or "shipped" amount.
      // In Shopify, cancelled line items have quantity reduced or order marked as cancelled.
      // If order is cancelled, we might want to report 0 for all items.
      const currentQty =
        order.cancelled_at ? 0 : li.quantity - (li.refund_quantity || 0);
      itemQtyMap[key] = (itemQtyMap[key] || 0) + currentQty;
    }
  });

  const lines = Object.entries(itemQtyMap).map(([itemKey, currentQty]) => ({
    itemKey,
    currentQty,
  }));

  return {
    type: "shopify_order_reconciled",
    payload: {
      orderID,
      timestamp: Date.parse(order.updated_at || order.created_at),
      lines,
    },
  };
}

module.exports = {
  verifyShopifyHmac,
  mapSkuToItemKey,
  mapShopifyOrderToPlacedAction,
  mapShopifyOrderToCancelledAction,
  mapShopifyRefundToRefundedAction,
  mapShopifyOrderToReconciledAction,
};
