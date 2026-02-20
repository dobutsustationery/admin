const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { setGlobalOptions, logger } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
setGlobalOptions({ maxInstances: 5 });

const db = getFirestore();

function normalizeStoreUrl(raw) {
  return String(raw || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

function toNumberOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  const parts = linkHeader.split(",").map((p) => p.trim());
  for (const part of parts) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part);
    if (match && match[1]) return match[1];
  }
  return null;
}

function toTagsString(tags) {
  if (!Array.isArray(tags)) return "";
  return tags
    .map((t) => String(t || "").trim())
    .filter(Boolean)
    .join(", ");
}

function mapStatus(input) {
  const status = String(input || "active");
  if (status === "archived") return "archived";
  if (status === "draft") return "draft";
  return "active";
}

async function writeBroadcastAction(creator, type, payload) {
  await db.collection("broadcast").add({
    type,
    payload,
    creator: creator || "shopify-sync-function",
    timestamp: FieldValue.serverTimestamp(),
  });
}

async function writeApiLog(creator, payload) {
  await writeBroadcastAction(creator, "shopify_api_log", {
    ...payload,
    timestamp: Date.now(),
  });
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const json = await res.json().catch(async () => ({ raw: await res.text() }));
  if (!res.ok) {
    throw new Error(`${url} failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

async function findProductByHandle(storeUrl, apiVersion, accessToken, handle) {
  let url = `https://${storeUrl}/admin/api/${apiVersion}/products.json?limit=250&status=any&fields=id,handle,variants`;

  while (url) {
    const res = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });
    const json = await res
      .json()
      .catch(async () => ({ raw: await res.text() }));
    if (!res.ok) {
      throw new Error(`Product lookup failed (${res.status}): ${JSON.stringify(json)}`);
    }

    const products = Array.isArray(json.products) ? json.products : [];
    const found = products.find((p) => String(p?.handle || "") === handle);
    if (found) return found;

    url = parseNextLink(res.headers.get("link"));
  }

  return null;
}

async function resolveLocationId(storeUrl, apiVersion, accessToken) {
  const url = `https://${storeUrl}/admin/api/${apiVersion}/locations.json?limit=250`;
  const json = await fetchJson(url, {
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
  });
  const first = Array.isArray(json.locations) ? json.locations[0] : null;
  const id = toNumberOrNull(first?.id);
  if (!id) throw new Error("No Shopify location found");
  return id;
}

async function upsertProductFromRequest(storeUrl, apiVersion, accessToken, requestPayload) {
  const handle = String(requestPayload?.handle || "").trim();
  const listing = requestPayload?.listing || {};
  const variants = Array.isArray(requestPayload?.variants) ? requestPayload.variants : [];
  if (!handle) throw new Error("Missing request payload handle");
  if (variants.length === 0) throw new Error("Request payload has no variants");

  const existing = await findProductByHandle(storeUrl, apiVersion, accessToken, handle);
  const existingVariantIdBySku = new Map();
  if (existing && Array.isArray(existing.variants)) {
    existing.variants.forEach((v) => {
      const sku = String(v?.sku || "").trim();
      const id = toNumberOrNull(v?.id);
      if (sku && id) existingVariantIdBySku.set(sku, id);
    });
  }

  const imagesPayload = (Array.isArray(listing.images) ? listing.images : [])
    .slice()
    .sort((a, b) => Number(a?.position || 0) - Number(b?.position || 0))
    .map((img, idx) => ({
      src: String(img?.url || ""),
      position: Number(img?.position || idx + 1),
      alt: String(img?.altText || ""),
    }))
    .filter((img) => !!img.src);

  const option1Name = String(listing.option1Name || "Subtype").trim() || "Subtype";

  const variantsPayload = variants.map((variant) => {
    const sku = String(variant?.sku || "").trim();
    const subtype = String(variant?.subtype || "").trim();
    const existingId = existingVariantIdBySku.get(sku);
    const payload = {
      sku,
      option1: subtype || "Default",
      price: String(Number(variant?.price || 0)),
      barcode: String(variant?.janCode || ""),
      grams: Number(variant?.weight || 0),
      weight: Number(variant?.weight || 0),
      weight_unit: "g",
      inventory_management: "shopify",
      inventory_policy: "deny",
      fulfillment_service: "manual",
      taxable: true,
      requires_shipping: true,
    };
    if (existingId) payload.id = existingId;
    return payload;
  });

  const productPayload = {
    handle,
    title: String(listing.title || "Untitled"),
    body_html: String(listing.bodyHtml || ""),
    vendor: String(listing.vendor || "SPNSS Ltd."),
    product_type: String(listing.productType || ""),
    tags: toTagsString(listing.tags),
    status: mapStatus(listing.status),
    options: [{ name: option1Name }],
    images: imagesPayload,
    variants: variantsPayload,
  };

  const endpoint = existing
    ? `https://${storeUrl}/admin/api/${apiVersion}/products/${existing.id}.json`
    : `https://${storeUrl}/admin/api/${apiVersion}/products.json`;

  const json = await fetchJson(endpoint, {
    method: existing ? "PUT" : "POST",
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      product: existing ? { id: existing.id, ...productPayload } : productPayload,
    }),
  });

  if (!json.product?.id) throw new Error(`Unexpected upsert response: ${JSON.stringify(json)}`);
  return json.product;
}

