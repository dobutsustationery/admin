const { FieldValue } = require("firebase-admin/firestore");
const core = require("./shopify-sync-core.cjs");

function eventDoc(db, id) {
  return db.collection("shopify_sync").doc(id);
}

function baseEvent({ eventType, requestId, requestEventId, handle, processor, payload }) {
  return {
    eventType,
    requestId,
    requestEventId,
    handle,
    processor,
    payload: payload || {},
    createdAtMs: Date.now(),
    timestamp: FieldValue.serverTimestamp(),
  };
}

async function createEvent(db, event) {
  await db.collection("shopify_sync").add(event);
}

async function createIdempotentEvent(db, deterministicId, event) {
  try {
    await eventDoc(db, deterministicId).create(event);
    return { created: true };
  } catch (error) {
    const code = error?.code || error?.status;
    const msg = String(error?.message || "");
    if (code === 6 || msg.toLowerCase().includes("already exists")) {
      return { created: false };
    }
    throw error;
  }
}

async function writeBroadcastApiLog(db, creator, payload) {
  await db.collection("broadcast").add({
    type: "shopify_api_log",
    payload: {
      ...payload,
      timestamp: Date.now(),
    },
    creator: creator || "shopify-sync-worker",
    timestamp: FieldValue.serverTimestamp(),
  });
}

function summarizeRequest(requestData) {
  const variants = Array.isArray(requestData?.variants) ? requestData.variants : [];
  return {
    requestId: String(requestData?.requestId || ""),
    handle: String(requestData?.handle || ""),
    variantCount: variants.length,
  };
}

async function claimRequest(db, requestEventId, requestData, processor) {
  const requestId = String(requestData?.requestId || "");
  const handle = String(requestData?.handle || "");

  if (!requestId || !handle) {
    return { claimed: false, reason: "invalid_request" };
  }

  const claimEvent = baseEvent({
    eventType: "sync_claimed",
    requestId,
    requestEventId,
    handle,
    processor,
    payload: {},
  });

  const claimId = `claim_${requestEventId}`;
  const result = await createIdempotentEvent(db, claimId, claimEvent);
  if (!result.created) {
    return { claimed: false, reason: "already_claimed" };
  }

  return { claimed: true };
}

async function appendApiEvent(db, creator, params) {
  const { requestId, requestEventId, handle, processor, requestType, endpoint, success, response, context } = params;

  const event = baseEvent({
    eventType: "sync_api_call",
    requestId,
    requestEventId,
    handle,
    processor,
    payload: {
      requestType,
      endpoint,
      success,
      response,
      context,
    },
  });

  await createEvent(db, event);
  await writeBroadcastApiLog(db, creator, {
    requestType,
    endpoint,
    success,
    response,
    context,
  });
}

async function appendFinalEvent(db, params) {
  const { requestEventId, requestData, processor, status, payload } = params;
  const requestId = String(requestData?.requestId || "");
  const handle = String(requestData?.handle || "");

  const eventType =
    status === "success"
      ? "sync_completed"
      : status === "partial_failed"
        ? "sync_partial_failed"
        : "sync_failed";

  const finalEvent = baseEvent({
    eventType,
    requestId,
    requestEventId,
    handle,
    processor,
    payload,
  });

  const finalId = `result_${requestEventId}`;
  await createIdempotentEvent(db, finalId, finalEvent);
}

