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

function hasBinaryPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  
  const MAX_STRING_LENGTH = 10 * 1024; // 10 KB
  
  function checkValue(val) {
    if (typeof val === "string") {
      if (val.startsWith("data:") || val.startsWith("blob:")) return true;
      if (val.length > MAX_STRING_LENGTH) return true;
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (checkValue(item)) return true;
      }
    } else if (val !== null && typeof val === "object") {
      for (const key of Object.keys(val)) {
        if (checkValue(val[key])) return true;
      }
    }
    return false;
  }
  
  return checkValue(payload);
}

async function dispatchSyncCreate({ db, requestEventId, requestData, processor, logger }) {
  const eventType = String(requestData?.eventType || "").trim();
  if (!eventType) {
    return { handled: false, reason: "missing_event_type" };
  }

  if (hasBinaryPayload(requestData?.payload)) {
    logger?.error?.("Sync event rejected: payload contains binary data or exceeds size limits", {
      requestId: requestEventId,
      eventType,
    });
    // Write a rejection event to prevent the client from hanging indefinitely
    try {
      await db.collection(SYNC_COLLECTION).add({
        eventType: `${eventType.split('/')[0] || 'system'}/rejected`,
        requestEventId,
        requestId: requestData?.requestId || requestEventId,
        creator: "sync-dispatcher",
        processor,
        createdAtMs: Date.now(),
        payload: {
          errorCode: "binary_payload_rejected",
          errorMessage: "Payload contains binary data or exceeds size limits",
          retryable: false,
        }
      });
    } catch (e) {
      logger?.error?.("Failed to write rejection event", e);
    }
    return { handled: false, reason: "binary_payload_rejected" };
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

  if (
    eventType === `${PHOTOS_NAMESPACE}/image_transfer_requested` ||
    eventType === `${PHOTOS_NAMESPACE}/image_transfer_secret_provided`
  ) {
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
