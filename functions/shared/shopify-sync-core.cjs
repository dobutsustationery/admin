function normalizeStoreUrl(raw) {
  return String(raw || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

function normalizeString(value) {
  return String(value || "").trim();
}

function extractGoogleDriveFileId(rawUrl) {
  const value = normalizeString(rawUrl);
  if (!value) return "";
  if (/^[a-zA-Z0-9_-]{10,}$/.test(value)) return value;
  const apiMatch = /\/drive\/v3\/files\/([a-zA-Z0-9_-]+)/.exec(value);
  if (apiMatch && apiMatch[1]) return apiMatch[1];
  const pathMatch = /\/file\/d\/([a-zA-Z0-9_-]+)/.exec(value);
  if (pathMatch && pathMatch[1]) return pathMatch[1];
  const lh3PathMatch = /\/d\/([a-zA-Z0-9_-]+)/.exec(value);
  if (lh3PathMatch && lh3PathMatch[1]) return lh3PathMatch[1];
  const idMatch = /[?&]id=([a-zA-Z0-9_-]+)/.exec(value);
  if (idMatch && idMatch[1]) return idMatch[1];
  return "";
}

function toGoogleDrivePublicImageUrl(rawUrl) {
  const value = normalizeString(rawUrl);
  if (!value) return "";
  const fileId = extractGoogleDriveFileId(value);
  if (!fileId) return value;
  return `https://lh3.googleusercontent.com/d/${fileId}=s0`;
}

const tokenCache = new Map();

function getTokenCacheKey(config) {
  return `${normalizeString(config?.storeUrl)}|${normalizeString(config?.clientId)}`;
}

function hasStaticAccessToken(config) {
  return !!normalizeString(config?.accessToken);
}

function hasClientCredentials(config) {
  return !!normalizeString(config?.clientId) && !!normalizeString(config?.clientSecret);
}

function hasAnyCredentials(config) {
  return hasStaticAccessToken(config) || hasClientCredentials(config);
}

async function fetchAppAccessToken(config) {
  const storeUrl = normalizeString(config?.storeUrl);
  const clientId = normalizeString(config?.clientId);
  const clientSecret = normalizeString(config?.clientSecret);
  if (!storeUrl || !clientId || !clientSecret) {
    throw new Error("Missing SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET");
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const url = `https://${storeUrl}/admin/oauth/access_token`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const json = await res.json().catch(async () => ({ raw: await res.text() }));
  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}): ${JSON.stringify(json)}`);
  }

  const token = normalizeString(json?.access_token);
  if (!token) {
    throw new Error(`Token exchange response missing access_token: ${JSON.stringify(json)}`);
  }

  const expiresInSec = Number(json?.expires_in || 0);
  const expiresAtMs = Number.isFinite(expiresInSec) && expiresInSec > 0
    ? Date.now() + expiresInSec * 1000
    : 0;

  return { token, expiresAtMs };
}

async function resolveAccessToken(config) {
  const staticToken = normalizeString(config?.accessToken);
  if (staticToken) return staticToken;

  if (!hasClientCredentials(config)) {
    throw new Error(
      "Missing Shopify credentials: set SHOPIFY_ACCESS_TOKEN or SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET",
    );
  }

  const key = getTokenCacheKey(config);
  const cached = tokenCache.get(key);
  if (cached?.token) {
    const refreshBufferMs = 60 * 1000;
    if (!cached.expiresAtMs || Date.now() < cached.expiresAtMs - refreshBufferMs) {
      return cached.token;
    }
  }

  const next = await fetchAppAccessToken(config);
  tokenCache.set(key, next);
  return next.token;
}

async function buildShopifyHeaders(config) {
  const accessToken = await resolveAccessToken(config);
  return {
    "X-Shopify-Access-Token": accessToken,
    "Content-Type": "application/json",
  };
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
  const parts = String(linkHeader)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  for (const part of parts) {
    const segments = part.split(";").map((s) => s.trim());
    const urlMatch = /^<([^>]+)>$/.exec(segments[0] || "");
    if (!urlMatch || !urlMatch[1]) continue;

    const relSegment = segments.find((s) => s.startsWith("rel="));
    if (!relSegment) continue;

    const relValue = relSegment
      .slice(4)
      .trim()
      .replace(/^"|"$/g, "");
    if (relValue === "next") return urlMatch[1];
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
  const status = String(input || "active").trim().toLowerCase();
  if (status === "archived") return "archived";
  if (status === "draft") return "draft";
  return "active";
}

function normalizeImageKey(rawUrl) {
  const value = normalizeString(rawUrl);
  if (!value) return "";
  const driveId = extractGoogleDriveFileId(value);
  if (driveId) return `drive:${driveId}`;
  return value.replace(/[#?].*$/, "");
}

function buildGalleryImageEntries(requestPayload) {
  const listing = requestPayload?.listing || {};
  const listingImages = (Array.isArray(listing?.images) ? listing.images : [])
    .slice()
    .sort((a, b) => Number(a?.position || 0) - Number(b?.position || 0));

  const entries = [];
  const keyToIndex = new Map();

  const pushImage = (rawUrl, altText) => {
    const src = toGoogleDrivePublicImageUrl(String(rawUrl || ""));
    const key = normalizeImageKey(src);
    if (!src || !key) return;
    const existingIdx = keyToIndex.get(key);
    if (existingIdx !== undefined) {
      if (!entries[existingIdx].alt && altText) {
        entries[existingIdx].alt = String(altText || "");
      }
      return;
    }
    const next = {
      key,
      src,
      alt: String(altText || ""),
    };
    keyToIndex.set(key, entries.length);
    entries.push(next);
  };

  listingImages.forEach((img) => {
    pushImage(img?.url, img?.altText);
  });

  return entries.map((entry, idx) => ({
    ...entry,
    position: idx + 1,
  }));
}

function buildVariantAttachmentEntries(requestPayload) {
  const variants = Array.isArray(requestPayload?.variants) ? requestPayload.variants : [];
  const entries = [];
  variants.forEach((variant) => {
    const sku = String(variant?.sku || "").trim();
    const subtype = String(variant?.subtype || "").trim();
    const src = toGoogleDrivePublicImageUrl(String(variant?.image || ""));
    const key = normalizeImageKey(src);
    if (!sku || !src || !key) return;
    entries.push({
      sku,
      key,
      src,
      alt: subtype || sku,
    });
  });
  return entries;
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const json = await res.json().catch(async () => ({ raw: await res.text() }));
  if (!res.ok) {
    throw new Error(`${url} failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json;
}

function extractNumericId(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value || "").trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text);
  const gidMatch = /\/(\d+)$/.exec(text);
  if (gidMatch && gidMatch[1]) return Number(gidMatch[1]);
  return null;
}