async function executeClaimedRequest({ db, requestEventId, requestData, processor, shopifyConfig, creator }) {
  const requestId = String(requestData?.requestId || "");
  const handle = String(requestData?.handle || "");
  if (!requestId || !handle) {
    throw new Error("Invalid request: missing requestId or handle");
  }

  const apiVersion = shopifyConfig.apiVersion;

  let successCount = 0;
  let failureCount = 0;

  // Preflight config validation: fail without creating a sync_api_call event.
  if (!shopifyConfig?.storeUrl || !core.hasAnyCredentials(shopifyConfig)) {
    const message =
      "Missing Shopify credentials: set SHOPIFY_STORE_URL and either SHOPIFY_ACCESS_TOKEN or SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET";
    await appendFinalEvent(db, {
      requestEventId,
      requestData,
      processor,
      status: "failed",
      payload: {
        error: message,
        successCount,
        failureCount,
      },
    });
    throw new Error(message);
  }

  try {
    const locationId = await core.resolveLocationId(shopifyConfig);
    const product = await core.upsertProductFromRequest(shopifyConfig, requestData);

    await appendApiEvent(db, creator, {
      requestId,
      requestEventId,
      handle,
      processor,
      requestType: "product_update",
      endpoint: `/admin/api/${apiVersion}/products`,
      success: true,
      response: {
        productId: product.id,
        handle: product.handle,
        variantCount: product.variants?.length || 0,
      },
      context: { requestId, handle, productId: product.id, locationId, processor },
    });

    const variants = Array.isArray(requestData?.variants) ? requestData.variants : [];
    const responseVariantBySku = new Map();
    (Array.isArray(product.variants) ? product.variants : []).forEach((variant) => {
      const sku = String(variant?.sku || "").trim();
      if (sku) responseVariantBySku.set(sku, variant);
    });

    for (const variant of variants) {
      const sku = String(variant?.sku || "").trim();
      const targetQty = Math.max(0, Number(variant?.available || 0));
      if (!sku) continue;

      const responseVariant = responseVariantBySku.get(sku);
      const inventoryItemId = core.toNumberOrNull(responseVariant?.inventory_item_id);
      const endpoint = `/admin/api/${apiVersion}/inventory_levels/set.json`;

      if (!inventoryItemId) {
        failureCount += 1;
        await appendApiEvent(db, creator, {
          requestId,
          requestEventId,
          handle,
          processor,
          requestType: "inventory_sync",
          endpoint,
          success: false,
          response: { error: "Missing inventory_item_id after product upsert" },
          context: { requestId, handle, sku, targetQty, locationId, processor },
        });
        continue;
      }

      try {
        const response = await core.setInventoryLevel(shopifyConfig, locationId, inventoryItemId, targetQty);
        successCount += 1;
        await appendApiEvent(db, creator, {
          requestId,
          requestEventId,
          handle,
          processor,
          requestType: "inventory_sync",
          endpoint,
          success: true,
          response,
          context: {
            requestId,
            handle,
            sku,
            targetQty,
            inventoryItemId,
            locationId,
            processor,
          },
        });
      } catch (error) {
        failureCount += 1;
        const message = error instanceof Error ? error.message : String(error);
        await appendApiEvent(db, creator, {
          requestId,
          requestEventId,
          handle,
          processor,
          requestType: "inventory_sync",
          endpoint,
          success: false,
          response: { error: message },
          context: {
            requestId,
            handle,
            sku,
            targetQty,
            inventoryItemId,
            locationId,
            processor,
          },
        });
      }
    }

    await appendFinalEvent(db, {
      requestEventId,
      requestData,
      processor,
      status: failureCount === 0 ? "success" : "partial_failed",
      payload: {
        successCount,
        failureCount,
        productId: product.id,
        productHandle: product.handle,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    await appendApiEvent(db, creator, {
      requestId,
      requestEventId,
      handle,
      processor,
      requestType: "product_update",
      endpoint: `/admin/api/${apiVersion}/products`,
      success: false,
      response: { error: message },
      context: { requestId, handle, processor },
    });

    await appendFinalEvent(db, {
      requestEventId,
      requestData,
      processor,
      status: "failed",
      payload: {
        error: message,
        successCount,
        failureCount,
      },
    });

    throw error;
  }
}

async function processRequestEvent({ db, requestEventId, requestData, processor, shopifyConfig, creator }) {
  const claim = await claimRequest(db, requestEventId, requestData, processor);
  if (!claim.claimed) {
    return { processed: false, reason: claim.reason || "not_claimed" };
  }

  await executeClaimedRequest({
    db,
    requestEventId,
    requestData,
    processor,
    shopifyConfig,
    creator,
  });

  return { processed: true, summary: summarizeRequest(requestData) };
}

module.exports = {
  processRequestEvent,
  claimRequest,
  executeClaimedRequest,
  summarizeRequest,
};
