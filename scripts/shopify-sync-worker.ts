#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const require = createRequire(import.meta.url);
const core = require("../functions/shared/shopify-sync-core.cjs");
const worker = require("../functions/shared/shopify-sync-worker.cjs");

type Args = Record<string, string | boolean>;

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

function getStringArg(args: Args, key: string, fallback = ""): string {
  const value = args[key];
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  return fallback;
}

function getNumberArg(args: Args, key: string, fallback: number): number {
  const raw = getStringArg(args, key, String(fallback));
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function showHelp() {
  console.log(`Execute queued Shopify sync requests from Firestore collection: shopify_sync

Usage:
  bun scripts/shopify-sync-worker.ts [options]

Options:
  --firestore-env <env>      emulator | staging | production (default: emulator)
  --request-doc-id <id>      Process one request document ID
  --limit <n>                Max queued docs to process when no request-doc-id (default: 10)
  --processor <name>         Processor label for audit (default: cli-worker)
  --help                     Show help

Required env vars for Shopify API:
  SHOPIFY_STORE_URL
  SHOPIFY_ACCESS_TOKEN
  SHOPIFY_API_VERSION (optional, default 2024-01)
`);
}

async function initFirestore(firestoreEnv: string) {
  if (firestoreEnv === "emulator") {
    const app = initializeApp({ projectId: process.env.FIREBASE_EMULATOR_PROJECT_ID || "dobutsu-admin" }, `shopify-sync-worker-${Date.now()}`);
    const db = getFirestore(app);
    db.settings({ host: process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080", ssl: false });
    return db;
  }

  const keyPath = resolve(process.cwd(), `service-account-${firestoreEnv}.json`);
  if (!existsSync(keyPath)) {
    throw new Error(`Missing service account key: ${keyPath}`);
  }

  const serviceAccount = JSON.parse(readFileSync(keyPath, "utf8"));
  const app = initializeApp({ credential: cert(serviceAccount) }, `shopify-sync-worker-${firestoreEnv}-${Date.now()}`);
  return getFirestore(app);
}

function buildShopifyConfig() {
  const storeUrl = core.normalizeStoreUrl(process.env.SHOPIFY_STORE_URL || "");
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN || "";
  const apiVersion = process.env.SHOPIFY_API_VERSION || "2024-01";

  if (!storeUrl || !accessToken) {
    throw new Error("Missing SHOPIFY_STORE_URL or SHOPIFY_ACCESS_TOKEN");
  }

  return { storeUrl, accessToken, apiVersion };
}

async function processOne(db: any, docId: string, processor: string, shopifyConfig: any) {
  const docRef = db.collection("shopify_sync").doc(docId);
  const snap = await docRef.get();
  if (!snap.exists) {
    console.log(`Skipped ${docId}: missing`);
    return;
  }
  const data = snap.data() as any;
  if (data?.eventType !== "sync_requested") {
    console.log(`Skipped ${docId}: eventType=${data?.eventType || "unknown"}`);
    return;
  }

  const result = await worker.processRequestEvent({
    db,
    requestEventId: docId,
    requestData: data,
    processor,
    shopifyConfig,
    creator: processor,
  });

  if (!result.processed) {
    console.log(`Skipped ${docId}: ${result.reason}`);
  } else {
    console.log(`Processed ${docId}:`, result.summary);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    showHelp();
    return;
  }

  const firestoreEnv = getStringArg(args, "firestore-env", "emulator");
  const docId = getStringArg(args, "request-doc-id", "").trim();
  const limit = Math.max(1, getNumberArg(args, "limit", 10));
  const processorName = getStringArg(args, "processor", "cli-worker");
  const processor = `cli:${processorName}`;

  const db = await initFirestore(firestoreEnv);
  const shopifyConfig = buildShopifyConfig();

  if (docId) {
    await processOne(db, docId, processor, shopifyConfig);
    return;
  }

  const queued = await db
    .collection("shopify_sync")
    .where("eventType", "==", "sync_requested")
    .limit(limit)
    .get();

  if (queued.empty) {
    console.log("No queued sync requests found.");
    return;
  }

  for (const doc of queued.docs) {
    await processOne(db, doc.id, processor, shopifyConfig);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
