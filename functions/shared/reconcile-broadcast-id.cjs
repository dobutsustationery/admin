function sanitizeBroadcastDocumentIdPart(value) {
  return String(value || "")
    .trim()
    .replace(/\//g, "_");
}

function shopifyReconcileBroadcastDocumentId(order) {
  const orderId = sanitizeBroadcastDocumentIdPart(
    order?.id || order?.admin_graphql_api_id,
  );
  const updatedAt = sanitizeBroadcastDocumentIdPart(order?.updated_at);
  if (!orderId || !updatedAt) return "";
  return `shopify_order_reconciled:${orderId}:${updatedAt}`;
}

function etsyReconcileBroadcastDocumentId(receipt) {
  const receiptId = sanitizeBroadcastDocumentIdPart(receipt?.receipt_id);
  const versionTimestamp = sanitizeBroadcastDocumentIdPart(
    receipt?.updated_timestamp || receipt?.create_timestamp,
  );
  if (!receiptId || !versionTimestamp) return "";
  return `etsy_order_reconciled:${receiptId}:${versionTimestamp}`;
}

module.exports = {
  etsyReconcileBroadcastDocumentId,
  shopifyReconcileBroadcastDocumentId,
};
