#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initializeApp, cert } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { rootReducer } from "../src/lib/root-reducer";
import { generateSku } from "../src/lib/handle-utils";

const SYNC_COLLECTION = "sync";
const SHOPIFY_SYNC_REQUEST_EVENT = "shopify/sync_requested";

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

function showHelp() {
  console.log(`Queue a Shopify sync request into Firestore sync queue ("sync")

Usage:
  bun scripts/shopify-sync-request.ts --handle <listing-handle> [options]

Options:
  --handle <handle>            Listing handle to sync (required)
  --firestore-env <env>        emulator | staging | production (default: emulator)
  --requested-by <id>          Actor ID for audit (default: shopify-sync-cli)
  --source <name>              Source tag (default: cli)
  --help                       Show help
`);
}

async function initFirestore(firestoreEnv: string) {
  if (firestoreEnv === "emulator") {
    const app = initializeApp(
      {
        projectId: process.env.FIREBASE_EMULATOR_PROJECT_ID || "dobutsu-admin",
      },
      `shopify-sync-request-${Date.now()}`,
    );
    const db = getFirestore(app);
    db.settings({
      host: process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080",
      ssl: false,
    });
    return db;
  }

  const keyPath = resolve(
    process.cwd(),
    `service-account-${firestoreEnv}.json`,
  );
  if (!existsSync(keyPath)) {
    throw new Error(`Missing service account key: ${keyPath}`);
  }

  const serviceAccount = JSON.parse(readFileSync(keyPath, "utf8"));
  const app = initializeApp(
    { credential: cert(serviceAccount) },
    `shopify-sync-request-${firestoreEnv}-${Date.now()}`,
  );
  return getFirestore(app);
}

async function replayState(db: any) {
  const snapshot = await db.collection("broadcast").orderBy("timestamp").get();
  let state = rootReducer(undefined, { type: "INIT" });
  snapshot.docs.forEach((doc: any) => {
    const action = doc.data();
    state = rootReducer(state, action);
  });
  return state;
}

function buildRequestPayload(
  state: any,
  handle: string,
  requestedBy: string,
  source: string,
) {
  const listing = state?.listings?.handleToListing?.[handle];
  if (!listing) {
    throw new Error(`Listing not found for handle: ${handle}`);
  }

  const inventory = state?.inventory?.idToItem || {};
  const idToHandle = state?.listings?.idToHandle || {};

  const variants = Object.entries(inventory)
    .filter(([id]) => idToHandle[id] === handle)
    .map(([id, item]: [string, any]) => {
      const janCode = String(item?.janCode || "").trim();
      const subtype = String(item?.subtype || "").trim();
      const qty = Number(item?.qty || 0);
      const shipped = Number(item?.shipped || 0);
      return {
        itemId: id,
        sku: generateSku(janCode, subtype),
        janCode,
        subtype,
        available: Math.max(0, qty - shipped),
        price: Number(item?.price || 0),
        weight: Number(item?.weight || 0),
        image: String(item?.image || ""),
      };
    })
    .filter((v) => !!v.itemId && !!v.sku && !!v.janCode);

  if (variants.length === 0) {
    throw new Error(`No variants found for handle: ${handle}`);
  }

  const requestId = `sync-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  return {
    eventType: SHOPIFY_SYNC_REQUEST_EVENT,
    requestId,
    handle,
    listing: {
      handle,
      title: String(listing.title || ""),
      bodyHtml: String(listing.bodyHtml || ""),
      productCategory: String(listing.productCategory || ""),
      option1Name: String(listing.option1Name || "Subtype"),
      productType: String(listing.productType || ""),
      vendor: String(listing.vendor || "SPNSS Ltd."),
      tags: Array.isArray(listing.tags) ? listing.tags : [],
      status: String(listing.status || "active"),
      images: Array.isArray(listing.images) ? listing.images : [],
    },
    variants,
    source,
    creator: requestedBy,
    requestedBy,
    requestedAt: Date.now(),
    payloadVersion: 1,
    createdAtMs: Date.now(),
    createdAt: FieldValue.serverTimestamp(),
    timestamp: FieldValue.serverTimestamp(),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    showHelp();
    return;
  }

  const handle = getStringArg(args, "handle").trim();
  if (!handle) {
    showHelp();
    throw new Error("Missing --handle");
  }

  const firestoreEnv = getStringArg(args, "firestore-env", "emulator");
  const requestedBy = getStringArg(args, "requested-by", "shopify-sync-cli");
  const source = getStringArg(args, "source", "cli");

  const db = await initFirestore(firestoreEnv);
  const state = await replayState(db);
  const payload = buildRequestPayload(state, handle, requestedBy, source);

  const docRef = await db.collection(SYNC_COLLECTION).add(payload);
  console.log(
    `Queued request ${payload.requestId} in ${SYNC_COLLECTION}/${docRef.id}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
