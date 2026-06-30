const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions, logger } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const shopifyCore = require("./shared/shopify-sync-core.cjs");
const shopifyWorker = require("./shared/shopify-sync-worker.cjs");
const shopifyOrderLogic = require("./shared/shopify-order-logic.cjs");
const etsyOrderLogic = require("./shared/etsy-order-logic.cjs");
const photosWorker = require("./shared/photos-sync-worker.cjs");
const {
  etsyReconcileBroadcastDocumentId,
  shopifyReconcileBroadcastDocumentId,
} = require("./shared/reconcile-broadcast-id.cjs");

initializeApp();
setGlobalOptions({ maxInstances: 10 });

const db = getFirestore();
const BROADCAST_COLLECTION = "broadcast";
const SYNC_COLLECTION = "sync";
const SHOPIFY_REQUEST_COLLECTION = "request_shopify_sync";
const SHOPIFY_LISTING_AUDIT_REQUEST_COLLECTION =
  "request_shopify_listing_audit";
const SHOPIFY_CATALOG_SYNC_REQUEST_COLLECTION = "request_shopify_catalog_sync";
const AMAZON_CATALOG_PROBE_REQUEST_COLLECTION = "request_amazon_catalog_probe";
const AMAZON_LISTING_CREATE_REQUEST_COLLECTION =
  "request_amazon_listing_create";
const AMAZON_PRODUCT_TYPE_DISCOVERY_REQUEST_COLLECTION =
  "request_amazon_product_type_discovery";
const AMAZON_LISTING_RESTRICTIONS_REQUEST_COLLECTION =
  "request_amazon_listing_restrictions";
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

function getEtsyConfig() {
  // If the Etsy app is configured as a confidential client (the default on
  // newer Etsy apps), every API call must send `x-api-key: <keystring>:<shared_secret>`.
  // Public clients accept just the keystring. The shared secret here is the
  // *app-level* secret shown on the Etsy developer-portal API page, not the
  // per-webhook secret used for HMAC verification (ETSY_SHARED_SECRET).
  const keystring = process.env.ETSY_API_KEY || "";
  const keystringSharedSecret = process.env.ETSY_KEYSTRING_SHARED_SECRET || "";
  const apiKey = keystringSharedSecret
    ? `${keystring}:${keystringSharedSecret}`
    : keystring;
  return {
    shopId: process.env.ETSY_SHOP_ID || "",
    apiKey,
    keystring,
    keystringSharedSecret,
    accessToken: process.env.ETSY_ACCESS_TOKEN || "",
    refreshToken: process.env.ETSY_REFRESH_TOKEN || "",
    // NOTE: Default secret is for emulator use only.
    // MUST be overridden via ETSY_SHARED_SECRET env var in production.
    sharedSecret: process.env.ETSY_SHARED_SECRET || "whsec_dGVzdF9zZWNyZXQ=",
  };
}

const AMAZON_LWA_TOKEN_ENDPOINT = "https://api.amazon.com/auth/o2/token";
const AMAZON_REGION_ENDPOINTS = {
  na: "https://sellingpartnerapi-na.amazon.com",
  eu: "https://sellingpartnerapi-eu.amazon.com",
  fe: "https://sellingpartnerapi-fe.amazon.com",
};
const AMAZON_DEFAULT_CATALOG_INCLUDED_DATA = [
  "summaries",
  "identifiers",
  "images",
  "productTypes",
  "relationships",
  "classifications",
];
const AMAZON_DEFAULT_LISTINGS_INCLUDED_DATA = [
  "summaries",
  "attributes",
  "issues",
  "offers",
  "fulfillmentAvailability",
  "relationships",
  "productTypes",
];
const AMAZON_HTTP_TIMEOUT_MS = 90_000;

function amazonTrim(value) {
  return String(value || "").trim();
}

function getAmazonEnv(keys, fallback = "") {
  for (const key of keys) {
    const value = normalizeEnvValue(process.env[key] || "");
    if (value) return value;
  }
  return fallback;
}

function requireAmazonEnv(keys, label) {
  const value = getAmazonEnv(keys, "");
  if (value) return value;
  throw new Error(`Missing ${label}. Tried: ${keys.join(", ")}`);
}

function getAmazonConfig() {
  const region = getAmazonEnv(["AMAZON_SP_API_REGION"], "eu").toLowerCase();
  const endpoint = getAmazonEnv(
    ["AMAZON_SP_API_ENDPOINT"],
    AMAZON_REGION_ENDPOINTS[region] || "",
  ).replace(/\/+$/, "");
  if (!endpoint) {
    throw new Error(
      `Missing Amazon SP-API endpoint. Set AMAZON_SP_API_ENDPOINT or AMAZON_SP_API_REGION (${Object.keys(AMAZON_REGION_ENDPOINTS).join(", ")}).`,
    );
  }

  return {
    endpoint,
    marketplaceId: requireAmazonEnv(
      ["AMAZON_MARKETPLACE_ID", "AMAZON_SP_API_MARKETPLACE_ID"],
      "Amazon marketplace ID",
    ),
    sellerId: getAmazonEnv(["AMAZON_SELLER_ID", "AMAZON_SP_API_SELLER_ID"]),
    userAgent: getAmazonEnv(
      ["AMAZON_SP_API_USER_AGENT"],
      "DobutsuAdmin/0.1 (Language=JavaScript; Runtime=CloudFunctions)",
    ),
    lwaClientId: requireAmazonEnv(
      ["AMAZON_LWA_CLIENT_ID", "AMAZON_SP_API_CLIENT_ID"],
      "Amazon LWA client ID",
    ),
    lwaClientSecret: requireAmazonEnv(
      ["AMAZON_LWA_CLIENT_SECRET", "AMAZON_SP_API_CLIENT_SECRET"],
      "Amazon LWA client secret",
    ),
    lwaRefreshToken: requireAmazonEnv(
      ["AMAZON_LWA_REFRESH_TOKEN", "AMAZON_SP_API_REFRESH_TOKEN"],
      "Amazon LWA refresh token",
    ),
  };
}

function amazonDate(date = new Date()) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function cleanAmazonList(value, maxCount) {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,\s]+/)
      : [];
  return rawValues
    .map((entry) => amazonTrim(entry))
    .filter(Boolean)
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .slice(0, maxCount);
}

function cleanAmazonIncludedData(value, fallback) {
  const values = cleanAmazonList(value, 30);
  return values.length ? values : fallback;
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = AMAZON_HTTP_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(
        `Amazon API request timed out after ${timeoutMs}ms: ${url}`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAmazonLwaAccessToken(config) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: config.lwaRefreshToken,
    client_id: config.lwaClientId,
    client_secret: config.lwaClientSecret,
  });

  const response = await fetchWithTimeout(AMAZON_LWA_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      accept: "application/json",
    },
    body,
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      `Amazon LWA token exchange failed (${response.status} ${response.statusText})`,
    );
  }

  const accessToken = amazonTrim(data?.access_token);
  if (!accessToken) {
    throw new Error("Amazon LWA token response did not include access_token.");
  }
  return accessToken;
}