async function fetchGraphql(config, query, variables = {}) {
  const { storeUrl, apiVersion } = config;
  const url = `https://${storeUrl}/admin/api/${apiVersion}/graphql.json`;
  const headers = await buildShopifyHeaders(config);
  const json = await fetchJson(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  if (Array.isArray(json?.errors) && json.errors.length > 0) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json?.data || {};
}

function toShopifyProductGid(productId) {
  const id = extractNumericId(productId);
  if (!id) return "";
  return `gid://shopify/Product/${id}`;
}

function pickOnlineStorePublication(publications) {
  const nodes = Array.isArray(publications) ? publications : [];
  const normalized = nodes.map((p) => ({
    id: String(p?.id || ""),
    name: String(p?.name || "").trim(),
  }));
  return (
    normalized.find((p) => p.id && p.name.toLowerCase() === "online store") ||
    normalized.find((p) => p.id && p.name.toLowerCase().includes("online store")) ||
    null
  );
}

async function listShopifyPublications(config) {
  const data = await fetchGraphql(
    config,
    `
      query ListPublications {
        publications(first: 50) {
          nodes {
            id
            name
          }
        }
      }
    `,
    {},
  );
  return Array.isArray(data?.publications?.nodes) ? data.publications.nodes : [];
}

async function ensureProductPublishedToOnlineStore(config, productId) {
  const productGid = toShopifyProductGid(productId);
  if (!productGid) {
    throw new Error(`Invalid Shopify product id: ${JSON.stringify(productId)}`);
  }

  const publications = await listShopifyPublications(config);
  const onlineStore = pickOnlineStorePublication(publications);
  if (!onlineStore?.id) {
    throw new Error(
      `Could not find 'Online Store' publication. Available publications: ${JSON.stringify(publications.map((p) => ({ id: p?.id, name: p?.name })))}`,
    );
  }

  const data = await fetchGraphql(
    config,
    `
      mutation PublishProductToOnlineStore($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) {
          publishable {
            ... on Product {
              id
              status
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      id: productGid,
      input: [{ publicationId: onlineStore.id }],
    },
  );

  const result = data?.publishablePublish;
  const userErrors = Array.isArray(result?.userErrors) ? result.userErrors : [];
  if (userErrors.length > 0) {
    throw new Error(`publishablePublish userErrors: ${JSON.stringify(userErrors)}`);
  }

  return {
    publicationId: onlineStore.id,
    publicationName: onlineStore.name,
    productId: extractNumericId(result?.publishable?.id) || extractNumericId(productId),
    productStatus: String(result?.publishable?.status || ""),
  };
}

async function findProductByHandle(config, handle) {
  const graphData = await fetchGraphql(
    config,
    `
      query ProductByHandle($handle: String!) {
        productByHandle(handle: $handle) {
          id
          handle
          status
          variants(first: 250) {
            nodes {
              id
              sku
              inventoryItem {
                id
              }
            }
          }
        }
      }
    `,
    { handle },
  );

  const graphProduct = graphData?.productByHandle;
  if (graphProduct) {
    const productId = extractNumericId(graphProduct.id);
    if (productId) {
      const variants = Array.isArray(graphProduct?.variants?.nodes)
        ? graphProduct.variants.nodes.map((v) => ({
            id: extractNumericId(v?.id),
            sku: String(v?.sku || ""),
            inventory_item_id: extractNumericId(v?.inventoryItem?.id),
          }))
        : [];
      return {
        id: productId,
        handle: String(graphProduct.handle || handle),
        status: mapStatus(graphProduct.status),
        variants,
      };
    }
  }

  const { storeUrl, apiVersion } = config;
  let sinceId = 0;

  while (true) {
    const params = new URLSearchParams({
      limit: "250",
      status: "any",
      fields: "id,handle,status,variants",
      since_id: String(sinceId),
    });
    const url = `https://${storeUrl}/admin/api/${apiVersion}/products.json?${params.toString()}`;
    const headers = await buildShopifyHeaders(config);
    const res = await fetch(url, {
      headers,
    });

    const json = await res.json().catch(async () => ({ raw: await res.text() }));
    if (!res.ok) {
      throw new Error(`Product lookup failed (${res.status}): ${JSON.stringify(json)}`);
    }

    const products = Array.isArray(json.products) ? json.products : [];
    const found = products.find((p) => String(p?.handle || "") === handle);
    if (found) return found;

    if (products.length === 0) return null;
    sinceId = Number(products[products.length - 1]?.id || 0);
    if (!Number.isFinite(sinceId) || sinceId <= 0 || products.length < 250) return null;
  }
}

async function findProductByVariantSku(config, skus) {
  const wanted = new Set(
    (Array.isArray(skus) ? skus : [])
      .map((sku) => String(sku || "").trim())
      .filter(Boolean),
  );
  if (wanted.size === 0) return null;

  const { storeUrl, apiVersion } = config;
  let sinceId = 0;

  while (true) {
    const params = new URLSearchParams({
      limit: "250",
      status: "any",
      fields: "id,handle,status,variants",
      since_id: String(sinceId),
    });
    const url = `https://${storeUrl}/admin/api/${apiVersion}/products.json?${params.toString()}`;
    const headers = await buildShopifyHeaders(config);
    const res = await fetch(url, { headers });
    const json = await res.json().catch(async () => ({ raw: await res.text() }));
    if (!res.ok) {
      throw new Error(`Product SKU lookup failed (${res.status}): ${JSON.stringify(json)}`);
    }

    const products = Array.isArray(json.products) ? json.products : [];
    for (const product of products) {
      const variants = Array.isArray(product?.variants) ? product.variants : [];
      const hasMatch = variants.some((v) => wanted.has(String(v?.sku || "").trim()));
      if (hasMatch) return product;
    }

    if (products.length === 0) return null;
    sinceId = Number(products[products.length - 1]?.id || 0);
    if (!Number.isFinite(sinceId) || sinceId <= 0 || products.length < 250) return null;
  }
}

async function resolveLocationId(config) {
  if (config.locationId && Number.isFinite(Number(config.locationId))) {
    return Number(config.locationId);
  }

  const { storeUrl, apiVersion } = config;
  const url = `https://${storeUrl}/admin/api/${apiVersion}/locations.json?limit=250`;
  const headers = await buildShopifyHeaders(config);
  const json = await fetchJson(url, {
    headers,
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

  const imagesPayload = buildGalleryImageEntries(requestPayload).map((img) => ({
    src: img.src,
    position: img.position,
    alt: img.alt,
  }));

  const option1Name = String(listing.option1Name || "Subtype").trim() || "Subtype";

  const variantsPayload = variants.map((variant, idx) => {
    const sku = String(variant?.sku || "").trim();
    const subtype = String(variant?.subtype || "").trim();
    const existingId = existingVariantIdBySku.get(sku);
    const payload = {
      sku,
      option1: subtype || "Default",
      position: idx + 1,
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

  const explicitStatusRaw = String(listing.status || "").trim();
  const resolvedStatus = explicitStatusRaw
    ? mapStatus(explicitStatusRaw)
    : existingProduct?.status
      ? mapStatus(existingProduct.status)
      : "draft";

  const payload = {
    handle,
    title: String(listing.title || "Untitled"),
    body_html: String(listing.bodyHtml || ""),
    vendor: String(listing.vendor || "SPNSS Ltd."),
    product_type: String(listing.productType || ""),
    tags: toTagsString(listing.tags),
    status: resolvedStatus,
    options: [{ name: option1Name }],
    images: imagesPayload,
    variants: variantsPayload,
  };

  if (!existingProduct) {
    // Ensure newly created products are assigned to the standard sales channels
    // (including Online Store) even when created as draft.
    payload.published_scope = "global";
  }

  return payload;
}

async function fetchProductById(config, productId) {
  const { storeUrl, apiVersion } = config;
  const headers = await buildShopifyHeaders(config);
  const url = `https://${storeUrl}/admin/api/${apiVersion}/products/${productId}.json`;
  const json = await fetchJson(url, { headers });
  return json?.product || null;
}

async function createProductImage(config, productId, image) {
  const { storeUrl, apiVersion } = config;
  const headers = await buildShopifyHeaders(config);
  const url = `https://${storeUrl}/admin/api/${apiVersion}/products/${productId}/images.json`;
  const json = await fetchJson(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      image: {
        src: image?.src,
        alt: String(image?.alt || ""),
        position: toNumberOrNull(image?.position) || undefined,
      },
    }),
  });
  return json?.image || null;
}

async function updateProductImage(config, productId, imageId, fields) {
  const { storeUrl, apiVersion } = config;
  const headers = await buildShopifyHeaders(config);
  const url = `https://${storeUrl}/admin/api/${apiVersion}/products/${productId}/images/${imageId}.json`;
  const json = await fetchJson(url, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      image: {
        id: imageId,
        ...fields,
      },
    }),
  });
  return json?.image || null;
}

