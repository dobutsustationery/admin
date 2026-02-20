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
};

type ShopifyVariant = {
  sku: string;
  productId: number;
  productHandle: string;
  variantId: number;
  inventoryItemId: number | null;
  inventoryQuantity: number | null;
};

type SyncResult = {
  sku: string;
  targetQty: number;
  inventoryItemId: number;
  success: boolean;
  response: unknown;
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
  console.log(`Shopify inventory sync (event-sourced, broadcast-backed)

Usage:
  bun scripts/shopify-sync.ts [options]

Options:
  --apply                     Actually push inventory updates to Shopify (default: false)
  --firestore-env <env>       Firestore source: emulator | staging | production (default: from env, fallback emulator)
  --shopify-location-id <id>  Explicit Shopify location ID (default: auto-detect first location)
  --limit <n>                 Maximum SKU updates to push when --apply is enabled
  --help                      Show this help

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

async function initFirestore(firestoreEnv: string) {
  if (firestoreEnv === "emulator") {
    const app = initializeApp({ projectId: process.env.FIREBASE_EMULATOR_PROJECT_ID || "dobutsu-admin" }, `shopify-sync-${Date.now()}`);
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
  const app = initializeApp({ credential: cert(serviceAccount) }, `shopify-sync-${firestoreEnv}-${Date.now()}`);
  return getFirestore(app);
}

async function writeApiLog(
  db: any,
  creator: string,
  payload: {
    requestType: "inventory_sync" | "fetch_listings";
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

async function replayStateAndLastLogs(db: any) {
  const snapshot = await db.collection("broadcast").orderBy("timestamp").get();

  let state = rootReducer(undefined, { type: "INIT" });
  const lastSuccessfulTargetBySku = new Map<string, number>();

  snapshot.docs.forEach((doc) => {
    const action = doc.data() as any;
    state = rootReducer(state, action);

    if (action?.type !== "shopify_api_log") return;
    const payload = action?.payload;
    if (!payload || payload.requestType !== "inventory_sync" || !payload.success) return;

    const sku = payload?.context?.sku;
    const targetQty = payload?.context?.targetQty;
    if (typeof sku === "string" && Number.isFinite(targetQty)) {
      lastSuccessfulTargetBySku.set(sku, targetQty);
    }
  });

  return { state, lastSuccessfulTargetBySku };
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
    });
  }

  return targets;
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
      const handle = String(product?.handle || "");
      const variants = Array.isArray(product?.variants) ? product.variants : [];

      for (const variant of variants) {
        const sku = String(variant?.sku || "").trim();
        if (!sku) continue;

        variantsBySku.set(sku, {
          sku,
          productId: Number(product?.id),
          productHandle: handle,
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
  const endpoint = `/admin/api/${apiVersion}/inventory_levels/set.json`;

  console.log(`[Shopify Sync] Firestore env: ${firestoreEnv}`);
  console.log(`[Shopify Sync] Store: ${storeUrl}`);
  console.log(`[Shopify Sync] Mode: ${apply ? "APPLY" : "DRY RUN"}`);

  const db = await initFirestore(firestoreEnv);
  const { state, lastSuccessfulTargetBySku } = await replayStateAndLastLogs(db);
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

  const locationId = await resolveLocationId(
    storeUrl,
    apiVersion,
    accessToken,
    getStringArg(args, "shopify-location-id") || process.env.SHOPIFY_LOCATION_ID,
  );

  console.log(`[Shopify Sync] Shopify SKUs: ${variantsBySku.size}`);
  console.log(`[Shopify Sync] Location ID: ${locationId}`);

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
      reason: typeof loggedQty === "number" ? `log=${loggedQty}, shopify=${shopifyVariant.inventoryQuantity}` : `no_log, shopify=${shopifyVariant.inventoryQuantity}`,
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
        endpoint,
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
        endpoint,
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

    // Basic throttling for Shopify API limits.
    await sleep(550);
  }

  const ok = results.filter((r) => r.success).length;
  const failed = results.length - ok;
  console.log(`\n[Shopify Sync] Apply complete. Success=${ok}, Failed=${failed}, Attempted=${results.length}`);
}

main().catch((error) => {
  console.error("[Shopify Sync] Fatal error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
