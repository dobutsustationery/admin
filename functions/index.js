const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions, logger } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const shopifyCore = require("./shared/shopify-sync-core.cjs");
const shopifyWorker = require("./shared/shopify-sync-worker.cjs");
const shopifyOrderLogic = require("./shared/shopify-order-logic.cjs");
const photosWorker = require("./shared/photos-sync-worker.cjs");

initializeApp();
setGlobalOptions({ maxInstances: 10 });

const db = getFirestore();
const BROADCAST_COLLECTION = "broadcast";
const SYNC_COLLECTION = "sync";
const SHOPIFY_REQUEST_COLLECTION = "request_shopify_sync";
const SHOPIFY_LISTING_AUDIT_REQUEST_COLLECTION =
  "request_shopify_listing_audit";
const SHOPIFY_CATALOG_SYNC_REQUEST_COLLECTION = "request_shopify_catalog_sync";
const PHOTOS_TRANSFER_REQUEST_COLLECTION = "request_photos_transfer";
const PHOTOS_TRANSFORM_REQUEST_COLLECTION = "request_photos_transform";
const GOOGLE_AUTH_REQUEST_COLLECTION = "request_google_auth";
const GOOGLE_AUTH_RESULTS_COLLECTION = "google_auth_results";
const USER_SECRETS_COLLECTION = "user_secrets";
const GOOGLE_OAUTH_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

function normalizeEnvValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1).trim();
  }
  return raw;
}

function getShopifyConfig() {
  const storeUrl = shopifyCore.normalizeStoreUrl(
    process.env.SHOPIFY_STORE_URL || "",
  );
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN || "";
  const clientId = process.env.SHOPIFY_CLIENT_ID || "";
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET || "test_secret";
  const apiVersion = process.env.SHOPIFY_API_VERSION || "2026-01";
  return {
    storeUrl,
    accessToken,
    clientId,
    clientSecret,
    apiVersion,
  };
}

async function fetchAllShopifyProductAuditData(config) {
  const storeUrl = shopifyCore.normalizeStoreUrl(config?.storeUrl || "");
  const apiVersion = String(config?.apiVersion || "2026-01").trim();
  if (!storeUrl) {
    throw new Error("Missing SHOPIFY_STORE_URL");
  }

  const handleMap = new Map();
  let sinceId = 0;

  while (true) {
    const params = new URLSearchParams({
      limit: "250",
      fields: "id,handle,updated_at",
      since_id: String(sinceId),
    });
    const endpoint = `https://${storeUrl}/admin/api/${apiVersion}/products.json?${params.toString()}`;
    const headers = await shopifyCore.buildShopifyHeaders(config);
    const json = await shopifyCore.fetchJson(endpoint, { headers });
    const products = Array.isArray(json?.products) ? json.products : [];

    for (const product of products) {
      const handle = String(product?.handle || "").trim();
      if (!handle) continue;

      const updatedAtIso = String(product?.updated_at || "").trim();
      const updatedAtMs = updatedAtIso ? Date.parse(updatedAtIso) : 0;
      const normalizedUpdatedAtMs = Number.isFinite(updatedAtMs)
        ? updatedAtMs
        : 0;

      const existing = handleMap.get(handle);
      if (!existing || normalizedUpdatedAtMs > existing.updatedAtMs) {
        handleMap.set(handle, {
          updatedAtIso,
          updatedAtMs: normalizedUpdatedAtMs,
        });
      }
    }

    if (products.length === 0) break;
    sinceId = Number(products[products.length - 1]?.id || 0);
    if (!Number.isFinite(sinceId) || sinceId <= 0 || products.length < 250) {
      break;
    }
  }

  const shopifyHandles = Array.from(handleMap.keys()).sort((a, b) =>
    a.localeCompare(b),
  );
  const shopifyByHandle = Object.fromEntries(handleMap.entries());
  return { shopifyHandles, shopifyByHandle };
}