async function deleteProductImage(config, productId, imageId) {
  const { storeUrl, apiVersion } = config;
  const headers = await buildShopifyHeaders(config);
  const url = `https://${storeUrl}/admin/api/${apiVersion}/products/${productId}/images/${imageId}.json`;
  await fetchJson(url, {
    method: "DELETE",
    headers,
  });
}

async function reconcileProductGallery(config, productId, requestPayload) {
  const desiredGalleryImages = buildGalleryImageEntries(requestPayload);
  const variantAttachmentImages = buildVariantAttachmentEntries(requestPayload);
  const variantImageIdBySku = new Map();
  let latest = await fetchProductById(config, productId);
  if (!latest) return { product: null, variantImageIdBySku };
  const existingImages = Array.isArray(latest?.images) ? latest.images : [];
  for (const img of existingImages) {
    const imageId = toNumberOrNull(img?.id);
    if (!imageId) continue;
    await deleteProductImage(config, productId, imageId);
  }

  let nextPosition = 1;
  for (const desired of desiredGalleryImages) {
    const created = await createProductImage(config, productId, {
      ...desired,
      position: nextPosition,
    });
    if (created) nextPosition += 1;
  }

  for (const desired of variantAttachmentImages) {
    const created = await createProductImage(config, productId, {
      ...desired,
      position: nextPosition,
    });
    if (created) {
      const imageId = toNumberOrNull(created?.id);
      if (imageId) {
        variantImageIdBySku.set(desired.sku, imageId);
      }
      nextPosition += 1;
    }
  }

  latest = await fetchProductById(config, productId);
  if (!latest) return { product: null, variantImageIdBySku };
  const currentImages = (Array.isArray(latest?.images) ? latest.images : [])
    .slice()
    .sort((a, b) => Number(a?.position || 0) - Number(b?.position || 0));

  const desiredAll = [
    ...desiredGalleryImages,
    ...variantAttachmentImages.map((img, idx) => ({
      ...img,
      position: desiredGalleryImages.length + idx + 1,
    })),
  ];
  for (let i = 0; i < currentImages.length && i < desiredAll.length; i += 1) {
    const current = currentImages[i];
    const desired = desiredAll[i];
    const imageId = toNumberOrNull(current?.id);
    if (!imageId) continue;
    const currentPos = toNumberOrNull(current?.position);
    const currentAlt = String(current?.alt || "");
    if (currentPos !== desired.position || currentAlt !== String(desired.alt || "")) {
      await updateProductImage(config, productId, imageId, {
        position: desired.position,
        alt: String(desired.alt || ""),
      });
    }
  }

  return { product: await fetchProductById(config, productId), variantImageIdBySku };
}