async function syncInventoryLevelsForRequest(
  storeUrl,
  apiVersion,
  accessToken,
  locationId,
  creator,
  requestPayload,
  product,
) {
  const requestId = String(requestPayload?.requestId || "");
  const handle = String(requestPayload?.handle || "");
  const variants = Array.isArray(requestPayload?.variants) ? requestPayload.variants : [];
  const responseVariantBySku = new Map();
  (Array.isArray(product?.variants) ? product.variants : []).forEach((variant) => {
    const sku = String(variant?.sku || "").trim();
    if (sku) responseVariantBySku.set(sku, variant);
  });

  for (const variant of variants) {
    const sku = String(variant?.sku || "").trim();
    const available = Math.max(0, Number(variant?.available || 0));
    if (!sku) continue;

    const shopifyVariant = responseVariantBySku.get(sku);
    const inventoryItemId = toNumberOrNull(shopifyVariant?.inventory_item_id);
    const endpoint = `/admin/api/${apiVersion}/inventory_levels/set.json`;

    if (!inventoryItemId) {
      await writeApiLog(creator, {
        requestType: "inventory_sync",
        endpoint,
        success: false,
        response: { error: "Missing inventory_item_id after product upsert" },
        context: { requestId, handle, sku, targetQty: available, locationId },
      });
      continue;
    }

    try {
      const response = await fetchJson(
        `https://${storeUrl}/admin/api/${apiVersion}/inventory_levels/set.json`,
        {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            location_id: locationId,
            inventory_item_id: inventoryItemId,
            available,
          }),
        },
      );

      await writeApiLog(creator, {
        requestType: "inventory_sync",
        endpoint,
        success: true,
        response,
        context: { requestId, handle, sku, targetQty: available, inventoryItemId, locationId },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeApiLog(creator, {
        requestType: "inventory_sync",
        endpoint,
        success: false,
        response: { error: message },
        context: { requestId, handle, sku, targetQty: available, inventoryItemId, locationId },
      });
    }
  }
}

async function requestAlreadyProcessed(requestId) {
  if (!requestId) return false;
  const snap = await db
    .collection("broadcast")
    .where("type", "==", "shopify_sync_listing_result")
    .where("payload.requestId", "==", requestId)
    .limit(1)
    .get();
  return !snap.empty;
}

exports.syncShopifyListingRequest = onDocumentCreated("broadcast/{actionId}", async (event) => {
  const action = event.data?.data();
  if (!action || action.type !== "shopify_sync_listing_request") return;

  const requestPayload = action.payload || {};
  const requestId = String(requestPayload.requestId || "");
  const handle = String(requestPayload.handle || "");
  const creator = String(action.creator || "shopify-sync-function");

  if (!requestId || !handle) {
    logger.error("Invalid shopify sync request payload", { requestPayload });
    return;
  }

  if (await requestAlreadyProcessed(requestId)) {
    logger.info("Skipping already processed request", { requestId, handle });
    return;
  }

  const rawStoreUrl = process.env.SHOPIFY_STORE_URL || "";
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN || "";
  const apiVersion = process.env.SHOPIFY_API_VERSION || "2024-01";
  const storeUrl = normalizeStoreUrl(rawStoreUrl);

  if (!storeUrl || !accessToken) {
    await writeApiLog(creator, {
      requestType: "product_update",
      endpoint: `/admin/api/${apiVersion}/products`,
      success: false,
      response: { error: "Missing SHOPIFY_STORE_URL or SHOPIFY_ACCESS_TOKEN in function env" },
      context: { requestId, handle },
    });
    return;
  }

  try {
    const locationId = await resolveLocationId(storeUrl, apiVersion, accessToken);
    const product = await upsertProductFromRequest(
      storeUrl,
      apiVersion,
      accessToken,
      requestPayload,
    );

    await writeApiLog(creator, {
      requestType: "product_update",
      endpoint: `/admin/api/${apiVersion}/products`,
      success: true,
      response: { productId: product.id, handle: product.handle, variantCount: product.variants?.length || 0 },
      context: { requestId, handle, productId: product.id, locationId },
    });

    await syncInventoryLevelsForRequest(
      storeUrl,
      apiVersion,
      accessToken,
      locationId,
      creator,
      requestPayload,
      product,
    );

    await writeBroadcastAction(creator, "shopify_sync_listing_result", {
      requestId,
      handle,
      success: true,
      timestamp: Date.now(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeApiLog(creator, {
      requestType: "product_update",
      endpoint: `/admin/api/${apiVersion}/products`,
      success: false,
      response: { error: message },
      context: { requestId, handle },
    });

    await writeBroadcastAction(creator, "shopify_sync_listing_result", {
      requestId,
      handle,
      success: false,
      error: message,
      timestamp: Date.now(),
    });
  }
});
