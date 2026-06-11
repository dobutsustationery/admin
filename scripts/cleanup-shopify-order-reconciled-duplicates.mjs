#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { cert, initializeApp } from "firebase-admin/app";
import { FieldPath, FieldValue, getFirestore } from "firebase-admin/firestore";

const ACTION_TYPE = "shopify_order_reconciled";
const BROADCAST_COLLECTION = "broadcast";
const DEFAULT_BACKUP = "../production-backup-jun-04";
const DEFAULT_JAIL_COLLECTION =
  "broadcast_jail_shopify_order_reconciled_duplicates";

function parseArgs(argv) {
  const args = {};
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

function showHelp() {
  console.log(`Analyze or jail exact duplicate Shopify reconciliation broadcast rows.

Default mode is read-only backup analysis.

Usage:
  node scripts/cleanup-shopify-order-reconciled-duplicates.mjs [options]

Analysis options:
  --backup <path>             Backup dir or firestore-export.json path
                              (default: ${DEFAULT_BACKUP})
  --write-manifest <path>     Write duplicate doc manifest JSON

Execution options:
  --execute                   Move manifest docs out of broadcast into jail collection
  --manifest <path>           Manifest produced by --write-manifest
  --firestore-env <env>       emulator | staging | production (default: production)
  --jail-collection <name>    Target top-level archive collection
                              (default: ${DEFAULT_JAIL_COLLECTION})
  --batch-size <n>            Docs per write batch (default: 200, max: 250)
  --force                     Required with --execute

Safety:
  Execute mode verifies every live document still has the expected type and raw
  payload hash before moving it. It never deletes unmatched live rows.
`);
}

function stringArg(args, key, fallback = "") {
  const value = args[key];
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  return fallback;
}

function resolveExportPath(input) {
  const resolved = path.resolve(process.cwd(), input || DEFAULT_BACKUP);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Backup path does not exist: ${resolved}`);
  }
  if (fs.statSync(resolved).isDirectory()) {
    return path.join(resolved, "firestore-export.json");
  }
  return resolved;
}

function normalizeCollectionDocuments(collectionPayload) {
  if (!collectionPayload) return [];
  if (Array.isArray(collectionPayload)) return collectionPayload;
  if (Array.isArray(collectionPayload.documents)) {
    return collectionPayload.documents;
  }
  return [];
}

function timestampNanos(data) {
  const ts = data?.timestamp || {};
  if (typeof ts._seconds === "number") {
    return BigInt(ts._seconds) * 1_000_000_000n + BigInt(ts._nanoseconds || 0);
  }
  if (typeof ts.seconds === "number") {
    return BigInt(ts.seconds) * 1_000_000_000n + BigInt(ts.nanoseconds || 0);
  }
  return 0n;
}

function timestampMillis(data) {
  const ts = data?.timestamp || {};
  if (typeof ts._seconds === "number") {
    return ts._seconds * 1000 + Math.floor((ts._nanoseconds || 0) / 1_000_000);
  }
  if (typeof ts.seconds === "number") {
    return ts.seconds * 1000 + Math.floor((ts.nanoseconds || 0) / 1_000_000);
  }
  if (typeof ts.toMillis === "function") return ts.toMillis();
  return 0;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    out[key] = stable(value[key]);
  }
  return out;
}

function stableHash(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stable(value || {})))
    .digest("hex");
}

function rawOrderVersionKey(rawOrder) {
  const orderId = String(rawOrder?.id || rawOrder?.admin_graphql_api_id || "");
  const version = String(rawOrder?.updated_at || rawOrder?.created_at || "");
  return `${orderId}\t${version}\t${stableHash(rawOrder)}`;
}

function actionRawOrder(data) {
  return data?.payload?.raw || {};
}

function sortExportDocsForReplay(a, b) {
  const timeA = timestampNanos(a.data);
  const timeB = timestampNanos(b.data);
  if (timeA < timeB) return -1;
  if (timeA > timeB) return 1;
  return String(a.id).localeCompare(String(b.id));
}

function analyzeBackup(exportPath) {
  const exportData = JSON.parse(fs.readFileSync(exportPath, "utf8"));
  const broadcastDocs = normalizeCollectionDocuments(
    exportData.collections?.[BROADCAST_COLLECTION],
  );
  const reconcileDocs = broadcastDocs
    .filter((doc) => doc.data?.type === ACTION_TYPE)
    .sort(sortExportDocsForReplay);

  const groups = new Map();
  for (const doc of reconcileDocs) {
    const rawOrder = actionRawOrder(doc.data);
    const key = rawOrderVersionKey(rawOrder);
    const docs = groups.get(key) || [];
    docs.push(doc);
    groups.set(key, docs);
  }

  const keep = [];
  const removableDuplicates = [];
  const duplicateGroups = [];
  let exactDuplicateDocs = 0;
  let keptLatestDuplicateDocs = 0;

  for (const [versionKey, docs] of groups.entries()) {
    const [orderId, version, rawHash] = versionKey.split("\t");
    const keeper = docs[0];
    keep.push(keeper);
    if (docs.length <= 1) continue;

    exactDuplicateDocs += docs.length - 1;
    const latestDuplicateDoc = docs[docs.length - 1];
    const removableDocs = docs.slice(1, -1);
    keptLatestDuplicateDocs += 1;
    duplicateGroups.push({
      orderId,
      version,
      rawHash,
      keepDocId: keeper.id,
      latestDuplicateDocId: latestDuplicateDoc.id,
      exactDuplicateCount: docs.length - 1,
      removableDuplicateCount: removableDocs.length,
      totalCount: docs.length,
      removableDocIds: removableDocs.map((doc) => doc.id),
    });

    for (const doc of removableDocs) {
      removableDuplicates.push({
        docId: doc.id,
        orderId,
        version,
        rawHash,
        keepDocId: keeper.id,
        latestDuplicateDocId: latestDuplicateDoc.id,
        broadcastTimestampMs: timestampMillis(doc.data),
        creator: doc.data?.creator || "",
      });
    }
  }

  duplicateGroups.sort(
    (a, b) => b.removableDuplicateCount - a.removableDuplicateCount,
  );

  return {
    generatedAt: new Date().toISOString(),
    exportPath,
    rule: "Exact duplicate shopify_order_reconciled raw payload version; keep earliest broadcast doc per order/version/raw-hash group, and keep the latest duplicate doc in each duplicated group to preserve current stale-reconcile exception-clearing behavior.",
    totals: {
      broadcastDocs: broadcastDocs.length,
      shopifyOrderReconciledDocs: reconcileDocs.length,
      uniqueRawOrderVersions: groups.size,
      keptDocs: keep.length,
      exactDuplicateDocs,
      keptLatestDuplicateDocs,
      removableDuplicateDocs: removableDuplicates.length,
      duplicateGroups: duplicateGroups.length,
    },
    duplicateGroups,
    duplicates: removableDuplicates,
  };
}

function printAnalysis(analysis) {
  console.log("# Shopify order reconciliation duplicate cleanup");
  console.log(`Backup: ${analysis.exportPath}`);
  console.log("");
  console.log("Rule");
  console.log(`  ${analysis.rule}`);
  console.log("");
  console.log("Totals");
  for (const [key, value] of Object.entries(analysis.totals)) {
    console.log(`  ${key}: ${value}`);
  }
  console.log("");

  const byCreator = new Map();
  const byDay = new Map();
  for (const duplicate of analysis.duplicates) {
    byCreator.set(
      duplicate.creator || "(missing)",
      (byCreator.get(duplicate.creator || "(missing)") || 0) + 1,
    );
    const day = duplicate.broadcastTimestampMs
      ? new Date(duplicate.broadcastTimestampMs).toISOString().slice(0, 10)
      : "unknown";
    byDay.set(day, (byDay.get(day) || 0) + 1);
  }

  console.log("Duplicates by creator");
  for (const [creator, count] of [...byCreator.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )) {
    console.log(`  ${String(count).padStart(6)}  ${creator}`);
  }
  console.log("");

  console.log("Largest duplicate groups");
  for (const group of analysis.duplicateGroups.slice(0, 12)) {
    console.log(
      `  ${String(group.removableDuplicateCount).padStart(6)}  order=${group.orderId} version=${group.version} keep=${group.keepDocId} latest=${group.latestDuplicateDocId}`,
    );
  }
  console.log("");

  console.log("Top duplicate days");
  for (const [day, count] of [...byDay.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 20)) {
    console.log(`  ${String(count).padStart(6)}  ${day}`);
  }
}

function validateJailCollection(name) {
  const value = String(name || "").trim();
  if (!value) throw new Error("Missing jail collection");
  if (value === BROADCAST_COLLECTION) {
    throw new Error("Jail collection cannot be broadcast");
  }
  if (value.includes("/")) {
    throw new Error("Jail collection must be a top-level collection");
  }
  return value;
}

async function initFirestore(firestoreEnv) {
  if (firestoreEnv === "emulator") {
    const app = initializeApp(
      {
        projectId: process.env.FIREBASE_EMULATOR_PROJECT_ID || "dobutsu-admin",
      },
      `shopify-reconcile-cleanup-${Date.now()}`,
    );
    const db = getFirestore(app);
    db.settings({
      host: process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080",
      ssl: false,
    });
    return db;
  }

  const keyPath = path.resolve(
    process.cwd(),
    `service-account-${firestoreEnv}.json`,
  );
  if (!fs.existsSync(keyPath)) {
    throw new Error(`Missing service account key: ${keyPath}`);
  }
  const serviceAccount = JSON.parse(fs.readFileSync(keyPath, "utf8"));
  const app = initializeApp(
    { credential: cert(serviceAccount) },
    `shopify-reconcile-cleanup-${firestoreEnv}-${Date.now()}`,
  );
  return getFirestore(app);
}

function assertManifestShape(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Manifest is not an object");
  }
  if (!Array.isArray(manifest.duplicates)) {
    throw new Error("Manifest missing duplicates array");
  }
  for (const duplicate of manifest.duplicates) {
    if (!duplicate.docId || !duplicate.rawHash || !duplicate.keepDocId) {
      throw new Error(
        `Malformed duplicate entry: ${JSON.stringify(duplicate)}`,
      );
    }
  }
}

async function executeManifest(args) {
  if (!args.force) {
    throw new Error("--execute requires --force");
  }
  const manifestPath = stringArg(args, "manifest");
  if (!manifestPath) {
    throw new Error("--execute requires --manifest");
  }

  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), manifestPath), "utf8"),
  );
  assertManifestShape(manifest);

  const firestoreEnv = stringArg(args, "firestore-env", "production");
  const jailCollection = validateJailCollection(
    stringArg(args, "jail-collection", DEFAULT_JAIL_COLLECTION),
  );
  const parsedBatchSize = Number(stringArg(args, "batch-size", "200"));
  const batchSize = Math.max(
    1,
    Math.min(250, Number.isFinite(parsedBatchSize) ? parsedBatchSize : 200),
  );

  console.log(
    `[shopify-reconcile-cleanup] env=${firestoreEnv} duplicates=${manifest.duplicates.length} jail=${jailCollection} batchSize=${batchSize}`,
  );
  const db = await initFirestore(firestoreEnv);

  let moved = 0;
  let skipped = 0;
  let batch = db.batch();
  let batchCount = 0;

  async function commitIfNeeded(force = false) {
    if (batchCount === 0) return;
    if (!force && batchCount < batchSize) return;
    await batch.commit();
    console.log(
      `[shopify-reconcile-cleanup] committed ${batchCount} moves; totalMoved=${moved}`,
    );
    batch = db.batch();
    batchCount = 0;
  }

  for (let i = 0; i < manifest.duplicates.length; i += 300) {
    const chunk = manifest.duplicates.slice(i, i + 300);
    const refs = chunk.map((duplicate) =>
      db.collection(BROADCAST_COLLECTION).doc(duplicate.docId),
    );
    const snapshots = await db.getAll(...refs);

    for (let j = 0; j < snapshots.length; j++) {
      const duplicate = chunk[j];
      const snap = snapshots[j];
      if (!snap.exists) {
        skipped++;
        console.warn(
          `[shopify-reconcile-cleanup] skip missing ${duplicate.docId}`,
        );
        continue;
      }

      const data = snap.data();
      const rawHash = stableHash(actionRawOrder(data));
      if (data?.type !== ACTION_TYPE || rawHash !== duplicate.rawHash) {
        skipped++;
        console.warn(
          `[shopify-reconcile-cleanup] skip changed ${duplicate.docId} type=${data?.type} rawHash=${rawHash}`,
        );
        continue;
      }

      const sourceRef = db
        .collection(BROADCAST_COLLECTION)
        .doc(duplicate.docId);
      const jailRef = db.collection(jailCollection).doc(duplicate.docId);
      batch.set(jailRef, {
        ...data,
        jailedFrom: BROADCAST_COLLECTION,
        jailedReason: "exact_duplicate_shopify_order_reconciled",
        jailedAtMs: Date.now(),
        jailedAt: FieldValue.serverTimestamp(),
        duplicateOfBroadcastDocId: duplicate.keepDocId,
        duplicateOrderId: duplicate.orderId,
        duplicateVersion: duplicate.version,
        duplicateRawHash: duplicate.rawHash,
      });
      batch.delete(sourceRef);
      moved++;
      batchCount++;
      await commitIfNeeded();
    }
  }

  await commitIfNeeded(true);
  console.log(
    `[shopify-reconcile-cleanup] complete moved=${moved} skipped=${skipped}`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    showHelp();
    return;
  }

  if (args.execute) {
    await executeManifest(args);
    return;
  }

  const exportPath = resolveExportPath(
    stringArg(args, "backup", DEFAULT_BACKUP),
  );
  const analysis = analyzeBackup(exportPath);
  printAnalysis(analysis);

  const manifestPath = stringArg(args, "write-manifest");
  if (manifestPath) {
    const resolvedManifestPath = path.resolve(process.cwd(), manifestPath);
    fs.writeFileSync(resolvedManifestPath, JSON.stringify(analysis, null, 2));
    console.log("");
    console.log(`Manifest written: ${resolvedManifestPath}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