async function updateVariantFields(config, variantId, fields) {
  const { storeUrl, apiVersion } = config;
  const headers = await buildShopifyHeaders(config);
  const url = `https://${storeUrl}/admin/api/${apiVersion}/variants/${variantId}.json`;
  const json = await fetchJson(url, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      variant: { id: variantId, ...fields },
    }),
  });
  return json?.variant || null;
}

async function reconcileVariantOrderAndImages(config, product, requestPayload) {
  const productId = toNumberOrNull(product?.id);
  if (!productId) return product;

  const requestVariants = Array.isArray(requestPayload?.variants) ? requestPayload.variants : [];
  if (requestVariants.length === 0) return product;

  const galleryResult = await reconcileProductGallery(config, productId, requestPayload);
  const variantImageIdBySku = galleryResult?.variantImageIdBySku || new Map();
  if (galleryResult?.product) {
    product = galleryResult.product;
  }
  const desiredBySku = new Map();
  requestVariants.forEach((variant, idx) => {
    const sku = String(variant?.sku || "").trim();
    if (!sku) return;
    desiredBySku.set(sku, {
      position: idx + 1,
      variantImageId: toNumberOrNull(variantImageIdBySku.get(sku)) || null,
    });
  });

  let latest = await fetchProductById(config, productId);
  if (!latest) return product;

  const variants = Array.isArray(latest?.variants) ? latest.variants : [];
  for (const variant of variants) {
    const sku = String(variant?.sku || "").trim();
    if (!sku) continue;
    const desired = desiredBySku.get(sku);
    if (!desired) continue;

    const variantId = toNumberOrNull(variant?.id);
    if (!variantId) continue;

    const nextFields = {};
    const currentPosition = toNumberOrNull(variant?.position);
    if (desired.position && currentPosition !== desired.position) {
      nextFields.position = desired.position;
    }

    if (desired.variantImageId) {
      const targetImageId = desired.variantImageId;
      const currentImageId = toNumberOrNull(variant?.image_id);
      if (targetImageId && currentImageId !== targetImageId) {
        nextFields.image_id = targetImageId;
      }
    }

    if (Object.keys(nextFields).length > 0) {
      await updateVariantFields(config, variantId, nextFields);
    }
  }

  latest = await fetchProductById(config, productId);
  return latest || product;
}

