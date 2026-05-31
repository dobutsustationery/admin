const crypto = require("crypto");

function sanitizeBroadcastDocumentIdPart(value) {
  return String(value || "")
    .trim()
    .replace(/\//g, "_");
}

function stablePayloadHash(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value || {}))
    .digest("hex")
    .slice(0, 24);
}

function shopifyReconcileBroadcastDocumentId(order) {
  const orderId = sanitizeBroadcastDocumentIdPart(
    order?.id || order?.admin_graphql_api_id,
  );
  const updatedAt = sanitizeBroadcastDocumentIdPart(order?.updated_at);
  if (!orderId)
    return `shopify_order_reconciled:payload:${stablePayloadHash(order)}`;
  if (!updatedAt) {
    return `shopify_order_reconciled:${orderId}:payload:${stablePayloadHash(order)}`;
  }
  return `shopify_order_reconciled:${orderId}:${updatedAt}`;
}

function etsyReconcileBroadcastDocumentId(receipt) {
  const receiptId = sanitizeBroadcastDocumentIdPart(receipt?.receipt_id);
  const versionTimestamp = sanitizeBroadcastDocumentIdPart(
    receipt?.updated_timestamp || receipt?.create_timestamp,
  );
  if (!receiptId)
    return `etsy_order_reconciled:payload:${stablePayloadHash(receipt)}`;
  if (!versionTimestamp) {
    return `etsy_order_reconciled:${receiptId}:payload:${stablePayloadHash(receipt)}`;
  }
  return `etsy_order_reconciled:${receiptId}:${versionTimestamp}`;
}

module.exports = {
  etsyReconcileBroadcastDocumentId,
  shopifyReconcileBroadcastDocumentId,
};
