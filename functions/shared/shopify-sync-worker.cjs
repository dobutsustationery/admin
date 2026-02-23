const { FieldValue } = require("firebase-admin/firestore");
const core = require("./shopify-sync-core.cjs");

function getSyncCollectionName(options) {
  return String(options?.collectionName || "sync");
}

function qualifyShopifyEventType(eventType, options) {
  const value = String(eventType || "").trim();
  if (!value) return value;
  const namespace = String(options?.eventTypeNamespace || "").trim();
  if (!namespace) return value;
  if (value.startsWith(`${namespace}/`)) return value;
  return `${namespace}/${value}`;
}

function eventDoc(db, id, options) {
  return db.collection(getSyncCollectionName(options)).doc(id);
}

function baseEvent({
  eventType,
  requestId,
  requestEventId,
  handle,
  creator,
  processor,
  payload,
}) {
  return {
    eventType,
    requestId,
    requestEventId,
    handle,
    creator: creator || "shopify-sync-worker",
    processor,
    payload: payload || {},
    createdAtMs: Date.now(),
    timestamp: FieldValue.serverTimestamp(),
  };
}

async function createEvent(db, event, options) {
  await db.collection(getSyncCollectionName(options)).add(event);
}

async function createIdempotentEvent(db, deterministicId, event, options) {
  try {
    await eventDoc(db, deterministicId, options).create(event);
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
  const variants = Array.isArray(requestData?.variants)
    ? requestData.variants
    : [];
  return {
    requestId: String(requestData?.requestId || ""),
    handle: String(requestData?.handle || ""),
    variantCount: variants.length,
  };
}

async function claimRequest(
  db,
  requestEventId,
  requestData,
  creator,
  processor,
  options,
) {
  const requestId = String(requestData?.requestId || "");
  const handle = String(requestData?.handle || "");

  if (!requestId || !handle) {
    return { claimed: false, reason: "invalid_request" };
  }

  const claimEvent = baseEvent({
    eventType: qualifyShopifyEventType("sync_claimed", options),
    requestId,
    requestEventId,
    handle,
    creator,
    processor,
    payload: {},
  });

  const claimId = `claim_${requestEventId}`;
  const result = await createIdempotentEvent(db, claimId, claimEvent, options);
  if (!result.created) {
    return { claimed: false, reason: "already_claimed" };
  }

  return { claimed: true };
}

async function appendApiEvent(db, creator, params) {
  const {
    requestId,
    requestEventId,
    handle,
    processor,
    requestType,
    endpoint,
    success,
    response,
    context,
    options,
  } = params;

  const event = baseEvent({
    eventType: qualifyShopifyEventType("sync_api_call", options),
    requestId,
    requestEventId,
    handle,
    creator,
    processor,
    payload: {
      requestType,
      endpoint,
      success,
      response,
      context,
    },
  });

  await createEvent(db, event, options);
  await writeBroadcastApiLog(db, creator, {
    requestType,
    endpoint,
    success,
    response,
    context,
  });
}

async function appendFinalEvent(db, params) {
  const {
    requestEventId,
    requestData,
    creator,
    processor,
    status,
    payload,
    options,
  } = params;
  const requestId = String(requestData?.requestId || "");
  const handle = String(requestData?.handle || "");

  const eventType =
    status === "success"
      ? "sync_completed"
      : status === "partial_failed"
        ? "sync_partial_failed"
        : "sync_failed";

  const finalEvent = baseEvent({
    eventType: qualifyShopifyEventType(eventType, options),
    requestId,
    requestEventId,
    handle,
    creator,
    processor,
    payload,
  });

  const finalId = `result_${requestEventId}`;
  await createIdempotentEvent(db, finalId, finalEvent, options);
}

async function executeClaimedRequest({
  db,
  requestEventId,
  requestData,
  processor,
  shopifyConfig,
  creator,
  collectionName,
  eventTypeNamespace,
}) {
  const requestId = String(requestData?.requestId || "");
  const handle = String(requestData?.handle || "");
  if (!requestId || !handle) {
    throw new Error("Invalid request: missing requestId or handle");
  }

  const apiVersion = shopifyConfig.apiVersion;

  let successCount = 0;
  let failureCount = 0;
  const eventOptions = { collectionName, eventTypeNamespace };

  // Preflight config validation: fail without creating a sync_api_call event.
  if (!shopifyConfig?.storeUrl || !core.hasAnyCredentials(shopifyConfig)) {
    const message =
      "Missing Shopify credentials: set SHOPIFY_STORE_URL and either SHOPIFY_ACCESS_TOKEN or SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET";
    await appendFinalEvent(db, {
      requestEventId,
      requestData,
      creator,
      processor,
      status: "failed",
      payload: {
        error: message,
        successCount,
        failureCount,
      },
      options: eventOptions,
    });
    throw new Error(message);
  }

  try {
    const locationId = await core.resolveLocationId(shopifyConfig);
    await appendApiEvent(db, creator, {
      requestId,
      requestEventId,
      handle,
      processor,
      requestType: "location_resolve",
      endpoint: `/admin/api/${apiVersion}/locations`,
      success: true,
      response: { locationId },
      context: { requestId, handle, processor },
      options: eventOptions,
    });

    const product = await core.upsertProductFromRequest(
      shopifyConfig,
      requestData,
    );
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
      context: {
        requestId,
        handle,
        productId: product.id,
        locationId,
        processor,
      },
      options: eventOptions,
    });

    const publication = await core.ensureProductPublishedToOnlineStore(
      shopifyConfig,
      product.id,
    );

    await appendApiEvent(db, creator, {
      requestId,
      requestEventId,
      handle,
      processor,
      requestType: "product_publication_sync",
      endpoint: `/admin/api/${apiVersion}/graphql.json`,
      success: true,
      response: publication,
      context: { requestId, handle, productId: product.id, processor },
      options: eventOptions,
    });

    const variants = Array.isArray(requestData?.variants)
      ? requestData.variants
      : [];
    const responseVariantBySku = new Map();
    (Array.isArray(product.variants) ? product.variants : []).forEach(
      (variant) => {
        const sku = String(variant?.sku || "").trim();
        if (sku) responseVariantBySku.set(sku, variant);
      },
    );

    for (const variant of variants) {
      const sku = String(variant?.sku || "").trim();
      const targetQty = Math.max(0, Number(variant?.available || 0));
      if (!sku) continue;

      const responseVariant = responseVariantBySku.get(sku);
      const inventoryItemId = core.toNumberOrNull(
        responseVariant?.inventory_item_id,
      );
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
          options: eventOptions,
        });
        continue;
      }

      try {
        const response = await core.setInventoryLevel(
          shopifyConfig,
          locationId,
          inventoryItemId,
          targetQty,
        );
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
          options: eventOptions,
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
          options: eventOptions,
        });
      }
    }

    await appendFinalEvent(db, {
      requestEventId,
      requestData,
      creator,
      processor,
      status: failureCount === 0 ? "success" : "partial_failed",
      payload: {
        successCount,
        failureCount,
        productId: product.id,
        productHandle: product.handle,
      },
      options: eventOptions,
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
      options: eventOptions,
    });

    await appendFinalEvent(db, {
      requestEventId,
      requestData,
      creator,
      processor,
      status: "failed",
      payload: {
        error: message,
        successCount,
        failureCount,
      },
      options: eventOptions,
    });

    throw error;
  }
}

async function processRequestEvent({
  db,
  requestEventId,
  requestData,
  processor,
  shopifyConfig,
  creator,
  collectionName,
  eventTypeNamespace,
}) {
  const eventOptions = { collectionName, eventTypeNamespace };
  const claim = await claimRequest(
    db,
    requestEventId,
    requestData,
    creator,
    processor,
    eventOptions,
  );
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
    collectionName,
    eventTypeNamespace,
  });

  return { processed: true, summary: summarizeRequest(requestData) };
}

module.exports = {
  processRequestEvent,
  claimRequest,
  executeClaimedRequest,
  summarizeRequest,
};
