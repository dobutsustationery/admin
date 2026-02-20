#!/usr/bin/env bun

// NOTE: Initial implementation, not yet validated against a live Shopify store.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initializeApp, cert } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { rootReducer } from "../src/lib/root-reducer";
import { generateSku } from "../src/lib/handle-utils";

type Args = Record<string, string | boolean>;

type InventoryTarget = {
  sku: string;
  itemId: string;
  janCode: string;
  subtype: string;
  handle: string;
  available: number;
  price: number;
  weight: number;
};

type ShopifyVariant = {
  sku: string;
  productId: number;
  productHandle: string;
  variantId: number;
  inventoryItemId: number | null;
  inventoryQuantity: number | null;
};

type ShopifyProduct = {
  id: number;
  handle: string;
  variants: Array<{
    id: number;
    sku: string;
    inventory_item_id?: number;
    inventory_quantity?: number;
  }>;
};

type SyncResult = {
  sku: string;
  targetQty: number;
  inventoryItemId: number;
  success: boolean;
  response: unknown;
};

type ReplayResult = {
  state: any;
  lastSuccessfulTargetBySku: Map<string, number>;
  pendingListingRequests: string[];
};

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;

    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function getBooleanArg(args: Args, key: string, defaultValue: boolean): boolean {
  const value = args[key];
  if (value === undefined) return defaultValue;
  if (typeof value === "boolean") return value;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function getStringArg(args: Args, key: string, defaultValue?: string): string {
  const value = args[key];
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  return defaultValue ?? "";
}

function showHelp() {
  console.log(`Shopify sync (event-sourced, broadcast-backed)

Usage:
  bun scripts/shopify-sync.ts [options]

Options:
  --apply                           Actually push writes to Shopify (default: false)
  --firestore-env <env>             Firestore source: emulator | staging | production
  --shopify-location-id <id>        Explicit Shopify location ID (default: auto-detect)
  --limit <n>                       Max SKU updates in inventory sync mode
  --sync-listing-handle <handle>    Sync exactly one listing (upsert product + inventory)
  --process-requests                Process queued listing requests from broadcast actions
  --help                            Show this help

Modes:
  1) Inventory diff sync (default): compares internal available stock to Shopify and logs.
  2) Single listing sync: use --sync-listing-handle.
  3) Queue processing: use --process-requests (consumes shopify_sync_listing_request actions).

Required environment variables:
  SHOPIFY_ACCESS_TOKEN
  SHOPIFY_STORE_URL (or VITE_SHOPIFY_STORE_URL)

Optional environment variables:
  SHOPIFY_API_VERSION (or VITE_SHOPIFY_API_VERSION, default 2024-01)
  SHOPIFY_SYNC_CREATOR_UID (default: shopify-sync-script)
  FIRESTORE_EMULATOR_HOST (when firestore-env=emulator)
`);
}

function normalizeStoreUrl(raw: string): string {
  return raw.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const parts = linkHeader.split(",").map((p) => p.trim());
  for (const part of parts) {
    const relNext = /<([^>]+)>;\s*rel="next"/.exec(part);
    if (relNext?.[1]) return relNext[1];
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toTagsString(tags: unknown): string {
  if (!Array.isArray(tags)) return "";
  return tags
    .map((t) => String(t || "").trim())
    .filter(Boolean)
    .join(", ");
}

async function initFirestore(firestoreEnv: string) {
  if (firestoreEnv === "emulator") {
    const app = initializeApp(
      { projectId: process.env.FIREBASE_EMULATOR_PROJECT_ID || "dobutsu-admin" },
      `shopify-sync-${Date.now()}`,
    );
    const db = getFirestore(app);
    db.settings({
      host: process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080",
      ssl: false,
    });
    return db;
  }

  const keyPath = resolve(process.cwd(), `service-account-${firestoreEnv}.json`);
  if (!existsSync(keyPath)) {
    throw new Error(`Missing service account key: ${keyPath}`);
  }

  const serviceAccount = JSON.parse(readFileSync(keyPath, "utf8"));
  const app = initializeApp(
    { credential: cert(serviceAccount) },
    `shopify-sync-${firestoreEnv}-${Date.now()}`,
  );
  return getFirestore(app);
}

async function writeApiLog(
  db: any,
  creator: string,
  payload: {
    requestType: "inventory_sync" | "fetch_listings" | "product_update";
    endpoint: string;
    success: boolean;
    response: unknown;
    context?: Record<string, unknown>;
  },
) {
  await db.collection("broadcast").add({
    type: "shopify_api_log",
    payload: {
      ...payload,
      timestamp: Date.now(),
    },
    creator,
    timestamp: FieldValue.serverTimestamp(),
  });
}

async function replayStateAndLogs(db: any): Promise<ReplayResult> {
  const snapshot = await db.collection("broadcast").orderBy("timestamp").get();

  let state = rootReducer(undefined, { type: "INIT" });
  const lastSuccessfulTargetBySku = new Map<string, number>();
  const latestRequestAtByHandle = new Map<string, number>();
  const latestSuccessfulProductSyncAtByHandle = new Map<string, number>();

  snapshot.docs.forEach((doc: any) => {
    const action = doc.data() as any;
    state = rootReducer(state, action);

    if (action?.type === "shopify_api_log") {
      const payload = action?.payload;
      if (payload?.requestType === "inventory_sync" && payload?.success) {
        const sku = payload?.context?.sku;
        const targetQty = payload?.context?.targetQty;
        if (typeof sku === "string" && Number.isFinite(targetQty)) {
          lastSuccessfulTargetBySku.set(sku, targetQty);
        }
      }
      if (payload?.requestType === "product_update" && payload?.success) {
        const handle = String(payload?.context?.handle || "").trim();
        const loggedAt = Number(payload?.timestamp || 0);
        if (handle && loggedAt > 0) {
          latestSuccessfulProductSyncAtByHandle.set(handle, loggedAt);
        }
      }
      return;
    }

    if (action?.type === "shopify_sync_listing_request") {
      const reqHandle = String(action?.payload?.handle || "").trim();
      const requestedAt = Number(action?.payload?.requestedAt || 0);
      if (reqHandle && requestedAt > 0) {
        const current = latestRequestAtByHandle.get(reqHandle) || 0;
        if (requestedAt > current) latestRequestAtByHandle.set(reqHandle, requestedAt);
      }
    }
  });

  const pendingListingRequests = Array.from(latestRequestAtByHandle.entries())
    .filter(([handle, requestedAt]) => {
      const lastSuccessAt = latestSuccessfulProductSyncAtByHandle.get(handle) || 0;
      return requestedAt > lastSuccessAt;
    })
    .map(([handle]) => handle);

  return {
    state,
    lastSuccessfulTargetBySku,
    pendingListingRequests,
  };
}

function computeTargets(state: any): Map<string, InventoryTarget> {
  const targets = new Map<string, InventoryTarget>();

  const inventory = state?.inventory?.idToItem || {};
  const idToHandle = state?.listings?.idToHandle || {};

  for (const [itemId, item] of Object.entries(inventory as Record<string, any>)) {
    const janCode = String(item?.janCode || "").trim();
    if (!janCode) continue;

    const subtype = String(item?.subtype || "").trim();
    const sku = generateSku(janCode, subtype);

    const qty = Number(item?.qty || 0);
    const shipped = Number(item?.shipped || 0);
    const available = Math.max(0, qty - shipped);

    targets.set(sku, {
      sku,
      itemId,
      janCode,
      subtype,
      handle: String(idToHandle[itemId] || item?.handle || ""),
      available,
      price: Number(item?.price || 0),
      weight: Number(item?.weight || 0),
    });
  }

  return targets;
}

function collectListingTargets(state: any, handle: string): InventoryTarget[] {
  const allTargets = computeTargets(state);
  return Array.from(allTargets.values())
    .filter((t) => t.handle === handle)
    .sort((a, b) => {
      const subtypeCmp = a.subtype.localeCompare(b.subtype);
      if (subtypeCmp !== 0) return subtypeCmp;
      return a.itemId.localeCompare(b.itemId);
    });
}

async function fetchAllShopifyVariants(
  storeUrl: string,
  apiVersion: string,
  accessToken: string,
): Promise<Map<string, ShopifyVariant>> {
  const variantsBySku = new Map<string, ShopifyVariant>();

  let url = `https://${storeUrl}/admin/api/${apiVersion}/products.json?limit=250&status=active&fields=id,handle,variants`;

  while (url) {
    const res = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Shopify products fetch failed (${res.status}): ${text}`);
    }

    const json = (await res.json()) as { products?: any[] };
    const products = json.products || [];

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

async function findProductByHandle(
  storeUrl: string,
  apiVersion: string,
  accessToken: string,
  handle: string,
): Promise<ShopifyProduct | null> {
  let url = `https://${storeUrl}/admin/api/${apiVersion}/products.json?limit=250&status=any&fields=id,handle,variants`;

  while (url) {
    const res = await fetch(url, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Product lookup failed (${res.status}): ${text}`);
    }

    const json = (await res.json()) as { products?: any[] };
    const products = json.products || [];
    const found = products.find((p) => String(p?.handle || "") === handle);
    if (found) {
      return {
        id: Number(found.id),
        handle: String(found.handle || ""),
        variants: Array.isArray(found.variants) ? found.variants : [],
      };
    }

    url = parseNextLink(res.headers.get("link"));
  }

  return null;
}

async function resolveLocationId(
  storeUrl: string,
  apiVersion: string,
  accessToken: string,
  explicitLocationId?: string,
): Promise<number> {
  if (explicitLocationId) {
    const parsed = Number(explicitLocationId);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid --shopify-location-id: ${explicitLocationId}`);
    }
    return parsed;
  }

  const url = `https://${storeUrl}/admin/api/${apiVersion}/locations.json?limit=250`;
  const res = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify locations fetch failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as { locations?: any[] };
  const firstLocation = json.locations?.[0];
  const locationId = toNumberOrNull(firstLocation?.id);
  if (!locationId) {
    throw new Error("No Shopify locations found. Provide --shopify-location-id.");
  }

  return locationId;
}

async function setInventoryLevel(
  storeUrl: string,
  apiVersion: string,
  accessToken: string,
  locationId: number,
  inventoryItemId: number,
  targetQty: number,
): Promise<unknown> {
  const endpoint = `https://${storeUrl}/admin/api/${apiVersion}/inventory_levels/set.json`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      location_id: locationId,
      inventory_item_id: inventoryItemId,
      available: targetQty,
    }),
  });

  const payload = await res.json().catch(async () => ({ raw: await res.text() }));

  if (!res.ok) {
    throw new Error(`inventory_levels/set failed (${res.status}): ${JSON.stringify(payload)}`);
  }

  return payload;
}