function trimString(value) {
  return String(value || "").trim();
}

function toCatalogStatus(value) {
  const normalized = trimString(value).toLowerCase();
  if (normalized === "archived") return "archived";
  if (normalized === "draft") return "draft";
  return "active";
}

function extractNumericId(value) {
  const raw = trimString(value);
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return raw;
  const gidMatch = /\/(\d+)$/.exec(raw);
  return gidMatch?.[1] || "";
}

function toWeightGrams(rawWeight) {
  const unit = trimString(rawWeight?.unit).toUpperCase();
  const value = Number(rawWeight?.value || 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (unit === "KILOGRAMS" || unit === "KILOGRAM") return value * 1000;
  if (unit === "POUNDS" || unit === "POUND") return value * 453.59237;
  if (unit === "OUNCES" || unit === "OUNCE") return value * 28.349523125;
  return value;
}

function buildCatalogQueryString(sinceUpdatedAtMs) {
  const normalizedSince = Number(sinceUpdatedAtMs || 0);
  if (!Number.isFinite(normalizedSince) || normalizedSince <= 0) return "";
  const overlapIso = new Date(
    Math.max(0, normalizedSince - 1000),
  ).toISOString();
  return `updated_at:>='${overlapIso}'`;
}

function getOptionNodes(options) {
  if (Array.isArray(options)) return options;
  if (Array.isArray(options?.nodes)) return options.nodes;
  return [];
}

function normalizeCatalogProductNode(product) {
  const imageNodes = Array.isArray(product?.images?.nodes)
    ? product.images.nodes
    : [];
  const variantNodes = Array.isArray(product?.variants?.nodes)
    ? product.variants.nodes
    : [];
  const optionNodes = getOptionNodes(product?.options);
  const updatedAtIso = trimString(product?.updatedAt);
  const updatedAtMs = updatedAtIso ? Date.parse(updatedAtIso) : 0;

  return {
    productId: extractNumericId(product?.id),
    handle: trimString(product?.handle),
    title: trimString(product?.title),
    bodyHtml: trimString(product?.descriptionHtml),
    vendor: trimString(product?.vendor),
    productType: trimString(product?.productType),
    productCategory: trimString(product?.category?.fullName),
    tags: Array.isArray(product?.tags)
      ? product.tags.map((tag) => trimString(tag)).filter(Boolean)
      : [],
    status: toCatalogStatus(product?.status),
    option1Name: trimString(optionNodes[0]?.name),
    updatedAtIso,
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
    images: imageNodes.map((image, index) => ({
      id: extractNumericId(image?.id) || trimString(image?.url),
      url: trimString(image?.url),
      position: index + 1,
      altText: trimString(image?.altText),
    })),
    variants: variantNodes
      .map((variant) => {
        const selectedOptions = Array.isArray(variant?.selectedOptions)
          ? variant.selectedOptions
          : [];
        const selectedValue = trimString(selectedOptions[0]?.value);
        return {
          id: extractNumericId(variant?.id),
          sku: trimString(variant?.sku),
          subtype: selectedValue || trimString(variant?.title),
          price: Number(variant?.price || 0),
          janCode: trimString(variant?.barcode),
          weight:
            Math.round(
              toWeightGrams(variant?.inventoryItem?.measurement?.weight) * 1000,
            ) / 1000,
          inventoryQuantity: Number(variant?.inventoryQuantity || 0),
          image: trimString(variant?.image?.url),
        };
      })
      .filter((variant) => variant.sku),
  };
}

async function fetchShopifyCatalogSyncData(
  config,
  { sinceUpdatedAtMs = 0 } = {},
) {
  const queryString = buildCatalogQueryString(sinceUpdatedAtMs);
  const listings = [];
  let maxUpdatedAtMs = Number(sinceUpdatedAtMs || 0);
  let after = null;

  while (true) {
    const data = await shopifyCore.fetchJson(
      `https://${config.storeUrl}/admin/api/${config.apiVersion}/graphql.json`,
      {
        method: "POST",
        headers: await shopifyCore.buildShopifyHeaders(config),
        body: JSON.stringify({
          query: `
            query FetchShopifyCatalogPage($first: Int!, $after: String, $query: String!) {
              products(first: $first, after: $after, sortKey: UPDATED_AT, query: $query) {
                pageInfo {
                  hasNextPage
                  endCursor
                }
                nodes {
                  id
                  handle
                  title
                  descriptionHtml
                  productType
                  vendor
                  tags
                  status
                  updatedAt
                  category {
                    fullName
                  }
                  options {
                    name
                    position
                  }
                  images(first: 100) {
                    nodes {
                      id
                      url
                      altText
                    }
                  }
                  variants(first: 100) {
                    nodes {
                      id
                      sku
                      title
                      barcode
                      price
                      inventoryQuantity
                      selectedOptions {
                        name
                        value
                      }
                      image {
                        id
                        url
                        altText
                      }
                      inventoryItem {
                        measurement {
                          weight {
                            unit
                            value
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          `,
          variables: {
            first: 100,
            after,
            query: queryString,
          },
        }),
      },
    );

    if (Array.isArray(data?.errors) && data.errors.length > 0) {
      throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
    }

    const payload = data?.data?.products;
    const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];

    nodes.forEach((node) => {
      const listing = normalizeCatalogProductNode(node);
      if (!listing.handle) return;
      maxUpdatedAtMs = Math.max(
        maxUpdatedAtMs,
        Number(listing.updatedAtMs || 0),
      );
      listings.push(listing);
    });

    if (!payload?.pageInfo?.hasNextPage || !payload?.pageInfo?.endCursor) {
      break;
    }
    after = payload.pageInfo.endCursor;
  }

  return { listings, maxUpdatedAtMs };
}