async function amazonSpApiGet({
  endpoint,
  path,
  query,
  accessToken,
  userAgent,
}) {
  const url = new URL(path, endpoint);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && String(value).trim()) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetchWithTimeout(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent": userAgent,
      "x-amz-access-token": accessToken,
      "x-amz-date": amazonDate(),
    },
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    rateLimit: response.headers.get("x-amzn-ratelimit-limit") || "",
    url: url.toString(),
    data,
  };
}

async function amazonSpApiPut({
  endpoint,
  path,
  query,
  accessToken,
  userAgent,
  body,
}) {
  const url = new URL(path, endpoint);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && String(value).trim()) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetchWithTimeout(url, {
    method: "PUT",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": userAgent,
      "x-amz-access-token": accessToken,
      "x-amz-date": amazonDate(),
    },
    body: JSON.stringify(body || {}),
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    rateLimit: response.headers.get("x-amzn-ratelimit-limit") || "",
    url: url.toString(),
    data,
  };
}

async function fetchAmazonProductTypeSchema({ schemaUrl }) {
  if (!schemaUrl) return null;

  const response = await fetchWithTimeout(schemaUrl, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  const text = await response.text();

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    rateLimit: response.headers.get("x-amzn-ratelimit-limit") || "",
    url: schemaUrl,
    data: text,
  };
}