function mapStatus(input: unknown): "active" | "archived" | "draft" {
  const status = String(input || "active");
  if (status === "archived") return "archived";
  if (status === "draft") return "draft";
  return "active";
}

async function upsertListingProduct(
  storeUrl: string,
  apiVersion: string,
  accessToken: string,
  state: any,
  handle: string,
): Promise<ShopifyProduct> {
  const listing = state?.listings?.handleToListing?.[handle];
  if (!listing) {
    throw new Error(`Listing not found in state for handle: ${handle}`);
  }

  const listingTargets = collectListingTargets(state, handle);
  if (listingTargets.length === 0) {
    throw new Error(`No inventory variants found for listing handle: ${handle}`);
  }

  const existing = await findProductByHandle(storeUrl, apiVersion, accessToken, handle);
  const existingVariantIdBySku = new Map<string, number>();
  if (existing) {
    existing.variants.forEach((v) => {
      const sku = String(v?.sku || "").trim();
      if (!sku) return;
      const id = toNumberOrNull(v?.id);
      if (id) existingVariantIdBySku.set(sku, id);
    });
  }

  const imagePayload = (Array.isArray(listing.images) ? listing.images : [])
    .slice()
    .sort((a: any, b: any) => (a.position || 0) - (b.position || 0))
    .map((img: any, index: number) => ({
      src: String(img?.url || ""),
      position: Number(img?.position || index + 1),
      alt: String(img?.altText || ""),
    }))
    .filter((img: any) => !!img.src);

  const optionName = String(listing.option1Name || "Subtype").trim() || "Subtype";

  const variantsPayload = listingTargets.map((target) => {
    const variantBase: Record<string, unknown> = {
      sku: target.sku,
      option1: target.subtype || "Default",
      price: String(target.price || 0),
      barcode: target.janCode,
      grams: Number(target.weight || 0),
      weight: Number(target.weight || 0),
      weight_unit: "g",
      inventory_management: "shopify",
      inventory_policy: "deny",
      fulfillment_service: "manual",
      taxable: true,
      requires_shipping: true,
    };

    const existingVariantId = existingVariantIdBySku.get(target.sku);
    if (existingVariantId) {
      variantBase.id = existingVariantId;
    }

    return variantBase;
  });

  const productPayload: Record<string, unknown> = {
    handle,
    title: String(listing.title || "Untitled"),
    body_html: String(listing.bodyHtml || ""),
    vendor: String(listing.vendor || "SPNSS Ltd."),
    product_type: String(listing.productType || ""),
    tags: toTagsString(listing.tags),
    status: mapStatus(listing.status),
    options: [{ name: optionName }],
    images: imagePayload,
    variants: variantsPayload,
  };

  const endpoint = existing
    ? `https://${storeUrl}/admin/api/${apiVersion}/products/${existing.id}.json`
    : `https://${storeUrl}/admin/api/${apiVersion}/products.json`;

  const res = await fetch(endpoint, {
    method: existing ? "PUT" : "POST",
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      product: existing ? { id: existing.id, ...productPayload } : productPayload,
    }),
  });

  const json = (await res.json().catch(async () => ({ raw: await res.text() }))) as any;
  if (!res.ok) {
    throw new Error(`Product upsert failed (${res.status}): ${JSON.stringify(json)}`);
  }

  const product = json?.product;
  if (!product || !product.id) {
    throw new Error(`Product upsert response missing product data: ${JSON.stringify(json)}`);
  }

  return {
    id: Number(product.id),
    handle: String(product.handle || handle),
    variants: Array.isArray(product.variants) ? product.variants : [],
  };
}

