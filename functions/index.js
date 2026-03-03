const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { setGlobalOptions, logger } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const shopifyCore = require("./shared/shopify-sync-core.cjs");
const shopifyWorker = require("./shared/shopify-sync-worker.cjs");
const photosWorker = require("./shared/photos-sync-worker.cjs");

initializeApp();
setGlobalOptions({ maxInstances: 10 });

const db = getFirestore();
const SYNC_COLLECTION = "sync";
const SHOPIFY_REQUEST_COLLECTION = "request_shopify_sync";
const PHOTOS_TRANSFER_REQUEST_COLLECTION = "request_photos_transfer";
const PHOTOS_TRANSFORM_REQUEST_COLLECTION = "request_photos_transform";

function getShopifyConfig() {
  const storeUrl = shopifyCore.normalizeStoreUrl(
    process.env.SHOPIFY_STORE_URL || "",
  );
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

function logSkipped(dispatched, requestId, domain) {
  if (dispatched?.processed) return;
  logger.info("Sync event not processed", {
    requestId,
    reason: dispatched?.reason || "unknown",
    domain,
  });
}

function hasBinaryPayload(payload) {
  if (!payload || typeof payload !== "object") return false;

  const MAX_STRING_LENGTH = 10 * 1024; // 10 KB
  const checkValue = (val) => {
    if (typeof val === "string") {
      if (val.startsWith("data:") || val.startsWith("blob:")) return true;
      if (val.length > MAX_STRING_LENGTH) return true;
      return false;
    }
    if (Array.isArray(val)) return val.some(checkValue);
    if (val && typeof val === "object") {
      return Object.values(val).some(checkValue);
    }
    return false;
  };

  return checkValue(payload);
}

exports.shopifySyncRequest = onDocumentCreated(
  {
    document: `${SHOPIFY_REQUEST_COLLECTION}/{requestId}`,
    timeoutSeconds: 300,
    memory: "1GiB",
    concurrency: 1,
    maxInstances: 3,
  },
  async (event) => {
    const requestData = event.data?.data();
    if (!requestData) return;

    const requestId = event.params?.requestId;
    const processor = `function:${process.env.K_SERVICE || "shopifySyncRequest"}`;
    try {
      const dispatched = await shopifyWorker.processRequestEvent({
        db,
        requestEventId: requestId,
        requestData: {
          ...requestData,
          eventType: "sync_requested",
        },
        processor,
        shopifyConfig: getShopifyConfig(),
        creator: "shopify-sync-function",
        collectionName: SYNC_COLLECTION,
        eventTypeNamespace: "shopify",
      });
      logSkipped(dispatched, requestId, "shopify");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Failed processing sync event", {
        requestId,
        eventType: "shopify/sync_requested",
        error: message,
      });
    }
  },
);

exports.photosTransferRequest = onDocumentCreated(
  {
    document: `${PHOTOS_TRANSFER_REQUEST_COLLECTION}/{requestId}`,
    timeoutSeconds: 300,
    memory: "2GiB",
    concurrency: 2,
    maxInstances: 15,
  },
  async (event) => {
    const requestData = event.data?.data();
    if (!requestData) return;

    const requestId = event.params?.requestId;
    const processor = `function:${process.env.K_SERVICE || "photosTransferRequest"}`;
    try {
      const dispatched = await photosWorker.processRequestEvent({
        db,
        requestEventId: requestId,
        requestData,
        processor,
        creator: "photos-sync-function",
        collectionName: SYNC_COLLECTION,
      });
      logSkipped(dispatched, requestId, "photos");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Failed processing photos transfer request", {
        requestId,
        eventType: String(requestData.eventType || ""),
        error: message,
      });
    }
  },
);

exports.photosTransformRequest = onDocumentCreated(
  {
    document: `${PHOTOS_TRANSFORM_REQUEST_COLLECTION}/{requestId}`,
    timeoutSeconds: 300,
    memory: "4GiB",
    concurrency: 1,
    maxInstances: 25,
  },
  async (event) => {
    const requestData = event.data?.data();
    if (!requestData) return;

    const requestId = event.params?.requestId;
    const processor = `function:${process.env.K_SERVICE || "photosTransformRequest"}`;
    try {
      const dispatched = await photosWorker.processRequestEvent({
        db,
        requestEventId: requestId,
        requestData,
        processor,
        creator: "photos-sync-function",
        collectionName: SYNC_COLLECTION,
      });
      logSkipped(dispatched, requestId, "photos");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Failed processing photos transform request", {
        requestId,
        eventType: String(requestData.eventType || ""),
        error: message,
      });
    }
  },
);

exports.photosSecretResponse = onDocumentCreated(
  {
    document: `${SYNC_COLLECTION}/{requestId}`,
    timeoutSeconds: 120,
    memory: "512MiB",
    concurrency: 10,
    maxInstances: 30,
  },
  async (event) => {
    const requestData = event.data?.data();
    if (!requestData) return;
    if (String(requestData?.eventType || "") !== "photos/image_transfer_secret_provided") {
      return;
    }

    const requestId = event.params?.requestId;
    const processor = `function:${process.env.K_SERVICE || "photosSecretResponse"}`;
    try {
      const dispatched = await photosWorker.processRequestEvent({
        db,
        requestEventId: requestId,
        requestData,
        processor,
        creator: "photos-sync-function",
        collectionName: SYNC_COLLECTION,
      });
      logSkipped(dispatched, requestId, "photos");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Failed processing photos secret response", {
        requestId,
        eventType: String(requestData.eventType || ""),
        error: message,
      });
    }
  },
);

exports.syncPayloadValidation = onDocumentCreated(
  {
    document: `${SYNC_COLLECTION}/{requestId}`,
    timeoutSeconds: 120,
    memory: "512MiB",
    concurrency: 10,
    maxInstances: 10,
  },
  async (event) => {
    const requestData = event.data?.data();
    if (!requestData) return;

    const requestEventId = String(event.params?.requestId || "");
    const eventType = String(requestData?.eventType || "").trim();
    if (!eventType) return;
    if (!hasBinaryPayload(requestData?.payload)) return;

    logger.error(
      "Sync event rejected: payload contains binary data or exceeds size limits",
      {
        requestId: requestEventId,
        eventType,
      },
    );

    try {
      await db.collection(SYNC_COLLECTION).add({
        eventType: `${eventType.split("/")[0] || "system"}/rejected`,
        requestEventId,
        requestId: requestData?.requestId || requestEventId,
        creator: "sync-validation-function",
        processor: `function:${process.env.K_SERVICE || "syncPayloadValidation"}`,
        createdAtMs: Date.now(),
        payload: {
          errorCode: "binary_payload_rejected",
          errorMessage: "Payload contains binary data or exceeds size limits",
          retryable: false,
        },
      });
    } catch (error) {
      logger.error("Failed to write sync rejection event", {
        requestId: requestEventId,
        eventType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);