async function fetchAmazonProductTypeSchemaResponse(definitionData) {
  const schemaUrl = amazonTrim(definitionData?.schema?.link?.resource);
  if (!schemaUrl) return null;

  try {
    return await fetchAmazonProductTypeSchema({ schemaUrl });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      statusText: "",
      url: schemaUrl,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function makeAmazonRawResponseRecord({
  requestId,
  kind,
  key,
  marketplaceId,
  sellerId,
  endpoint,
  response,
  fetchedAtMs,
}) {
  return {
    id: `${requestId}:${kind}:${key}`,
    requestId,
    kind,
    key,
    marketplaceId,
    sellerId,
    endpoint,
    requestUrl: response.url,
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    rateLimit: response.rateLimit,
    fetchedAtMs,
    raw: response.data,
  };
}

async function writeAmazonSyncEvent({
  requestId,
  creator,
  eventType,
  processor,
  source,
  payload,
}) {
  await db.collection(SYNC_COLLECTION).add({
    eventType,
    requestId,
    requestEventId: requestId,
    creator,
    requestedBy: creator,
    processor,
    source,
    createdAt: new Date(),
    createdAtMs: Date.now(),
    timestamp: FieldValue.serverTimestamp(),
    payload: payload || {},
  });
}

async function searchAmazonCatalogByJan({
  config,
  jan,
  identifiersType,
  includedData,
  accessToken,
  locale,
}) {
  return amazonSpApiGet({
    endpoint: config.endpoint,
    path: "/catalog/2022-04-01/items",
    query: {
      identifiers: jan,
      identifiersType,
      marketplaceIds: config.marketplaceId,
      includedData: includedData.join(","),
      locale,
      pageSize: "20",
    },
    accessToken,
    userAgent: config.userAgent,
  });
}

async function searchAmazonListingsByIdentifier({
  config,
  identifier,
  identifiersType,
  includedData,
  accessToken,
  locale,
}) {
  return amazonSpApiGet({
    endpoint: config.endpoint,
    path: `/listings/2021-08-01/items/${encodeURIComponent(config.sellerId)}`,
    query: {
      identifiers: identifier,
      identifiersType,
      marketplaceIds: config.marketplaceId,
      includedData: includedData.join(","),
      issueLocale: locale,
      pageSize: "20",
    },
    accessToken,
    userAgent: config.userAgent,
  });
}

async function getAmazonListingBySku({
  config,
  sku,
  includedData,
  accessToken,
  locale,
}) {
  return amazonSpApiGet({
    endpoint: config.endpoint,
    path: `/listings/2021-08-01/items/${encodeURIComponent(config.sellerId)}/${encodeURIComponent(sku)}`,
    query: {
      marketplaceIds: config.marketplaceId,
      includedData: includedData.join(","),
      issueLocale: locale,
    },
    accessToken,
    userAgent: config.userAgent,
  });
}

async function searchAmazonProductTypes({
  config,
  itemName,
  keywords,
  accessToken,
  locale,
  searchLocale,
}) {
  const query = {
    marketplaceIds: config.marketplaceId,
    locale,
    searchLocale: searchLocale || locale,
  };
  const cleanItemName = amazonTrim(itemName);
  const cleanKeywords = cleanAmazonList(keywords, 20).join(",");
  if (cleanItemName) {
    query.itemName = cleanItemName;
  } else if (cleanKeywords) {
    query.keywords = cleanKeywords;
  }

  return amazonSpApiGet({
    endpoint: config.endpoint,
    path: "/definitions/2020-09-01/productTypes",
    query,
    accessToken,
    userAgent: config.userAgent,
  });
}

async function getAmazonProductTypeDefinition({
  config,
  productType,
  requirements,
  accessToken,
  locale,
  requirementsEnforced,
}) {
  return amazonSpApiGet({
    endpoint: config.endpoint,
    path: `/definitions/2020-09-01/productTypes/${encodeURIComponent(productType)}`,
    query: {
      marketplaceIds: config.marketplaceId,
      sellerId: config.sellerId,
      requirements,
      requirementsEnforced,
      locale,
    },
    accessToken,
    userAgent: config.userAgent,
  });
}

async function getAmazonListingRestrictions({
  config,
  asin,
  conditionType,
  reasonLocale,
  accessToken,
}) {
  return amazonSpApiGet({
    endpoint: config.endpoint,
    path: "/listings/2021-08-01/restrictions",
    query: {
      asin,
      sellerId: config.sellerId,
      marketplaceIds: config.marketplaceId,
      conditionType,
      reasonLocale,
    },
    accessToken,
    userAgent: config.userAgent,
  });
}

async function putAmazonListingBySku({
  config,
  sku,
  productType,
  requirements,
  payload,
  accessToken,
  locale,
}) {
  return amazonSpApiPut({
    endpoint: config.endpoint,
    path: `/listings/2021-08-01/items/${encodeURIComponent(config.sellerId)}/${encodeURIComponent(sku)}`,
    query: {
      marketplaceIds: config.marketplaceId,
      issueLocale: locale,
    },
    accessToken,
    userAgent: config.userAgent,
    body: {
      productType,
      requirements,
      attributes: payload?.attributes || {},
    },
  });
}

function extractAmazonProductTypeNames(searchData, maxCount) {
  const productTypes = Array.isArray(searchData?.productTypes)
    ? searchData.productTypes
    : [];
  return productTypes
    .map((entry) => amazonTrim(entry?.name || entry?.productType))
    .filter(Boolean)
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .slice(0, maxCount);
}

function getAmazonListingSubmissionError(responseData) {
  const status = amazonTrim(responseData?.status).toUpperCase();
  const issues = Array.isArray(responseData?.issues) ? responseData.issues : [];
  const errorIssue = issues.find(
    (issue) => amazonTrim(issue?.severity).toUpperCase() === "ERROR",
  );
  if (status === "INVALID" || errorIssue) {
    const issueMessage = amazonTrim(errorIssue?.message);
    return issueMessage || `Amazon listing submission status: ${status}`;
  }
  return "";
}

function normalizeAmazonListingCreateSubmissions({
  payload,
  fallbackProductType,
  fallbackRequirements,
}) {
  const rawSubmissions = Array.isArray(payload?.submissions)
    ? payload.submissions
    : [];
  const submissions = rawSubmissions
    .map((entry) => {
      const sku = amazonTrim(entry?.sku);
      const productType = amazonTrim(
        entry?.productType || fallbackProductType,
      ).toUpperCase();
      const requirements =
        amazonTrim(entry?.requirements || fallbackRequirements) || "LISTING";
      const submissionPayload =
        entry?.payload && typeof entry.payload === "object"
          ? entry.payload
          : { attributes: entry?.attributes || {} };
      return {
        role: amazonTrim(entry?.role || "standalone") || "standalone",
        itemKey: amazonTrim(entry?.itemKey),
        sku,
        productType,
        requirements,
        payload: submissionPayload,
      };
    })
    .filter(
      (entry) =>
        entry.sku &&
        entry.productType &&
        entry.payload &&
        typeof entry.payload === "object",
    );

  if (submissions.length > 0) return submissions;
  return [];
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
  const data = {
    ...action,
    creator,
  };
  if (atMs !== undefined) {
    data.timestamp = new Date(atMs);
  } else {
    data.timestamp = FieldValue.serverTimestamp();
  }
  await db.collection(BROADCAST_COLLECTION).add(data);
}

async function writeBroadcastActionOnce({ action, creator, documentId }) {
  const data = {
    ...action,
    creator,
    timestamp: FieldValue.serverTimestamp(),
  };

  try {
    await db.collection(BROADCAST_COLLECTION).doc(documentId).create(data);
    return { written: true };
  } catch (error) {
    const code = error?.code || error?.status;
    const message = String(error?.message || "").toLowerCase();
    if (code === 6 || message.includes("already exists")) {
      return { written: false, reason: "already_exists" };
    }
    throw error;
  }
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

exports.amazonCatalogProbeRequest = onDocumentCreated(
  {
    document: `${AMAZON_CATALOG_PROBE_REQUEST_COLLECTION}/{requestId}`,
    timeoutSeconds: 300,
    memory: "512MiB",
    concurrency: 1,
    maxInstances: 3,
  },
  async (event) => {
    const requestData = event.data?.data();
    if (!requestData) return;

    const requestId = trimString(event.params?.requestId);
    const creator = trimString(requestData.creator);
    const processor = `function:${process.env.K_SERVICE || "amazonCatalogProbeRequest"}`;
    const eventType = trimString(requestData.eventType);
    if (
      eventType &&
      eventType !== "amazon/catalog_probe_requested" &&
      eventType !== "catalog_probe_requested"
    ) {
      return;
    }

    const jans = cleanAmazonList(requestData.jans || requestData.jan, 100);
    const skus = cleanAmazonList(requestData.skus || requestData.sku, 100);
    const shouldSearchSellerListings =
      requestData.includeSellerListings !== false;

    if (!requestId || !creator || (jans.length === 0 && skus.length === 0)) {
      logger.error("Invalid Amazon catalog probe request shape", {
        requestId,
        creator,
        janCount: jans.length,
        skuCount: skus.length,
      });
      return;
    }

    const mode = skus.length > 0 ? "sku_probe" : "jan_probe";
    const broadcastCreator = "amazon-catalog-probe-function";
    const startMs = Date.now();
    const source = trimString(requestData.source || "amazon-listings-page");
    let config = {
      endpoint: "",
      marketplaceId: "",
      sellerId: "",
      userAgent: "",
    };

    await writeAmazonSyncEvent({
      requestId,
      creator,
      eventType: "amazon/catalog_probe_requested",
      processor,
      source,
      payload: {
        jans,
        skus,
        includeSellerListings: shouldSearchSellerListings,
        identifiersType: requestData.identifiersType || "JAN",
        listingIdentifiersType: requestData.listingIdentifiersType || "JAN",
      },
    });

    try {
      config = getAmazonConfig();
      const identifiersType = amazonTrim(
        requestData.identifiersType || "JAN",
      ).toUpperCase();
      const listingIdentifiersType = amazonTrim(
        requestData.listingIdentifiersType || identifiersType,
      ).toUpperCase();
      const locale = amazonTrim(requestData.locale || "");
      const includedData = cleanAmazonIncludedData(
        requestData.includedData,
        AMAZON_DEFAULT_CATALOG_INCLUDED_DATA,
      );
      const listingIncludedData = cleanAmazonIncludedData(
        requestData.listingIncludedData,
        AMAZON_DEFAULT_LISTINGS_INCLUDED_DATA,
      );

      await writeAmazonSyncEvent({
        requestId,
        creator,
        eventType: "amazon/catalog_probe_started",
        processor,
        source,
        payload: {
          mode,
          marketplaceId: config.marketplaceId,
          sellerId: config.sellerId,
          endpoint: config.endpoint,
          janCount: jans.length,
          skuCount: skus.length,
        },
      });

      await writeBroadcastAction({
        action: {
          type: "amazonCatalog/begin_probe",
          payload: {
            requestId,
            mode,
            marketplaceId: config.marketplaceId,
            sellerId: config.sellerId,
            requestedAtMs: startMs,
          },
        },
        creator: broadcastCreator,
        atMs: startMs,
      });

      if ((shouldSearchSellerListings || skus.length > 0) && !config.sellerId) {
        throw new Error(
          "Missing AMAZON_SELLER_ID. Set it to search Amazon seller listings.",
        );
      }

      const accessToken = await fetchAmazonLwaAccessToken(config);
      const responses = [];

      async function writeApiCallEvent({ requestType, key, response }) {
        await writeAmazonSyncEvent({
          requestId,
          creator,
          eventType: "amazon/catalog_probe_api_call",
          processor,
          source,
          payload: {
            requestType,
            endpoint: response.url,
            success: !!response.ok,
            response: response.data,
            context: {
              key,
              status: response.status,
              statusText: response.statusText,
              rateLimit: response.rateLimit,
              marketplaceId: config.marketplaceId,
              sellerId: config.sellerId,
            },
          },
        });
      }

      for (const jan of jans) {
        const response = await searchAmazonCatalogByJan({
          config,
          jan,
          identifiersType,
          includedData,
          accessToken,
          locale,
        });
        await writeApiCallEvent({
          requestType: "catalog_search_by_jan",
          key: jan,
          response,
        });
        responses.push(
          makeAmazonRawResponseRecord({
            requestId,
            kind: "catalog_search_by_jan",
            key: jan,
            marketplaceId: config.marketplaceId,
            sellerId: config.sellerId,
            endpoint: config.endpoint,
            response,
            fetchedAtMs: Date.now(),
          }),
        );

        if (shouldSearchSellerListings) {
          const listingsResponse = await searchAmazonListingsByIdentifier({
            config,
            identifier: jan,
            identifiersType: listingIdentifiersType,
            includedData: listingIncludedData,
            accessToken,
            locale,
          });
          await writeApiCallEvent({
            requestType: "seller_listings_search_by_jan",
            key: jan,
            response: listingsResponse,
          });
          responses.push(
            makeAmazonRawResponseRecord({
              requestId,
              kind: "seller_listings_search_by_jan",
              key: jan,
              marketplaceId: config.marketplaceId,
              sellerId: config.sellerId,
              endpoint: config.endpoint,
              response: listingsResponse,
              fetchedAtMs: Date.now(),
            }),
          );
        }
      }

      for (const sku of skus) {
        const listingResponse = await getAmazonListingBySku({
          config,
          sku,
          includedData: listingIncludedData,
          accessToken,
          locale,
        });
        await writeApiCallEvent({
          requestType: "seller_listing_get_by_sku",
          key: sku,
          response: listingResponse,
        });
        responses.push(
          makeAmazonRawResponseRecord({
            requestId,
            kind: "seller_listing_get_by_sku",
            key: sku,
            marketplaceId: config.marketplaceId,
            sellerId: config.sellerId,
            endpoint: config.endpoint,
            response: listingResponse,
            fetchedAtMs: Date.now(),
          }),
        );
      }

      await writeBroadcastAction({
        action: {
          type: "amazonCatalog/apply_probe_chunk",
          payload: {
            requestId,
            mode,
            marketplaceId: config.marketplaceId,
            sellerId: config.sellerId,
            responses,
          },
        },
        creator: broadcastCreator,
        atMs: startMs + 1,
      });

      await writeBroadcastAction({
        action: {
          type: "amazonCatalog/complete_probe",
          payload: {
            requestId,
            mode,
            marketplaceId: config.marketplaceId,
            sellerId: config.sellerId,
            completedAtMs: Date.now(),
          },
        },
        creator: broadcastCreator,
        atMs: startMs + 2,
      });

      await writeAmazonSyncEvent({
        requestId,
        creator,
        eventType: "amazon/catalog_probe_completed",
        processor,
        source,
        payload: {
          mode,
          marketplaceId: config.marketplaceId,
          sellerId: config.sellerId,
          janCount: jans.length,
          skuCount: skus.length,
          responseCount: responses.length,
        },
      });

      logger.info("Amazon catalog probe completed", {
        requestId,
        creator,
        processor,
        janCount: jans.length,
        skuCount: skus.length,
        responseCount: responses.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Failed processing Amazon catalog probe request", {
        requestId,
        creator,
        processor,
        error: message,
      });
      await writeAmazonSyncEvent({
        requestId,
        creator,
        eventType: "amazon/catalog_probe_failed",
        processor,
        source,
        payload: {
          errorCode: "amazon_catalog_probe_failed",
          errorMessage: message,
          message,
          mode,
          marketplaceId: config.marketplaceId,
          sellerId: config.sellerId,
        },
      });
      await writeBroadcastAction({
        action: {
          type: "amazonCatalog/fail_probe",
          payload: {
            requestId,
            mode,
            marketplaceId: config.marketplaceId,
            sellerId: config.sellerId,
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

exports.amazonProductTypeDiscoveryRequest = onDocumentCreated(
  {
    document: `${AMAZON_PRODUCT_TYPE_DISCOVERY_REQUEST_COLLECTION}/{requestId}`,
    timeoutSeconds: 300,
    memory: "512MiB",
    concurrency: 1,
    maxInstances: 2,
  },
  async (event) => {
    const requestData = event.data?.data();
    if (!requestData) return;

    const requestId = trimString(event.params?.requestId);
    const creator = trimString(requestData.creator);
    const processor = `function:${process.env.K_SERVICE || "amazonProductTypeDiscoveryRequest"}`;
    const eventType = trimString(requestData.eventType);
    if (
      eventType &&
      eventType !== "amazon/product_type_discovery_requested" &&
      eventType !== "product_type_discovery_requested"
    ) {
      return;
    }

    const itemName = amazonTrim(requestData.itemName);
    const requestedKeywords = cleanAmazonList(requestData.keywords, 20);
    const keywords = itemName ? [] : requestedKeywords;
    const searchKey = itemName || keywords.join(",");

    if (!requestId || !creator || !searchKey) {
      logger.error("Invalid Amazon product type discovery request shape", {
        requestId,
        creator,
        itemName,
        keywords,
      });
      return;
    }

    const broadcastCreator = "amazon-product-type-discovery-function";
    const startMs = Date.now();
    const source = trimString(requestData.source || "amazon-listings-page");
    const mode = "product_type_discovery";
    let config = {
      endpoint: "",
      marketplaceId: "",
      sellerId: "",
      userAgent: "",
    };

    await writeAmazonSyncEvent({
      requestId,
      creator,
      eventType: "amazon/product_type_discovery_requested",
      processor,
      source,
      payload: {
        itemName,
        keywords,
        searchKey,
        handle: trimString(requestData.handle),
        itemKey: trimString(requestData.itemKey),
      },
    });

    try {
      config = getAmazonConfig();
      if (!config.sellerId) {
        throw new Error(
          "Missing AMAZON_SELLER_ID. Set it to fetch Amazon product type definitions.",
        );
      }

      const locale = amazonTrim(requestData.locale || "en_GB") || "en_GB";
      const searchLocale =
        amazonTrim(requestData.searchLocale || locale) || locale;
      const requirements = amazonTrim(requestData.requirements || "LISTING");
      const requirementsEnforced = amazonTrim(
        requestData.requirementsEnforced || "ENFORCED",
      );
      const maxDefinitions = Math.max(
        0,
        Math.min(10, Number(requestData.maxDefinitions || 5)),
      );

      await writeAmazonSyncEvent({
        requestId,
        creator,
        eventType: "amazon/product_type_discovery_started",
        processor,
        source,
        payload: {
          mode,
          marketplaceId: config.marketplaceId,
          sellerId: config.sellerId,
          endpoint: config.endpoint,
          itemName,
          keywords,
          searchKey,
          requirements,
          requirementsEnforced,
          maxDefinitions,
        },
      });

      await writeBroadcastAction({
        action: {
          type: "amazonCatalog/begin_product_type_discovery",
          payload: {
            requestId,
            mode,
            marketplaceId: config.marketplaceId,
            sellerId: config.sellerId,
            searchKey,
            requestedAtMs: startMs,
          },
        },
        creator: broadcastCreator,
        atMs: startMs,
      });

      const accessToken = await fetchAmazonLwaAccessToken(config);
      const responses = [];

      async function writeApiCallEvent({ requestType, key, response }) {
        await writeAmazonSyncEvent({
          requestId,
          creator,
          eventType: "amazon/product_type_discovery_api_call",
          processor,
          source,
          payload: {
            requestType,
            endpoint: response.url,
            success: !!response.ok,
            response: response.data,
            context: {
              key,
              status: response.status,
              statusText: response.statusText,
              rateLimit: response.rateLimit,
              marketplaceId: config.marketplaceId,
              sellerId: config.sellerId,
              requirements,
              requirementsEnforced,
            },
          },
        });
      }

      const searchResponse = await searchAmazonProductTypes({
        config,
        itemName,
        keywords,
        accessToken,
        locale,
        searchLocale,
      });
      await writeApiCallEvent({
        requestType: "product_type_search",
        key: searchKey,
        response: searchResponse,
      });
      responses.push(
        makeAmazonRawResponseRecord({
          requestId,
          kind: "product_type_search",
          key: searchKey,
          marketplaceId: config.marketplaceId,
          sellerId: config.sellerId,
          endpoint: config.endpoint,
          response: searchResponse,
          fetchedAtMs: Date.now(),
        }),
      );

      if (!searchResponse.ok) {
        await writeBroadcastAction({
          action: {
            type: "amazonCatalog/apply_product_type_discovery_result",
            payload: {
              requestId,
              mode,
              marketplaceId: config.marketplaceId,
              sellerId: config.sellerId,
              searchKey,
              responses,
            },
          },
          creator: broadcastCreator,
          atMs: startMs + 1,
        });
        throw new Error(
          `Amazon product type search failed (${searchResponse.status} ${searchResponse.statusText})`,
        );
      }

      const productTypes = extractAmazonProductTypeNames(
        searchResponse.data,
        maxDefinitions,
      );
      for (const productType of productTypes) {
        const definitionResponse = await getAmazonProductTypeDefinition({
          config,
          productType,
          requirements,
          accessToken,
          locale,
          requirementsEnforced,
        });
        await writeApiCallEvent({
          requestType: "product_type_definition",
          key: productType,
          response: definitionResponse,
        });
        responses.push(
          makeAmazonRawResponseRecord({
            requestId,
            kind: "product_type_definition",
            key: productType,
            marketplaceId: config.marketplaceId,
            sellerId: config.sellerId,
            endpoint: config.endpoint,
            response: definitionResponse,
            fetchedAtMs: Date.now(),
          }),
        );

        if (definitionResponse.ok) {
          const schemaResponse = await fetchAmazonProductTypeSchemaResponse(
            definitionResponse.data,
          );
          if (schemaResponse) {
            await writeApiCallEvent({
              requestType: "product_type_schema",
              key: productType,
              response: schemaResponse,
            });
            responses.push(
              makeAmazonRawResponseRecord({
                requestId,
                kind: "product_type_schema",
                key: productType,
                marketplaceId: config.marketplaceId,
                sellerId: config.sellerId,
                endpoint: config.endpoint,
                response: schemaResponse,
                fetchedAtMs: Date.now(),
              }),
            );
          }
        }
      }

      await writeBroadcastAction({
        action: {
          type: "amazonCatalog/apply_product_type_discovery_result",
          payload: {
            requestId,
            mode,
            marketplaceId: config.marketplaceId,
            sellerId: config.sellerId,
            searchKey,
            responses,
          },
        },
        creator: broadcastCreator,
        atMs: startMs + 1,
      });

      await writeBroadcastAction({
        action: {
          type: "amazonCatalog/complete_product_type_discovery",
          payload: {
            requestId,
            mode,
            marketplaceId: config.marketplaceId,
            sellerId: config.sellerId,
            searchKey,
            completedAtMs: Date.now(),
          },
        },
        creator: broadcastCreator,
        atMs: startMs + 2,
      });

      await writeAmazonSyncEvent({
        requestId,
        creator,
        eventType: "amazon/product_type_discovery_completed",
        processor,
        source,
        payload: {
          mode,
          marketplaceId: config.marketplaceId,
          sellerId: config.sellerId,
          itemName,
          keywords,
          searchKey,
          productTypes,
          responseCount: responses.length,
        },
      });

      logger.info("Amazon product type discovery completed", {
        requestId,
        creator,
        processor,
        searchKey,
        productTypes,
        responseCount: responses.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Failed processing Amazon product type discovery request", {
        requestId,
        creator,
        processor,
        searchKey,
        error: message,
      });
      await writeAmazonSyncEvent({
        requestId,
        creator,
        eventType: "amazon/product_type_discovery_failed",
        processor,
        source,
        payload: {
          errorCode: "amazon_product_type_discovery_failed",
          errorMessage: message,
          message,
          mode,
          marketplaceId: config.marketplaceId,
          sellerId: config.sellerId,
          searchKey,
        },
      });
      await writeBroadcastAction({
        action: {
          type: "amazonCatalog/fail_product_type_discovery",
          payload: {
            requestId,
            mode,
            marketplaceId: config.marketplaceId,
            sellerId: config.sellerId,
            searchKey,
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

exports.amazonListingRestrictionsRequest = onDocumentCreated(
  {
    document: `${AMAZON_LISTING_RESTRICTIONS_REQUEST_COLLECTION}/{requestId}`,
    timeoutSeconds: 120,
    memory: "512MiB",
    concurrency: 1,
    maxInstances: 2,
  },
  async (event) => {
    const requestData = event.data?.data();
    if (!requestData) return;

    const requestId = trimString(event.params?.requestId);
    const creator = trimString(requestData.creator);
    const processor = `function:${process.env.K_SERVICE || "amazonListingRestrictionsRequest"}`;
    const eventType = trimString(requestData.eventType);
    if (
      eventType &&
      eventType !== "amazon/listing_restrictions_requested" &&
      eventType !== "listing_restrictions_requested"
    ) {
      return;
    }

    const asin = amazonTrim(requestData.asin).toUpperCase();
    const conditionType = amazonTrim(requestData.conditionType || "new_new");
    const restrictionKey = `${asin}:${conditionType}`;

    if (!requestId || !creator || !asin) {
      logger.error("Invalid Amazon listing restrictions request shape", {
        requestId,
        creator,
        asin,
        conditionType,
      });
      return;
    }

    const broadcastCreator = "amazon-listing-restrictions-function";
    const startMs = Date.now();
    const source = trimString(requestData.source || "amazon-listings-page");
    const mode = "listing_restrictions";
    let config = {
      endpoint: "",
      marketplaceId: "",
      sellerId: "",
      userAgent: "",
    };

    await writeAmazonSyncEvent({
      requestId,
      creator,
      eventType: "amazon/listing_restrictions_requested",
      processor,
      source,
      payload: {
        asin,
        conditionType,
        restrictionKey,
      },
    });

    try {
      config = getAmazonConfig();
      if (!config.sellerId) {
        throw new Error(
          "Missing AMAZON_SELLER_ID. Set it to fetch Amazon listing restrictions.",
        );
      }

      const reasonLocale =
        amazonTrim(requestData.reasonLocale || "en_GB") || "en_GB";

      await writeAmazonSyncEvent({
        requestId,
        creator,
        eventType: "amazon/listing_restrictions_started",
        processor,
        source,
        payload: {
          mode,
          marketplaceId: config.marketplaceId,
          sellerId: config.sellerId,
          endpoint: config.endpoint,
          asin,
          conditionType,
          reasonLocale,
          restrictionKey,
        },
      });

      await writeBroadcastAction({
        action: {
          type: "amazonCatalog/begin_listing_restrictions",
          payload: {
            requestId,
            mode,
            marketplaceId: config.marketplaceId,
            sellerId: config.sellerId,
            restrictionKey,
            requestedAtMs: startMs,
          },
        },
        creator: broadcastCreator,
        atMs: startMs,
      });

      const accessToken = await fetchAmazonLwaAccessToken(config);
      const response = await getAmazonListingRestrictions({
        config,
        asin,
        conditionType,
        reasonLocale,
        accessToken,
      });

      await writeAmazonSyncEvent({
        requestId,
        creator,
        eventType: "amazon/listing_restrictions_api_call",
        processor,
        source,
        payload: {
          requestType: "listing_restrictions",
          endpoint: response.url,
          success: !!response.ok,
          response: response.data,
          context: {
            key: restrictionKey,
            asin,
            conditionType,
            status: response.status,
            statusText: response.statusText,
            rateLimit: response.rateLimit,
            marketplaceId: config.marketplaceId,
            sellerId: config.sellerId,
          },
        },
      });

      const responses = [
        makeAmazonRawResponseRecord({
          requestId,
          kind: "listing_restrictions",
          key: restrictionKey,
          marketplaceId: config.marketplaceId,
          sellerId: config.sellerId,
          endpoint: config.endpoint,
          response,
          fetchedAtMs: Date.now(),
        }),
      ];

      await writeBroadcastAction({
        action: {
          type: "amazonCatalog/apply_listing_restrictions_result",
          payload: {
            requestId,
            mode,
            marketplaceId: config.marketplaceId,
            sellerId: config.sellerId,
            restrictionKey,
            responses,
          },
        },
        creator: broadcastCreator,
        atMs: startMs + 1,
      });

      if (!response.ok) {
        throw new Error(
          `Amazon listing restrictions check failed (${response.status} ${response.statusText})`,
        );
      }

      await writeBroadcastAction({
        action: {
          type: "amazonCatalog/complete_listing_restrictions",
          payload: {
            requestId,
            mode,
            marketplaceId: config.marketplaceId,
            sellerId: config.sellerId,
            restrictionKey,
            completedAtMs: Date.now(),
          },
        },
        creator: broadcastCreator,
        atMs: startMs + 2,
      });

      await writeAmazonSyncEvent({
        requestId,
        creator,
        eventType: "amazon/listing_restrictions_completed",
        processor,
        source,
        payload: {
          mode,
          marketplaceId: config.marketplaceId,
          sellerId: config.sellerId,
          asin,
          conditionType,
          restrictionKey,
          responseCount: responses.length,
        },
      });

      logger.info("Amazon listing restrictions check completed", {
        requestId,
        creator,
        processor,
        asin,
        conditionType,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Failed processing Amazon listing restrictions request", {
        requestId,
        creator,
        processor,
        asin,
        conditionType,
        error: message,
      });
      await writeAmazonSyncEvent({
        requestId,
        creator,
        eventType: "amazon/listing_restrictions_failed",
        processor,
        source,
        payload: {
          errorCode: "amazon_listing_restrictions_failed",
          errorMessage: message,
          message,
          mode,
          marketplaceId: config.marketplaceId,
          sellerId: config.sellerId,
          asin,
          conditionType,
          restrictionKey,
        },
      });
      await writeBroadcastAction({
        action: {
          type: "amazonCatalog/fail_listing_restrictions",
          payload: {
            requestId,
            mode,
            marketplaceId: config.marketplaceId,
            sellerId: config.sellerId,
            restrictionKey,
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

exports.amazonListingCreateRequest = onDocumentCreated(
  {
    document: `${AMAZON_LISTING_CREATE_REQUEST_COLLECTION}/{requestId}`,
    timeoutSeconds: 300,
    memory: "512MiB",
    concurrency: 1,
    maxInstances: 2,
  },
  async (event) => {
    const requestData = event.data?.data();
    if (!requestData) return;

    const requestId = trimString(event.params?.requestId);
    const creator = trimString(requestData.creator);
    const processor = `function:${process.env.K_SERVICE || "amazonListingCreateRequest"}`;
    const eventType = trimString(requestData.eventType);
    if (
      eventType &&
      eventType !== "amazon/listing_create_requested" &&
      eventType !== "listing_create_requested"
    ) {
      return;
    }

    const handle = amazonTrim(requestData.handle);
    const productType = amazonTrim(requestData.productType).toUpperCase();
    const requirements = amazonTrim(requestData.requirements || "LISTING");
    const payload =
      requestData.payload && typeof requestData.payload === "object"
        ? requestData.payload
        : {};
    const submissions = normalizeAmazonListingCreateSubmissions({
      payload,
      fallbackProductType: productType,
      fallbackRequirements: requirements,
    });
    const skus = submissions.map((submission) => submission.sku);

    if (
      !requestId ||
      !creator ||
      !handle ||
      !productType ||
      !submissions.length
    ) {
      logger.error("Invalid Amazon listing create request shape", {
        requestId,
        creator,
        handle,
        productType,
        submissionCount: submissions.length,
      });
      return;
    }

    const broadcastCreator = "amazon-listing-create-function";
    const startMs = Date.now();
    const source = trimString(requestData.source || "amazon-listings-page");
    const mode = "listing_create";
    let config = {
      endpoint: "",
      marketplaceId: "",
      sellerId: "",
      userAgent: "",
    };

    await writeAmazonSyncEvent({
      requestId,
      creator,
      eventType: "amazon/listing_create_requested",
      processor,
      source,
      payload: {
        handle,
        skus,
        submissionCount: submissions.length,
        productType,
        requirements,
        itemKey: trimString(requestData.itemKey),
      },
    });

    try {
      config = getAmazonConfig();
      if (!config.sellerId) {
        throw new Error(
          "Missing AMAZON_SELLER_ID. Set it to create Amazon seller listings.",
        );
      }

      const locale = amazonTrim(requestData.locale || "");
      const listingIncludedData = cleanAmazonIncludedData(
        requestData.listingIncludedData,
        AMAZON_DEFAULT_LISTINGS_INCLUDED_DATA,
      );

      await writeAmazonSyncEvent({
        requestId,
        creator,
        eventType: "amazon/listing_create_started",
        processor,
        source,
        payload: {
          mode,
          marketplaceId: config.marketplaceId,
          sellerId: config.sellerId,
          endpoint: config.endpoint,
          handle,
          skus,
          submissionCount: submissions.length,
          productType,
          requirements,
        },
      });

      await writeBroadcastAction({
        action: {
          type: "amazonCatalog/begin_listing_write",
          payload: {
            requestId,
            mode,
            marketplaceId: config.marketplaceId,
            sellerId: config.sellerId,
            handle,
            skus,
            requestedAtMs: startMs,
          },
        },
        creator: broadcastCreator,
        atMs: startMs,
      });

      const accessToken = await fetchAmazonLwaAccessToken(config);
      const responses = [];
      const submissionErrors = [];

      async function writeApiCallEvent({
        requestType,
        key,
        response,
        request,
      }) {
        await writeAmazonSyncEvent({
          requestId,
          creator,
          eventType: "amazon/listing_create_api_call",
          processor,
          source,
          payload: {
            requestType,
            endpoint: response.url,
            success: !!response.ok,
            request: request || null,
            response: response.data,
            context: {
              key,
              status: response.status,
              statusText: response.statusText,
              rateLimit: response.rateLimit,
              marketplaceId: config.marketplaceId,
              sellerId: config.sellerId,
              productType,
              requirements,
            },
          },
        });
      }

      for (const submission of submissions) {
        const putRequest = {
          role: submission.role,
          itemKey: submission.itemKey,
          productType: submission.productType,
          requirements: submission.requirements,
          attributes: submission.payload?.attributes || {},
        };
        const putResponse = await putAmazonListingBySku({
          config,
          sku: submission.sku,
          productType: submission.productType,
          requirements: submission.requirements,
          payload: submission.payload,
          accessToken,
          locale,
        });
        await writeApiCallEvent({
          requestType: "seller_listing_put",
          key: submission.sku,
          response: putResponse,
          request: putRequest,
        });
        responses.push(
          makeAmazonRawResponseRecord({
            requestId,
            kind: "seller_listing_put",
            key: submission.sku,
            marketplaceId: config.marketplaceId,
            sellerId: config.sellerId,
            endpoint: config.endpoint,
            response: putResponse,
            fetchedAtMs: Date.now(),
          }),
        );

        const submissionError = getAmazonListingSubmissionError(
          putResponse.data,
        );
        if (!putResponse.ok || submissionError) {
          submissionErrors.push({
            sku: submission.sku,
            message:
              submissionError ||
              `Amazon listing create failed (${putResponse.status} ${putResponse.statusText})`,
          });
          break;
        }

        const listingResponse = await getAmazonListingBySku({
          config,
          sku: submission.sku,
          includedData: listingIncludedData,
          accessToken,
          locale,
        });
        await writeApiCallEvent({
          requestType: "seller_listing_get_by_sku",
          key: submission.sku,
          response: listingResponse,
        });
        responses.push(
          makeAmazonRawResponseRecord({
            requestId,
            kind: "seller_listing_get_by_sku",
            key: submission.sku,
            marketplaceId: config.marketplaceId,
            sellerId: config.sellerId,
            endpoint: config.endpoint,
            response: listingResponse,
            fetchedAtMs: Date.now(),
          }),
        );
      }

      await writeBroadcastAction({
        action: {
          type: "amazonCatalog/apply_listing_write_result",
          payload: {
            requestId,
            mode,
            marketplaceId: config.marketplaceId,
            sellerId: config.sellerId,
            handle,
            skus,
            responses,
          },
        },
        creator: broadcastCreator,
        atMs: startMs + 1,
      });

      if (submissionErrors.length > 0) {
        const message = submissionErrors
          .map((error) => `${error.sku}: ${error.message}`)
          .join("; ");
        await writeBroadcastAction({
          action: {
            type: "amazonCatalog/fail_listing_write",
            payload: {
              requestId,
              mode,
              marketplaceId: config.marketplaceId,
              sellerId: config.sellerId,
              handle,
              skus,
              failedAtMs: Date.now(),
              errorMessage: message,
            },
          },
          creator: broadcastCreator,
          atMs: startMs + 2,
        });

        await writeAmazonSyncEvent({
          requestId,
          creator,
          eventType: "amazon/listing_create_failed",
          processor,
          source,
          payload: {
            errorCode: "amazon_listing_create_rejected",
            errorMessage: message,
            message,
            mode,
            marketplaceId: config.marketplaceId,
            sellerId: config.sellerId,
            handle,
            skus,
            productType,
            requirements,
            responseCount: responses.length,
          },
        });

        logger.warn("Amazon listing create rejected", {
          requestId,
          creator,
          processor,
          handle,
          skus,
          productType,
          submissionErrors,
        });
        return;
      }

      await writeBroadcastAction({
        action: {
          type: "amazonCatalog/complete_listing_write",
          payload: {
            requestId,
            mode,
            marketplaceId: config.marketplaceId,
            sellerId: config.sellerId,
            handle,
            skus,
            completedAtMs: Date.now(),
          },
        },
        creator: broadcastCreator,
        atMs: startMs + 2,
      });

      await writeAmazonSyncEvent({
        requestId,
        creator,
        eventType: "amazon/listing_create_completed",
        processor,
        source,
        payload: {
          mode,
          marketplaceId: config.marketplaceId,
          sellerId: config.sellerId,
          handle,
          skus,
          productType,
          requirements,
          success: true,
          responseCount: responses.length,
        },
      });

      logger.info("Amazon listing create completed", {
        requestId,
        creator,
        processor,
        handle,
        skus,
        productType,
        success: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Failed processing Amazon listing create request", {
        requestId,
        creator,
        processor,
        handle,
        skus,
        productType,
        error: message,
      });
      await writeAmazonSyncEvent({
        requestId,
        creator,
        eventType: "amazon/listing_create_failed",
        processor,
        source,
        payload: {
          errorCode: "amazon_listing_create_failed",
          errorMessage: message,
          message,
          mode,
          marketplaceId: config.marketplaceId,
          sellerId: config.sellerId,
          handle,
          skus,
          productType,
        },
      });
      await writeBroadcastAction({
        action: {
          type: "amazonCatalog/fail_listing_write",
          payload: {
            requestId,
            mode,
            marketplaceId: config.marketplaceId,
            sellerId: config.sellerId,
            handle,
            skus,
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

    // Shopify webhooks always provide a raw body. In Firebase Functions,
    // it's available as req.rawBody. We must use it for HMAC verification
    // to avoid issues with JSON re-serialization.
    if (!req.rawBody) {
      logger.error("Missing rawBody for HMAC verification", {
        topic,
        webhookId,
      });
      return res.status(400).send("Bad Request: Missing Raw Body");
    }

    if (
      !shopifyOrderLogic.verifyShopifyHmac(
        req.rawBody,
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

      // 3. Atomically Deduplication (Finding 4)
      const eventRef = db.collection("shopify_order_events").doc(webhookId);
      try {
        await eventRef.create({ processedAt: FieldValue.serverTimestamp() });
      } catch (e) {
        // e.code 6 is ALREADY_EXISTS
        if (e.code === 6 || e.message?.includes("already exists")) {
          logger.info("Duplicate webhook received", { webhookId });
          return res.status(200).send("Duplicate");
        }
        throw e;
      }

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
      let nextCursor = lastCursor;
      let fetchedCount = 0;
      let writtenCount = 0;
      let skippedDuplicateCount = 0;
      const headers = await shopifyCore.buildShopifyHeaders(config);

      const params = new URLSearchParams({
        updated_at_min: lastCursor,
        status: "any",
        limit: "250",
      });
      let endpoint = `https://${storeUrl}/admin/api/${apiVersion}/orders.json?${params.toString()}`;

      while (endpoint) {
        const response = await fetch(endpoint, { headers });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(
            `Shopify fetch failed (${response.status}): ${text.slice(0, 500)}`,
          );
        }

        const json = await response.json();
        const orders = Array.isArray(json?.orders) ? json.orders : [];
        fetchedCount += orders.length;

        for (const order of orders) {
          const action = {
            type: "shopify_order_reconciled",
            payload: { raw: order, topic: "reconcile" },
          };
          const documentId = shopifyReconcileBroadcastDocumentId(order);
          const result = await writeBroadcastActionOnce({
            action,
            creator: "shopify-reconcile-poller",
            documentId,
          });
          if (result.written) {
            writtenCount += 1;
          } else {
            skippedDuplicateCount += 1;
          }

          if (order.updated_at > nextCursor) {
            nextCursor = order.updated_at;
          }
        }

        // Advance to next page (Finding 5)
        endpoint = shopifyCore.parseNextLink(response.headers.get("Link"));
      }

      if (nextCursor !== lastCursor) {
        await stateRef.set(
          {
            lastOrderUpdatedAtCursor: nextCursor,
            lastRunAt: Date.now(),
          },
          { merge: true },
        );
      }
      logger.info("Shopify order reconciliation complete", {
        fetchedCount,
        writtenCount,
        skippedDuplicateCount,
      });
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

exports.etsyOrderWebhook = onRequest(
  {
    timeoutSeconds: 30,
    memory: "512MiB",
    concurrency: 10,
  },
  async (req, res) => {
    const signature = req.headers["x-etsy-signature"];
    const webhookId = req.headers["x-etsy-event-id"];
    const webhookTimestamp = req.headers["x-etsy-timestamp"];
    const topic = req.body?.event_type || "receipt.updated";

    const config = getEtsyConfig();

    if (!req.rawBody) {
      logger.error("Missing rawBody for Etsy HMAC verification");
      return res.status(400).send("Bad Request: Missing Raw Body");
    }

    if (!webhookId || !webhookTimestamp) {
      logger.error("Missing headers for Etsy HMAC verification", {
        webhookId,
        webhookTimestamp,
      });
      return res.status(400).send("Bad Request: Missing required headers");
    }

    if (
      !etsyOrderLogic.verifyEtsyWebhookSignature(
        req.rawBody,
        signature,
        config.sharedSecret,
        webhookId,
        webhookTimestamp,
      )
    ) {
      logger.error("Etsy HMAC verification failed", { topic, webhookId });
      return res.status(401).send("Unauthorized");
    }

    try {
      // Raw Persistence
      await db.collection("etsy_order_webhooks").doc(webhookId).set({
        topic,
        payload: req.body,
        createdAt: FieldValue.serverTimestamp(),
      });

      // Atomically Deduplication (Finding 4)
      const eventRef = db.collection("etsy_order_events").doc(webhookId);
      try {
        await eventRef.create({ processedAt: FieldValue.serverTimestamp() });
      } catch (e) {
        if (e.code === 6) {
          // ALREADY_EXISTS
          logger.info("Duplicate Etsy webhook received", { webhookId });
          return res.status(200).send("Duplicate");
        }
        throw e;
      }

      // Identify Action Type
      let type = "etsy_unrecognized_topic";
      if (topic === "receipt.created") {
        type = "etsy_order_created";
      } else if (topic === "receipt.updated") {
        type = "etsy_order_updated";
      }

      // Dispatch
      await writeBroadcastAction({
        action: {
          type,
          payload: { raw: req.body.resource_data || req.body, topic },
        },
        creator: "etsy-webhook",
      });

      res.status(200).send("OK");
    } catch (error) {
      logger.error("Etsy Webhook processing failed", {
        webhookId,
        topic,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).send("Internal Error");
    }
  },
);

exports.etsyOrderReconcile = onSchedule(
  {
    schedule: "every 15 minutes",
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  async (event) => {
    const config = getEtsyConfig();
    const stateRef = db.collection("etsy_order_sync_state").doc("default");
    const stateSnap = await stateRef.get();
    const state = stateSnap.exists ? stateSnap.data() : {};

    // Tokens persisted in Firestore take precedence over .env values.
    // The function refreshes its own access+refresh pair on 401 and writes
    // the rotated pair back here so the next invocation reuses them.
    if (state.accessToken) config.accessToken = state.accessToken;
    if (state.refreshToken) config.refreshToken = state.refreshToken;

    const onTokensRefreshed = async (tokens) => {
      await stateRef.set(
        {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          tokensRefreshedAt: Date.now(),
        },
        { merge: true },
      );
      logger.info("Refreshed Etsy access token", {
        expiresIn: tokens.expiresIn,
      });
    };

    let lastCursor = state.lastReceiptModifiedTimestamp || 0;

    try {
      const receipts = await etsyOrderLogic.fetchChangedReceipts(
        config,
        lastCursor,
        onTokensRefreshed,
      );

      let newCursorMs = lastCursor * 1000;
      let writtenCount = 0;
      let skippedDuplicateCount = 0;
      for (const receipt of receipts) {
        const action = {
          type: "etsy_order_reconciled",
          payload: { raw: receipt, topic: "reconcile" },
        };
        const documentId = etsyReconcileBroadcastDocumentId(receipt);
        const result = await writeBroadcastActionOnce({
          action,
          creator: "etsy-reconcile-poller",
          documentId,
        });
        if (result.written) {
          writtenCount += 1;
        } else {
          skippedDuplicateCount += 1;
        }

        const modified = receipt.updated_timestamp || receipt.create_timestamp;
        if (modified * 1000 > newCursorMs) {
          newCursorMs = modified * 1000;
        }
      }

      await stateRef.set(
        {
          lastReceiptModifiedTimestamp: Math.floor(newCursorMs / 1000),
          lastRunAt: Date.now(),
        },
        { merge: true },
      );
      logger.info("Etsy order reconciliation complete", {
        fetchedCount: receipts.length,
        writtenCount,
        skippedDuplicateCount,
      });
    } catch (error) {
      logger.error("Etsy order reconciliation failed", error);
    }
  },
);
