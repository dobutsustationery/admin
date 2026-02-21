const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { setGlobalOptions, logger } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const core = require("./shared/shopify-sync-core.cjs");
const worker = require("./shared/shopify-sync-worker.cjs");

initializeApp();
setGlobalOptions({ maxInstances: 10 });

const db = getFirestore();

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

exports.syncShopifyRequest = onDocumentCreated("shopify_sync/{requestId}", async (event) => {
  const requestId = event.params?.requestId;
  const requestData = event.data?.data();
  if (!requestData) return;
  if (requestData.eventType !== "sync_requested") return;

  const shopifyConfig = getShopifyConfig();
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