async function upsertProductFromRequest(config, requestPayload) {
  const { storeUrl, apiVersion } = config;
  const handle = String(requestPayload?.handle || "").trim();
  const requestSkus = (Array.isArray(requestPayload?.variants) ? requestPayload.variants : [])
    .map((v) => String(v?.sku || "").trim())
    .filter(Boolean);

  const existingByHandle = await findProductByHandle(config, handle);
  const headers = await buildShopifyHeaders(config);

  async function updateProduct(targetProduct) {
    const productPayload = buildProductPayload(requestPayload, targetProduct);
    const endpoint = `https://${storeUrl}/admin/api/${apiVersion}/products/${targetProduct.id}.json`;
    const json = await fetchJson(endpoint, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        product: { id: targetProduct.id, ...productPayload },
      }),
    });
    if (!json.product?.id) {
      throw new Error(`Unexpected product update response: ${JSON.stringify(json)}`);
    }
    return { json, productPayload };
  }

  async function createProduct() {
    const productPayload = buildProductPayload(requestPayload, null);
    const endpoint = `https://${storeUrl}/admin/api/${apiVersion}/products.json`;
    const json = await fetchJson(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        product: productPayload,
      }),
    });
    if (!json.product?.id) {
      throw new Error(`Unexpected product create response: ${JSON.stringify(json)}`);
    }
    return { json, productPayload };
  }

  let existing = existingByHandle;
  if (!existing) {
    existing = await findProductByVariantSku(config, requestSkus);
  }

  let opResult;
  if (existing) {
    try {
      opResult = await updateProduct(existing);
    } catch (error) {
      opResult = await createProduct();
    }
  } else {
    opResult = await createProduct();
  }

  const json = opResult.json;
  const createdHandle = String(json.product?.handle || "");
  const requestedHandle = String(opResult.productPayload?.handle || "").trim();
  const wasCreate = !existing || Number(existing?.id) !== Number(json.product?.id);
  const dedupedCreate =
    wasCreate &&
    requestedHandle &&
    createdHandle &&
    createdHandle !== requestedHandle &&
    createdHandle.startsWith(`${requestedHandle}-`);

  if (dedupedCreate) {
    const conflictTarget = await findProductByHandle(config, requestedHandle);
    if (!conflictTarget?.id) {
      throw new Error(
        `Shopify created deduplicated handle '${createdHandle}' for requested handle '${requestedHandle}', and no exact-handle target was found to update`,
      );
    }

    const updateEndpoint = `https://${storeUrl}/admin/api/${apiVersion}/products/${conflictTarget.id}.json`;
    const updated = await fetchJson(updateEndpoint, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        product: { id: conflictTarget.id, ...buildProductPayload(requestPayload, conflictTarget) },
      }),
    });

    const duplicateId = toNumberOrNull(json.product?.id);
    if (duplicateId) {
      try {
        await fetchJson(`https://${storeUrl}/admin/api/${apiVersion}/products/${duplicateId}.json`, {
          method: "DELETE",
          headers,
        });
      } catch (_) {
        // Non-fatal: avoid masking the successful overwrite path.
      }
    }

    if (updated?.product?.id) {
      return reconcileVariantOrderAndImages(config, updated.product, requestPayload);
    }
  }

  return reconcileVariantOrderAndImages(config, json.product, requestPayload);
}

