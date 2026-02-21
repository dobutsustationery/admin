const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { setGlobalOptions, logger } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const core = require("./shared/shopify-sync-core.cjs");
const worker = require("./shared/shopify-sync-worker.cjs");

initializeApp();
setGlobalOptions({ maxInstances: 10 });

const db = getFirestore();

function getShopifyConfig() {
  const storeUrl = core.normalizeStoreUrl(process.env.SHOPIFY_STORE_URL || "");
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN || "";
  const apiVersion = process.env.SHOPIFY_API_VERSION || "2024-01";

  return {
    storeUrl,
    accessToken,
    apiVersion,
  };
}

exports.syncShopifyRequest = onDocumentCreated("shopify_sync/{requestId}", async (event) => {
  const requestId = event.params?.requestId;
  const requestData = event.data?.data();
  if (!requestData) return;
  if (requestData.eventType !== "sync_requested") return;

  const shopifyConfig = getShopifyConfig();
  if (!shopifyConfig.storeUrl || !shopifyConfig.accessToken) {
    logger.error("Missing Shopify env vars for function runtime", {
      hasStoreUrl: !!shopifyConfig.storeUrl,
      hasAccessToken: !!shopifyConfig.accessToken,
      requestId,
    });

    try {
      await db.collection("shopify_sync").add({
        eventType: "sync_failed",
        requestId: requestData.requestId || "",
        requestEventId: requestId,
        handle: requestData.handle || "",
        processor: `function:${process.env.K_SERVICE || "syncShopifyRequest"}`,
        payload: {
          error: "Function missing SHOPIFY_STORE_URL or SHOPIFY_ACCESS_TOKEN",
        },
        createdAtMs: Date.now(),
        timestamp: FieldValue.serverTimestamp(),
      });
    } catch {
      // no-op
    }
    return;
  }

  try {
    const result = await worker.processRequestEvent({
      db,
      requestEventId: requestId,
      requestData,
      processor: `function:${process.env.K_SERVICE || "syncShopifyRequest"}`,
      shopifyConfig,
      creator: "shopify-sync-function",
    });

    if (!result.processed) {
      logger.info("Request not processed by function", { requestId, reason: result.reason });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Failed processing Shopify sync request", { requestId, error: message });
  }
});
