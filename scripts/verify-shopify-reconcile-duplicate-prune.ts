#!/usr/bin/env bun

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { rootReducer } from "../src/lib/root-reducer";

const backupArg = process.argv[2] || "../production-backup-jun-04";
const manifestArg =
  process.argv[3] || "/tmp/shopify-order-reconciled-duplicates-jun-04.json";

function resolveExportPath(input: string): string {
  const resolved = path.resolve(process.cwd(), input);
  if (fs.statSync(resolved).isDirectory()) {
    return path.join(resolved, "firestore-export.json");
  }
  return resolved;
}

function normalizeCollectionDocuments(collectionPayload: any): any[] {
  if (!collectionPayload) return [];
  if (Array.isArray(collectionPayload)) return collectionPayload;
  if (Array.isArray(collectionPayload.documents)) {
    return collectionPayload.documents;
  }
  return [];
}

function timestampNanos(data: any): bigint {
  const ts = data?.timestamp || {};
  if (typeof ts._seconds === "number") {
    return BigInt(ts._seconds) * 1_000_000_000n + BigInt(ts._nanoseconds || 0);
  }
  if (typeof ts.seconds === "number") {
    return BigInt(ts.seconds) * 1_000_000_000n + BigInt(ts.nanoseconds || 0);
  }
  return 0n;
}

function stable(value: any): any {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, any> = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    out[key] = stable(value[key]);
  }
  return out;
}

function stableHash(value: any): string {
  const serialized = JSON.stringify(stable(value));
  return crypto
    .createHash("sha256")
    .update(serialized === undefined ? "undefined" : serialized)
    .digest("hex");
}

function replayProjection(state: any): any {
  return {
    inventory: state?.inventory || {},
  };
}

function inventorySubstructures(state: any): Record<string, any> {
  const inventory = state?.inventory || {};
  return {
    idToItem: inventory.idToItem || {},
    idToHistory: inventory.idToHistory || {},
    orderIdToOrder: inventory.orderIdToOrder || {},
    costLedger: inventory.costLedger || {},
    shopifyExceptions: inventory.shopifyExceptions || {},
    keyIdentity: inventory.keyIdentity || {},
  };
}

function findFirstObjectDifference(a: any, b: any): string {
  const aKeys = Object.keys(a || {}).sort();
  const bKeys = Object.keys(b || {}).sort();
  const all = Array.from(new Set([...aKeys, ...bKeys])).sort();
  for (const key of all) {
    if (stableHash(a?.[key]) !== stableHash(b?.[key])) return key;
  }
  return "";
}

function replay(actions: any[]): any {
  let state: any = rootReducer(undefined, { type: "@@INIT" });
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  for (let i = 0; i < actions.length; i++) {
    try {
      state = rootReducer(state, actions[i], () => {});
    } catch (error) {
      originalConsole.warn(
        `Replay error on action ${i} (${actions[i]?.type || "unknown"}): ${
          (error as Error).message
        }`,
      );
    }
  }
  console.log = originalConsole.log;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
  return state;
}

const exportPath = resolveExportPath(backupArg);
const manifestPath = path.resolve(process.cwd(), manifestArg);

console.log(`Loading backup: ${exportPath}`);
const backup = JSON.parse(fs.readFileSync(exportPath, "utf8"));
const broadcastDocs = normalizeCollectionDocuments(
  backup.collections?.broadcast,
);
const actions = broadcastDocs
  .map((doc) => ({ id: doc.id, ...doc.data }))
  .sort((a, b) => {
    const ta = timestampNanos(a);
    const tb = timestampNanos(b);
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });

console.log(`Loading manifest: ${manifestPath}`);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const duplicateIds = new Set(
  (manifest.duplicates || []).map((duplicate: any) => String(duplicate.docId)),
);

const filteredActions = actions.filter(
  (action) => !duplicateIds.has(action.id),
);
console.log(`Original actions: ${actions.length}`);
console.log(`Filtered actions: ${filteredActions.length}`);
console.log(`Removed actions: ${actions.length - filteredActions.length}`);

console.log("Replaying original state...");
const originalState = replay(actions);
const originalHash = stableHash(replayProjection(originalState));

console.log("Replaying filtered state...");
const filteredState = replay(filteredActions);
const filteredHash = stableHash(replayProjection(filteredState));

console.log(`Original inventory/order projection hash: ${originalHash}`);
console.log(`Filtered inventory/order projection hash: ${filteredHash}`);

if (originalHash !== filteredHash) {
  const originalParts = inventorySubstructures(originalState);
  const filteredParts = inventorySubstructures(filteredState);
  for (const key of Object.keys(originalParts)) {
    const beforeHash = stableHash(originalParts[key]);
    const afterHash = stableHash(filteredParts[key]);
    if (beforeHash === afterHash) {
      console.error(`  ${key}: identical`);
    } else {
      console.error(`  ${key}: differs`);
      const firstDifference = findFirstObjectDifference(
        originalParts[key],
        filteredParts[key],
      );
      if (firstDifference) {
        console.error(`    first differing key: ${firstDifference}`);
        console.error(
          `    original: ${JSON.stringify(stable(originalParts[key][firstDifference])).slice(0, 1000)}`,
        );
        console.error(
          `    filtered: ${JSON.stringify(stable(filteredParts[key][firstDifference])).slice(0, 1000)}`,
        );
      }
    }
  }
  console.error(
    "Inventory/order projection differs after filtering duplicate reconcile rows.",
  );
  process.exit(1);
}

console.log(
  "Inventory/order projection is identical after filtering duplicate reconcile rows.",
);