function chunkShopifyCatalogListings(listings, maxBytes = 450 * 1024) {
  const chunks = [];
  let currentChunk = [];
  let currentBytes = 0;

  for (const listing of listings) {
    const nextBytes = Buffer.byteLength(JSON.stringify(listing), "utf8");
    if (currentChunk.length > 0 && currentBytes + nextBytes > maxBytes) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentBytes = 0;
    }
    currentChunk.push(listing);
    currentBytes += nextBytes;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

async function writeBroadcastAction({ action, creator, atMs }) {
  await db.collection(BROADCAST_COLLECTION).add({
    ...action,
    timestamp: new Date(atMs),
    creator,
  });
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

function getGoogleOAuthConfig() {
  const clientId = normalizeEnvValue(process.env.GOOGLE_OAUTH_CLIENT_ID || "");
  const clientSecret = normalizeEnvValue(
    process.env.GOOGLE_OAUTH_CLIENT_SECRET ||
      process.env.GOOGLE_OAUTH_SECRET ||
      "",
  );
  return {
    clientId,
    clientSecret,
  };
}

async function writeGoogleAuthSyncEvent({
  requestId,
  creator,
  eventType,
  processor,
  payload = {},
}) {
  await db.collection(SYNC_COLLECTION).add({
    eventType,
    requestId,
    creator,
    processor,
    createdAt: new Date(),
    createdAtMs: Date.now(),
    payload,
  });
}

async function exchangeGoogleCode({
  code,
  codeVerifier,
  redirectUri,
  clientId,
  clientSecret,
}) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    client_id: clientId,
    redirect_uri: redirectUri,
  });
  if (clientSecret) body.set("client_secret", clientSecret);

  const response = await fetch(GOOGLE_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = String(json?.error || "unknown");
    const errDesc = String(json?.error_description || "");
    throw new Error(
      `google_exchange_failed:${response.status}:${err}${errDesc ? `:${errDesc}` : ""}`,
    );
  }
  return json;
}

