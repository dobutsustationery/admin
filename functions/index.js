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
const SHOPIFY_LISTING_AUDIT_REQUEST_COLLECTION = "request_shopify_listing_audit";
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
  const clientId = normalizeEnvValue(
    process.env.GOOGLE_OAUTH_CLIENT_ID || "",
  );
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
    maxInstances: 3
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
      const userSecretsRef = db.collection(USER_SECRETS_COLLECTION).doc(creator);
      const userSecretsSnap = await userSecretsRef.get();
      const existingSecrets = userSecretsSnap.exists ? userSecretsSnap.data() : {};
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
        refreshToken = String(tokenResponse.refresh_token || refreshToken || "");
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
