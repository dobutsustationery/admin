const shopifyCore = require("./shopify-sync-core.cjs");
const shopifyWorker = require("./shopify-sync-worker.cjs");
const photosWorker = require("./photos-sync-worker.cjs");

const SYNC_COLLECTION = "sync";
const SHOPIFY_NAMESPACE = "shopify";
const PHOTOS_NAMESPACE = "photos";

function toLegacyShopifyEventType(eventType) {
  const value = String(eventType || "").trim();
  if (value.startsWith(`${SHOPIFY_NAMESPACE}/`)) {
    return value.slice(SHOPIFY_NAMESPACE.length + 1);
  }
  return value;
}

function getShopifyConfig() {
  const storeUrl = shopifyCore.normalizeStoreUrl(process.env.SHOPIFY_STORE_URL || "");
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN || "";
  const clientId = process.env.SHOPIFY_CLIENT_ID || "";
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || "";
  const apiVersion = process.env.SHOPIFY_API_VERSION || "2026-01";

  return {
    storeUrl,
    accessToken,
    clientId,
    clientSecret,
    apiVersion,
  };
}

async function dispatchSyncCreate({ db, requestEventId, requestData, processor, logger }) {
  const eventType = String(requestData?.eventType || "").trim();
  if (!eventType) {
    return { handled: false, reason: "missing_event_type" };
  }

  if (eventType === `${SHOPIFY_NAMESPACE}/sync_requested`) {
    const result = await shopifyWorker.processRequestEvent({
      db,
      requestEventId,
      requestData: {
        ...requestData,
        eventType: toLegacyShopifyEventType(eventType),
      },
      processor,
      shopifyConfig: getShopifyConfig(),
      creator: "shopify-sync-function",
      collectionName: SYNC_COLLECTION,
      eventTypeNamespace: SHOPIFY_NAMESPACE,
    });
    return { handled: true, domain: SHOPIFY_NAMESPACE, result };
  }

  if (eventType === `${PHOTOS_NAMESPACE}/image_transfer_requested`) {
    const result = await photosWorker.processRequestEvent({
      db,
      requestEventId,
      requestData,
      processor,
      creator: "photos-sync-function",
      collectionName: SYNC_COLLECTION,
    });
    return { handled: true, domain: PHOTOS_NAMESPACE, result };
  }

  logger?.info?.("Ignoring unsupported sync event", {
    requestId: requestEventId,
    eventType,
    collectionName: SYNC_COLLECTION,
  });
  return { handled: false, reason: "unsupported_event_type", eventType };
}

module.exports = {
  SYNC_COLLECTION,
  dispatchSyncCreate,
};