async function refreshGoogleToken({ refreshToken, clientId, clientSecret }) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  if (clientSecret) body.set("client_secret", clientSecret);

  const response = await fetch(GOOGLE_OAUTH_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = String(json?.error || "unknown");
    const errDesc = String(json?.error_description || "");
    throw new Error(
      `google_refresh_failed:${response.status}:${err}${errDesc ? `:${errDesc}` : ""}`,
    );
  }
  return json;
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

exports.shopifyListingAuditRequest = onDocumentCreated(
  {
    document: `${SHOPIFY_LISTING_AUDIT_REQUEST_COLLECTION}/{requestId}`,
    timeoutSeconds: 300,
    memory: "512MiB",
    concurrency: 2,
    maxInstances: 5,
  },
  async (event) => {
    const requestData = event.data?.data();
    if (!requestData) return;

    const requestId = String(event.params?.requestId || "");
    const creator = String(requestData.creator || "").trim();
    const processor = `function:${process.env.K_SERVICE || "shopifyListingAuditRequest"}`;
    const eventType = String(requestData.eventType || "").trim();
    if (
      eventType &&
      eventType !== "shopify/listings_audit_requested" &&
      eventType !== "listings_audit_requested"
    ) {
      return;
    }

    if (!requestId || !creator) {
      logger.error("Invalid Shopify listing audit request shape", {
        requestId,
        creator,
      });
      return;
    }

    try {
      const shopifyConfig = getShopifyConfig();
      const { shopifyHandles, shopifyByHandle } =
        await fetchAllShopifyProductAuditData(shopifyConfig);

      await db.collection(SYNC_COLLECTION).add({
        eventType: "shopify/listings_audit_completed",
        requestId,
        requestEventId: requestId,
        creator,
        requestedBy: creator,
        processor,
        createdAt: new Date(),
        createdAtMs: Date.now(),
        payload: {
          handleCount: shopifyHandles.length,
          shopifyHandles,
          shopifyByHandle,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Failed processing Shopify listings audit request", {
        requestId,
        creator,
        error: message,
      });
      await db.collection(SYNC_COLLECTION).add({
        eventType: "shopify/listings_audit_failed",
        requestId,
        requestEventId: requestId,
        creator,
        requestedBy: creator,
        processor,
        createdAt: new Date(),
        createdAtMs: Date.now(),
        payload: {
          errorCode: "shopify_listings_audit_failed",
          errorMessage: message,
        },
      });
    }
  },
);

exports.shopifyCatalogSyncRequest = onDocumentCreated(
  {
    document: `${SHOPIFY_CATALOG_SYNC_REQUEST_COLLECTION}/{requestId}`,
    timeoutSeconds: 300,
    memory: "1GiB",
    concurrency: 1,
    maxInstances: 3,
  },
  async (event) => {
    const requestData = event.data?.data();
    if (!requestData) return;

    const requestId = trimString(event.params?.requestId);
    const creator = trimString(requestData.creator);
    const processor = `function:${process.env.K_SERVICE || "shopifyCatalogSyncRequest"}`;
    const eventType = trimString(requestData.eventType);
    if (
      eventType &&
      eventType !== "shopify/catalog_sync_requested" &&
      eventType !== "catalog_sync_requested"
    ) {
      return;
    }

    if (!requestId || !creator) {
      logger.error("Invalid Shopify catalog sync request shape", {
        requestId,
        creator,
      });
      return;
    }

    const forceFull = !!requestData.forceFull;
    const sinceUpdatedAtMs = forceFull
      ? 0
      : Number(requestData.sinceUpdatedAtMs || 0);
    const mode =
      forceFull || !Number.isFinite(sinceUpdatedAtMs) || sinceUpdatedAtMs <= 0
        ? "full"
        : "incremental";
    const broadcastCreator = "shopify-catalog-sync-function";
    const startMs = Date.now();

    await writeBroadcastAction({
      action: {
        type: "shopifyCatalog/begin_sync",
        payload: {
          requestId,
          mode,
          requestedAtMs: startMs,
        },
      },
      creator: broadcastCreator,
      atMs: startMs,
    });

    try {
      const shopifyConfig = getShopifyConfig();
      const { listings, maxUpdatedAtMs } = await fetchShopifyCatalogSyncData(
        shopifyConfig,
        { sinceUpdatedAtMs: mode === "incremental" ? sinceUpdatedAtMs : 0 },
      );

      const chunks = chunkShopifyCatalogListings(listings);
      let nextAtMs = startMs + 1;

      for (const chunk of chunks) {
        await writeBroadcastAction({
          action: {
            type: "shopifyCatalog/apply_sync_chunk",
            payload: {
              requestId,
              mode,
              listings: chunk,
            },
          },
          creator: broadcastCreator,
          atMs: nextAtMs,
        });
        nextAtMs += 1;
      }

      await writeBroadcastAction({
        action: {
          type: "shopifyCatalog/complete_sync",
          payload: {
            requestId,
            mode,
            syncedAtMs: Date.now(),
            maxUpdatedAtMs,
          },
        },
        creator: broadcastCreator,
        atMs: nextAtMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Failed processing Shopify catalog sync request", {
        requestId,
        creator,
        error: message,
      });
      await writeBroadcastAction({
        action: {
          type: "shopifyCatalog/fail_sync",
          payload: {
            requestId,
            mode,
            failedAtMs: Date.now(),
            errorMessage: message,
          },
        },
        creator: broadcastCreator,
        atMs: Date.now(),
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
    if (
      String(requestData?.eventType || "") !==
      "photos/image_transfer_secret_provided"
    ) {
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

exports.googleAuthRequest = onDocumentCreated(
  {
    document: `${GOOGLE_AUTH_REQUEST_COLLECTION}/{requestId}`,
    timeoutSeconds: 300,
    memory: "512MiB",
    concurrency: 10,
    maxInstances: 20,
  },
  async (event) => {
    const requestData = event.data?.data();
    if (!requestData) return;
    const requestRef = event.data?.ref;

    const requestId = String(event.params?.requestId || "");
    const requestType = String(requestData.type || "");
    const creator = String(requestData.creator || "");
    const processor = `function:${process.env.K_SERVICE || "googleAuthRequest"}`;

    if (!requestId || !creator || !requestType) {
      logger.error("Invalid google auth request shape", {
        requestId,
        creator,
        requestType,
      });
      return;
    }

    const cfg = getGoogleOAuthConfig();
    if (!cfg.clientId) {
      logger.error("Missing Google OAuth client configuration", { requestId });
      await writeGoogleAuthSyncEvent({
        requestId,
        creator,
        eventType: "google/auth_failed",
        processor,
        payload: {
          errorCode: "config_missing",
          message:
            "Missing GOOGLE_OAUTH_CLIENT_ID in functions runtime env (run env:functions:* to regenerate functions/.env)",
        },
      });
      return;
    }
    if (!cfg.clientSecret) {
      logger.error("Missing Google OAuth client secret configuration", {
        requestId,
      });
      await writeGoogleAuthSyncEvent({
        requestId,
        creator,
        eventType: "google/auth_failed",
        processor,
        payload: {
          errorCode: "config_missing",
          message:
            "Missing GOOGLE_OAUTH_CLIENT_SECRET in functions runtime env (alias: GOOGLE_OAUTH_SECRET in root env files)",
        },
      });
      return;
    }

    await writeGoogleAuthSyncEvent({
      requestId,
      creator,
      eventType: "google/auth_started",
      processor,
      payload: { type: requestType },
    });

    try {
      const userSecretsRef = db
        .collection(USER_SECRETS_COLLECTION)
        .doc(creator);
      const userSecretsSnap = await userSecretsRef.get();
      const existingSecrets = userSecretsSnap.exists
        ? userSecretsSnap.data()
        : {};
      let tokenResponse = null;
      let refreshToken = String(existingSecrets?.google?.refreshToken || "");

      if (requestType === "exchange") {
        const code = String(requestData.code || "");
        const codeVerifier = String(requestData.codeVerifier || "");
        const redirectUri = String(requestData.redirectUri || "");
        if (!code || !codeVerifier || !redirectUri) {
          throw new Error("missing_exchange_parameters");
        }
        tokenResponse = await exchangeGoogleCode({
          code,
          codeVerifier,
          redirectUri,
          clientId: cfg.clientId,
          clientSecret: cfg.clientSecret,
        });
        refreshToken = String(
          tokenResponse.refresh_token || refreshToken || "",
        );
        if (refreshToken) {
          await userSecretsRef.set(
            {
              google: {
                refreshToken,
                updatedAt: new Date(),
                updatedAtMs: Date.now(),
              },
            },
            { merge: true },
          );
        }
      } else if (requestType === "refresh") {
        if (!refreshToken) {
          throw new Error("refresh_token_missing");
        }
        tokenResponse = await refreshGoogleToken({
          refreshToken,
          clientId: cfg.clientId,
          clientSecret: cfg.clientSecret,
        });
      } else {
        throw new Error(`unsupported_request_type:${requestType}`);
      }

      const accessToken = String(tokenResponse?.access_token || "");
      const expiresIn = Number(tokenResponse?.expires_in || 0);
      const scope = String(tokenResponse?.scope || "");
      const tokenType = String(tokenResponse?.token_type || "Bearer");

      if (!accessToken || !expiresIn) {
        throw new Error("token_response_invalid");
      }

      await db
        .collection(GOOGLE_AUTH_RESULTS_COLLECTION)
        .doc(creator)
        .collection("requests")
        .doc(requestId)
        .set({
          requestId,
          creator,
          accessToken,
          expiresIn,
          scope,
          tokenType,
          createdAt: new Date(),
          createdAtMs: Date.now(),
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
          expiresAtMs: Date.now() + 5 * 60 * 1000,
        });

      await writeGoogleAuthSyncEvent({
        requestId,
        creator,
        eventType: "google/auth_completed",
        processor,
        payload: {
          expiresIn,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Google auth request failed", {
        requestId,
        requestType,
        creator,
        error: message,
      });
      await writeGoogleAuthSyncEvent({
        requestId,
        creator,
        eventType: "google/auth_failed",
        processor,
        payload: {
          errorCode: "google_auth_failed",
          message,
        },
      });
    } finally {
      if (requestRef) {
        // Request documents contain OAuth code + verifier; remove them after processing.
        await requestRef.delete().catch((error) => {
          logger.warn("Failed to cleanup google auth request document", {
            requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }
  },
);

exports.shopifyOrderWebhook = onRequest(
  {
    timeoutSeconds: 30,
    memory: "512MiB",
    concurrency: 10,
  },
  async (req, res) => {
    const topic = req.headers["x-shopify-topic"];
    const hmac = req.headers["x-shopify-hmac-sha256"];
    const webhookId = req.headers["x-shopify-webhook-id"];

    // 1. HMAC Verification
    const config = getShopifyConfig();
    // Use rawBody if available for HMAC verification
    const bodyToVerify = req.rawBody || JSON.stringify(req.body);
    if (
      !shopifyOrderLogic.verifyShopifyHmac(
        bodyToVerify,
        hmac,
        config.clientSecret,
      )
    ) {
      logger.error("HMAC verification failed", { topic, webhookId });
      return res.status(401).send("Unauthorized");
    }

    if (!webhookId) {
      return res.status(400).send("Missing webhook ID");
    }

    try {
      // 2. Raw Persistence
      await db.collection("shopify_order_webhooks").doc(webhookId).set({
        topic,
        payload: req.body,
        createdAt: FieldValue.serverTimestamp(),
      });

      // 3. Deduplication
      const eventRef = db.collection("shopify_order_events").doc(webhookId);
      const eventSnap = await eventRef.get();
      if (eventSnap.exists) {
        logger.info("Duplicate webhook received", { webhookId });
        return res.status(200).send("Duplicate");
      }
      await eventRef.set({ processedAt: FieldValue.serverTimestamp() });

      // 4. Identify Action Type
      let type = "shopify_unrecognized_topic";
      if (topic === "orders/create") {
        type = "shopify_order_created";
      } else if (topic === "orders/cancelled") {
        type = "shopify_order_cancelled";
      } else if (topic === "refunds/create") {
        type = "shopify_refund_created";
      } else if (topic === "orders/updated") {
        type = "shopify_order_updated";
      }

      // 5. Dispatch
      await writeBroadcastAction({
        action: {
          type,
          payload: { raw: req.body, topic },
        },
        creator: "shopify-webhook",
        atMs: Date.now(),
      });

      res.status(200).send("OK");
    } catch (error) {
      logger.error("Webhook processing failed", {
        webhookId,
        topic,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).send("Internal Error");
    }
  },
);

exports.shopifyOrderReconcile = onSchedule(
  {
    schedule: "every 15 minutes",
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async (event) => {
    const config = getShopifyConfig();
    const stateRef = db.collection("shopify_order_sync_state").doc("default");
    const stateSnap = await stateRef.get();
    const state = stateSnap.exists ? stateSnap.data() : {};

    let lastCursor = state.lastOrderUpdatedAtCursor || "1970-01-01T00:00:00Z";

    const storeUrl = config.storeUrl;
    const apiVersion = config.apiVersion;

    try {
      const params = new URLSearchParams({
        updated_at_min: lastCursor,
        status: "any",
        limit: "50",
      });

      const endpoint = `https://${storeUrl}/admin/api/${apiVersion}/orders.json?${params.toString()}`;
      const headers = await shopifyCore.buildShopifyHeaders(config);
      const json = await shopifyCore.fetchJson(endpoint, { headers });

      const orders = Array.isArray(json?.orders) ? json.orders : [];

      for (const order of orders) {
        await writeBroadcastAction({
          action: {
            type: "shopify_order_reconciled",
            payload: { raw: order, topic: "reconcile" },
          },
          creator: "shopify-reconcile-poller",
          atMs: Date.now(),
        });

        if (order.updated_at > lastCursor) {
          lastCursor = order.updated_at;
        }
      }

      await stateRef.set(
        {
          lastOrderUpdatedAtCursor: lastCursor,
          lastRunAt: Date.now(),
        },
        { merge: true },
      );
    } catch (error) {
      logger.error("Shopify order reconciliation failed", error);
    }
  },
);

exports.cleanupShopifyTransientData = onSchedule(
  {
    schedule: "every 24 hours",
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async (event) => {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const collectionsToCleanup = [
      {
        name: "shopify_order_webhooks",
        timeField: "createdAt",
        timeValue: thirtyDaysAgo,
      },
      {
        name: "shopify_order_events",
        timeField: "processedAt",
        timeValue: thirtyDaysAgo,
      },
      {
        name: SYNC_COLLECTION,
        timeField: "createdAt",
        timeValue: thirtyDaysAgo,
        filter: (query) =>
          query
            .where("eventType", ">=", "shopify/")
            .where("eventType", "<", "shopify0"),
      },
    ];

    for (const col of collectionsToCleanup) {
      logger.info(`Cleaning up collection: ${col.name}`);
      let query = db
        .collection(col.name)
        .where(col.timeField, "<", col.timeValue);
      if (col.filter) {
        query = col.filter(query);
      }

      let deletedTotal = 0;
      while (true) {
        const snapshot = await query.limit(500).get();
        if (snapshot.empty) break;

        const batch = db.batch();
        snapshot.docs.forEach((doc) => batch.delete(doc.ref));
        await batch.commit();
        deletedTotal += snapshot.size;
        if (snapshot.size < 500) break;
      }
      logger.info(`Deleted total ${deletedTotal} docs from ${col.name}`);
    }
  },
);
