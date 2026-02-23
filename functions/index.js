const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { setGlobalOptions, logger } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const core = require("./shared/shopify-sync-core.cjs");
const worker = require("./shared/shopify-sync-worker.cjs");

initializeApp();
setGlobalOptions({ maxInstances: 10 });

const db = getFirestore();
const SYNC_COLLECTION = "sync";
const SHOPIFY_NAMESPACE = "shopify";

function toLegacyShopifyEventType(eventType) {
  const value = String(eventType || "").trim();
  if (value.startsWith(`${SHOPIFY_NAMESPACE}/`)) {
    return value.slice(SHOPIFY_NAMESPACE.length + 1);
  }
  return value;
}

function getShopifyConfig() {
  const storeUrl = core.normalizeStoreUrl(process.env.SHOPIFY_STORE_URL || "");
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

async function processShopifySyncCreate(event, options = {}) {
  const requestId = event.params?.requestId;
  const requestData = event.data?.data();
  const collectionName = String(options.collectionName || SYNC_COLLECTION);
  const expectedEventType = String(
    options.expectedEventType || `${SHOPIFY_NAMESPACE}/sync_requested`,
  );

  if (!requestData) return;
  if (String(requestData.eventType || "") !== expectedEventType) return;

  const shopifyConfig = getShopifyConfig();
  try {
    const result = await worker.processRequestEvent({
      db,
      requestEventId: requestId,
      requestData: {
        ...requestData,
        eventType: toLegacyShopifyEventType(requestData.eventType),
      },
      processor: `function:${process.env.K_SERVICE || "syncShopifyRequest"}`,
      shopifyConfig,
      creator: "shopify-sync-function",
      collectionName,
      eventTypeNamespace: SHOPIFY_NAMESPACE,
    });

    if (!result.processed) {
      logger.info("Request not processed by function", {
        requestId,
        reason: result.reason,
        collectionName,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Failed processing Shopify sync request", {
      requestId,
      error: message,
      collectionName,
    });
  }
}

exports.syncRequest = onDocumentCreated(
  {
    document: `${SYNC_COLLECTION}/{requestId}`,
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async (event) => {
    const requestData = event.data?.data();
    if (!requestData) return;

    const eventType = String(requestData.eventType || "");
    if (eventType === `${SHOPIFY_NAMESPACE}/sync_requested`) {
      return processShopifySyncCreate(event, {
        collectionName: SYNC_COLLECTION,
        expectedEventType: `${SHOPIFY_NAMESPACE}/sync_requested`,
      });
    }

    logger.info("Ignoring unsupported sync event", {
      requestId: event.params?.requestId,
      eventType,
      collectionName: SYNC_COLLECTION,
    });
  },
);