async function syncSingleListing(
  db: any,
  creator: string,
  config: {
    storeUrl: string;
    apiVersion: string;
    accessToken: string;
    locationId: number;
    state: any;
    handle: string;
    apply: boolean;
  },
) {
  const { storeUrl, apiVersion, accessToken, locationId, state, handle, apply } = config;
  const listingTargets = collectListingTargets(state, handle);
  if (listingTargets.length === 0) {
    throw new Error(`No variants found for listing handle: ${handle}`);
  }

  if (!apply) {
    console.log(`[Shopify Sync] Dry run listing mode for '${handle}'. Variants=${listingTargets.length}`);
    return;
  }

  const productEndpoint = `/admin/api/${apiVersion}/products`;

  try {
    const product = await upsertListingProduct(storeUrl, apiVersion, accessToken, state, handle);

    await writeApiLog(db, creator, {
      requestType: "product_update",
      endpoint: productEndpoint,
      success: true,
      response: { productId: product.id, handle: product.handle, variantCount: product.variants.length },
      context: {
        handle,
        productId: product.id,
      },
    });

    const responseVariantBySku = new Map<string, any>();
    product.variants.forEach((variant: any) => {
      const sku = String(variant?.sku || "").trim();
      if (!sku) return;
      responseVariantBySku.set(sku, variant);
    });

    for (let i = 0; i < listingTargets.length; i++) {
      const target = listingTargets[i];
      const variant = responseVariantBySku.get(target.sku);
      const inventoryItemId = toNumberOrNull(variant?.inventory_item_id);

      if (!inventoryItemId) {
        await writeApiLog(db, creator, {
          requestType: "inventory_sync",
          endpoint: `/admin/api/${apiVersion}/inventory_levels/set.json`,
          success: false,
          response: { error: "Missing inventory_item_id after product upsert" },
          context: {
            handle,
            sku: target.sku,
            targetQty: target.available,
            locationId,
          },
        });
        console.error(`[${i + 1}/${listingTargets.length}] ${target.sku}: missing inventory_item_id`);
        continue;
      }

      try {
        const response = await setInventoryLevel(
          storeUrl,
          apiVersion,
          accessToken,
          locationId,
          inventoryItemId,
          target.available,
        );

        await writeApiLog(db, creator, {
          requestType: "inventory_sync",
          endpoint: `/admin/api/${apiVersion}/inventory_levels/set.json`,
          success: true,
          response,
          context: {
            handle,
            sku: target.sku,
            targetQty: target.available,
            inventoryItemId,
            locationId,
          },
        });

        console.log(`[${i + 1}/${listingTargets.length}] Synced ${target.sku} -> ${target.available}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await writeApiLog(db, creator, {
          requestType: "inventory_sync",
          endpoint: `/admin/api/${apiVersion}/inventory_levels/set.json`,
          success: false,
          response: { error: message },
          context: {
            handle,
            sku: target.sku,
            targetQty: target.available,
            inventoryItemId,
            locationId,
          },
        });
        console.error(`[${i + 1}/${listingTargets.length}] Failed ${target.sku}: ${message}`);
      }

      await sleep(550);
    }

    console.log(`[Shopify Sync] Listing sync complete for '${handle}'.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeApiLog(db, creator, {
      requestType: "product_update",
      endpoint: productEndpoint,
      success: false,
      response: { error: message },
      context: {
        handle,
      },
    });
    throw error;
  }
}

async function runInventoryDiffSync(
  db: any,
  creator: string,
  config: {
    storeUrl: string;
    apiVersion: string;
    accessToken: string;
    locationId: number;
    state: any;
    lastSuccessfulTargetBySku: Map<string, number>;
    apply: boolean;
    limit: number;
  },
) {
  const {
    storeUrl,
    apiVersion,
    accessToken,
    locationId,
    state,
    lastSuccessfulTargetBySku,
    apply,
    limit,
  } = config;

  const desiredTargets = computeTargets(state);
  console.log(`[Shopify Sync] Internal SKUs: ${desiredTargets.size}`);

  let variantsBySku: Map<string, ShopifyVariant>;
  try {
    variantsBySku = await fetchAllShopifyVariants(storeUrl, apiVersion, accessToken);
    if (apply) {
      await writeApiLog(db, creator, {
        requestType: "fetch_listings",
        endpoint: `/admin/api/${apiVersion}/products.json`,
        success: true,
        response: { variantsFetched: variantsBySku.size },
      });
    }
  } catch (error) {
    if (apply) {
      await writeApiLog(db, creator, {
        requestType: "fetch_listings",
        endpoint: `/admin/api/${apiVersion}/products.json`,
        success: false,
        response: { error: error instanceof Error ? error.message : String(error) },
      });
    }
    throw error;
  }

  console.log(`[Shopify Sync] Shopify SKUs: ${variantsBySku.size}`);

  const missingInShopify: string[] = [];
  const needsSync: Array<InventoryTarget & { shopify: ShopifyVariant; reason: string }> = [];
  const alreadySynced = { byLog: 0, byShopifyQty: 0 };

  for (const [sku, target] of desiredTargets.entries()) {
    const shopifyVariant = variantsBySku.get(sku);
    if (!shopifyVariant) {
      missingInShopify.push(sku);
      continue;
    }

    const loggedQty = lastSuccessfulTargetBySku.get(sku);
    if (loggedQty === target.available) {
      alreadySynced.byLog++;
      continue;
    }

    if (shopifyVariant.inventoryQuantity === target.available) {
      alreadySynced.byShopifyQty++;
      continue;
    }

    if (!shopifyVariant.inventoryItemId) {
      missingInShopify.push(sku);
      continue;
    }

    needsSync.push({
      ...target,
      shopify: shopifyVariant,
      reason:
        typeof loggedQty === "number"
          ? `log=${loggedQty}, shopify=${shopifyVariant.inventoryQuantity}`
          : `no_log, shopify=${shopifyVariant.inventoryQuantity}`,
    });
  }

  console.log(`[Shopify Sync] Missing in Shopify: ${missingInShopify.length}`);
  console.log(`[Shopify Sync] Already synced by log: ${alreadySynced.byLog}`);
  console.log(`[Shopify Sync] Already synced by Shopify qty: ${alreadySynced.byShopifyQty}`);
  console.log(`[Shopify Sync] Needs sync: ${needsSync.length}`);

  if (missingInShopify.length > 0) {
    console.log("[Shopify Sync] Sample missing SKUs:", missingInShopify.slice(0, 20));
  }

  if (!apply) {
    console.log("\n[Shopify Sync] Dry run complete. No updates were sent.");
    return;
  }

  const maxToApply = limit > 0 ? Math.min(limit, needsSync.length) : needsSync.length;
  const queue = needsSync.slice(0, maxToApply);
  const results: SyncResult[] = [];

  for (let i = 0; i < queue.length; i++) {
    const job = queue[i];

    try {
      const response = await setInventoryLevel(
        storeUrl,
        apiVersion,
        accessToken,
        locationId,
        job.shopify.inventoryItemId as number,
        job.available,
      );

      await writeApiLog(db, creator, {
        requestType: "inventory_sync",
        endpoint: `/admin/api/${apiVersion}/inventory_levels/set.json`,
        success: true,
        response,
        context: {
          sku: job.sku,
          handle: job.handle,
          targetQty: job.available,
          inventoryItemId: job.shopify.inventoryItemId,
          variantId: job.shopify.variantId,
          locationId,
          reason: job.reason,
        },
      });

      results.push({
        sku: job.sku,
        targetQty: job.available,
        inventoryItemId: job.shopify.inventoryItemId as number,
        success: true,
        response,
      });

      console.log(`[${i + 1}/${queue.length}] Synced ${job.sku} -> ${job.available}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await writeApiLog(db, creator, {
        requestType: "inventory_sync",
        endpoint: `/admin/api/${apiVersion}/inventory_levels/set.json`,
        success: false,
        response: { error: message },
        context: {
          sku: job.sku,
          handle: job.handle,
          targetQty: job.available,
          inventoryItemId: job.shopify.inventoryItemId,
          variantId: job.shopify.variantId,
          locationId,
          reason: job.reason,
        },
      });

      results.push({
        sku: job.sku,
        targetQty: job.available,
        inventoryItemId: job.shopify.inventoryItemId as number,
        success: false,
        response: { error: message },
      });

      console.error(`[${i + 1}/${queue.length}] Failed ${job.sku}: ${message}`);
    }

    await sleep(550);
  }

  const ok = results.filter((r) => r.success).length;
  const failed = results.length - ok;
  console.log(`\n[Shopify Sync] Apply complete. Success=${ok}, Failed=${failed}, Attempted=${results.length}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    showHelp();
    return;
  }

  const apply = getBooleanArg(args, "apply", false);
  const limitArg = getStringArg(args, "limit", "0");
  const limit = Math.max(0, Number(limitArg) || 0);

  const firestoreEnv = getStringArg(
    args,
    "firestore-env",
    process.env.SHOPIFY_SYNC_FIRESTORE_ENV || process.env.VITE_FIREBASE_ENV || "emulator",
  );

  const rawStoreUrl = process.env.SHOPIFY_STORE_URL || process.env.VITE_SHOPIFY_STORE_URL;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
  const apiVersion = process.env.SHOPIFY_API_VERSION || process.env.VITE_SHOPIFY_API_VERSION || "2024-01";
  const creator = process.env.SHOPIFY_SYNC_CREATOR_UID || "shopify-sync-script";

  if (!rawStoreUrl) throw new Error("Missing SHOPIFY_STORE_URL (or VITE_SHOPIFY_STORE_URL)");
  if (!accessToken) throw new Error("Missing SHOPIFY_ACCESS_TOKEN");

  const storeUrl = normalizeStoreUrl(rawStoreUrl);
  console.log(`[Shopify Sync] Firestore env: ${firestoreEnv}`);
  console.log(`[Shopify Sync] Store: ${storeUrl}`);
  console.log(`[Shopify Sync] Mode: ${apply ? "APPLY" : "DRY RUN"}`);

  const db = await initFirestore(firestoreEnv);
  const { state, lastSuccessfulTargetBySku, pendingListingRequests } = await replayStateAndLogs(db);

  const locationId = await resolveLocationId(
    storeUrl,
    apiVersion,
    accessToken,
    getStringArg(args, "shopify-location-id") || process.env.SHOPIFY_LOCATION_ID,
  );

  console.log(`[Shopify Sync] Location ID: ${locationId}`);

  const explicitHandle = getStringArg(args, "sync-listing-handle").trim();
  const processRequests = getBooleanArg(args, "process-requests", false);

  if (explicitHandle) {
    await syncSingleListing(db, creator, {
      storeUrl,
      apiVersion,
      accessToken,
      locationId,
      state,
      handle: explicitHandle,
      apply,
    });
    return;
  }

  if (processRequests) {
    if (pendingListingRequests.length === 0) {
      console.log("[Shopify Sync] No queued listing sync requests found.");
      return;
    }

    console.log(`[Shopify Sync] Processing ${pendingListingRequests.length} queued listing request(s).`);
    for (const requestedHandle of pendingListingRequests) {
      await syncSingleListing(db, creator, {
        storeUrl,
        apiVersion,
        accessToken,
        locationId,
        state,
        handle: requestedHandle,
        apply,
      });
    }
    return;
  }

  await runInventoryDiffSync(db, creator, {
    storeUrl,
    apiVersion,
    accessToken,
    locationId,
    state,
    lastSuccessfulTargetBySku,
    apply,
    limit,
  });
}

main().catch((error) => {
  console.error("[Shopify Sync] Fatal error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