async function setInventoryLevel(config, locationId, inventoryItemId, available) {
  const { storeUrl, apiVersion } = config;
  const headers = await buildShopifyHeaders(config);
  return fetchJson(`https://${storeUrl}/admin/api/${apiVersion}/inventory_levels/set.json`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      location_id: locationId,
      inventory_item_id: inventoryItemId,
      available,
    }),
  });
}

async function fetchAllVariantsBySku(config) {
  const { storeUrl, apiVersion } = config;
  const variantsBySku = new Map();
  let sinceId = 0;

  while (true) {
    const params = new URLSearchParams({
      limit: "250",
      status: "active",
      fields: "id,handle,variants",
      since_id: String(sinceId),
    });
    const url = `https://${storeUrl}/admin/api/${apiVersion}/products.json?${params.toString()}`;
    const headers = await buildShopifyHeaders(config);
    const res = await fetch(url, {
      headers,
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

    if (products.length === 0) break;
    sinceId = Number(products[products.length - 1]?.id || 0);
    if (!Number.isFinite(sinceId) || sinceId <= 0 || products.length < 250) break;
  }

  return variantsBySku;
}

module.exports = {
  normalizeStoreUrl,
  extractGoogleDriveFileId,
  toGoogleDrivePublicImageUrl,
  toNumberOrNull,
  parseNextLink,
  toTagsString,
  mapStatus,
  hasAnyCredentials,
  resolveAccessToken,
  buildShopifyHeaders,
  fetchJson,
  findProductByHandle,
  findProductByVariantSku,
  resolveLocationId,
  buildProductPayload,
  upsertProductFromRequest,
  ensureProductPublishedToOnlineStore,
  setInventoryLevel,
  fetchAllVariantsBySku,
};
