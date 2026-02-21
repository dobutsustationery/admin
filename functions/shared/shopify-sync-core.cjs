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

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const json = await res.json().catch(async () => ({ raw: await res.text() }));
  if (!res.ok) {
    throw new Error(`${url} failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

async function findProductByHandle(config, handle) {
  const { storeUrl, apiVersion, accessToken } = config;
  let url = `https://${storeUrl}/admin/api/${apiVersion}/products.json?limit=250&status=any&fields=id,handle,variants`;

  while (url) {
    const res = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

    const json = await res.json().catch(async () => ({ raw: await res.text() }));
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

async function resolveLocationId(config) {
  if (config.locationId && Number.isFinite(Number(config.locationId))) {
    return Number(config.locationId);
  }

  const { storeUrl, apiVersion, accessToken } = config;
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

function buildProductPayload(requestPayload, existingProduct) {
  const handle = String(requestPayload?.handle || "").trim();
  const listing = requestPayload?.listing || {};
  const variants = Array.isArray(requestPayload?.variants) ? requestPayload.variants : [];

  if (!handle) throw new Error("Missing request payload handle");
  if (variants.length === 0) throw new Error("Request payload has no variants");

  const existingVariantIdBySku = new Map();
  if (existingProduct && Array.isArray(existingProduct.variants)) {
    existingProduct.variants.forEach((v) => {
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

  return {
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
}

async function upsertProductFromRequest(config, requestPayload) {
  const { storeUrl, apiVersion, accessToken } = config;
  const handle = String(requestPayload?.handle || "").trim();

  const existing = await findProductByHandle(config, handle);
  const productPayload = buildProductPayload(requestPayload, existing);

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

  if (!json.product?.id) {
    throw new Error(`Unexpected upsert response: ${JSON.stringify(json)}`);
  }

  return json.product;
}

async function setInventoryLevel(config, locationId, inventoryItemId, available) {
  const { storeUrl, apiVersion, accessToken } = config;
  return fetchJson(`https://${storeUrl}/admin/api/${apiVersion}/inventory_levels/set.json`, {
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
  });
}

async function fetchAllVariantsBySku(config) {
  const { storeUrl, apiVersion, accessToken } = config;
  const variantsBySku = new Map();
  let url = `https://${storeUrl}/admin/api/${apiVersion}/products.json?limit=250&status=active&fields=id,handle,variants`;

  while (url) {
    const res = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

    const json = await res.json().catch(async () => ({ raw: await res.text() }));
    if (!res.ok) {
      throw new Error(`Shopify products fetch failed (${res.status}): ${JSON.stringify(json)}`);
    }

    const products = Array.isArray(json.products) ? json.products : [];
    for (const product of products) {
      const productHandle = String(product?.handle || "");
      const variants = Array.isArray(product?.variants) ? product.variants : [];
      for (const variant of variants) {
        const sku = String(variant?.sku || "").trim();
        if (!sku) continue;
        variantsBySku.set(sku, {
          sku,
          productId: Number(product?.id),
          productHandle,
          variantId: Number(variant?.id),
          inventoryItemId: toNumberOrNull(variant?.inventory_item_id),
          inventoryQuantity: toNumberOrNull(variant?.inventory_quantity),
        });
      }
    }

    url = parseNextLink(res.headers.get("link"));
  }

  return variantsBySku;
}

module.exports = {
  normalizeStoreUrl,
  toNumberOrNull,
  parseNextLink,
  toTagsString,
  mapStatus,
  fetchJson,
  findProductByHandle,
  resolveLocationId,
  buildProductPayload,
  upsertProductFromRequest,
  setInventoryLevel,
  fetchAllVariantsBySku,
};
