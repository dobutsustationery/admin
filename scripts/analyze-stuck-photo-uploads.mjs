#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const DEFAULT_LIMIT_PER_PHOTO = 200;
const REQUEST_COLLECTION = "request_photos_transfer";
const SYNC_COLLECTION = "sync";
const BROADCAST_COLLECTION = "broadcast";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      if (args[key] === undefined) args[key] = true;
      else if (Array.isArray(args[key])) args[key].push(true);
      else args[key] = [args[key], true];
      continue;
    }
    if (args[key] === undefined) args[key] = next;
    else if (Array.isArray(args[key])) args[key].push(next);
    else args[key] = [args[key], next];
    i++;
  }
  return args;
}

function getStringArg(args, key, fallback = "") {
  const value = args[key];
  if (Array.isArray(value)) return String(value[value.length - 1] || fallback);
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  return fallback;
}

function getStringListArg(args, key) {
  const value = args[key];
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return [String(value).trim()].filter(Boolean);
}

function asMs(value) {
  if (!value) return 0;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Timestamp) return value.toMillis();
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (
    typeof value === "object" &&
    Number.isFinite(value.seconds) &&
    Number.isFinite(value.nanoseconds)
  ) {
    return value.seconds * 1000 + Math.floor(value.nanoseconds / 1_000_000);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function fmtMs(ms) {
  if (!ms || !Number.isFinite(ms)) return "n/a";
  return new Date(ms).toISOString();
}

function showHelp() {
  console.log(`Analyze stuck photo uploads by tracing request/sync/broadcast timelines.

Read-only: this script only performs Firestore reads.

Usage:
  node scripts/analyze-stuck-photo-uploads.mjs --photo-id <id> [--photo-id <id> ...] [options]
  node scripts/analyze-stuck-photo-uploads.mjs --photo-ids <id1,id2,...> [options]

Options:
  --photo-id <id>               Photo ID (repeatable)
  --photo-ids <csv>             Comma-separated list of Photo IDs
  --firestore-env <env>         emulator | staging | production (default: production)
  --limit-per-photo <n>         Max request docs to inspect per photo (default: ${DEFAULT_LIMIT_PER_PHOTO})
  --fallback-scan <n>           If direct query misses, scan recent N request docs (default: 3000)
  --help                        Show help
`);
}

async function initFirestore(firestoreEnv) {
  if (firestoreEnv === "emulator") {
    const app = initializeApp(
      {
        projectId: process.env.FIREBASE_EMULATOR_PROJECT_ID || "dobutsu-admin",
      },
      `analyze-stuck-photo-uploads-${Date.now()}`,
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
    `analyze-stuck-photo-uploads-${firestoreEnv}-${Date.now()}`,
  );
  return getFirestore(app);
}

async function queryRequestsForPhoto(db, photoId, limitPerPhoto, fallbackScanLimit) {
  const direct = await db
    .collection(REQUEST_COLLECTION)
    .where("photoId", "==", photoId)
    .limit(limitPerPhoto)
    .get();

  let docs = direct.docs;

  if (docs.length === 0 && fallbackScanLimit > 0) {
    const scanned = await db
      .collection(REQUEST_COLLECTION)
      .orderBy("createdAtMs", "desc")
      .limit(fallbackScanLimit)
      .get();
    docs = scanned.docs.filter((d) => {
      const data = d.data() || {};
      return (
        String(data.photoId || "").trim() === photoId ||
        String(data?.payload?.photoId || "").trim() === photoId
      );
    });
  }

  return docs
    .map((doc) => {
      const data = doc.data() || {};
      return {
        id: doc.id,
        requestId: String(data.requestId || "").trim(),
        eventType: String(data.eventType || "").trim(),
        createdAtMs: asMs(data.createdAtMs || data.createdAt || data.timestamp),
        sourceBaseUrl:
          String(data?.payload?.sourceBaseUrl || data?.sourceBaseUrl || "").trim(),
        sourceType: String(data?.payload?.sourceType || "").trim(),
        raw: data,
      };
    })
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
}

async function querySyncForRequest(db, request) {
  const byRequestId = request.requestId
    ? await db.collection(SYNC_COLLECTION).where("requestId", "==", request.requestId).get()
    : { docs: [] };
  const byRequestEventId = await db
    .collection(SYNC_COLLECTION)
    .where("requestEventId", "==", request.id)
    .get();

  const seen = new Set();
  const combined = [];
  for (const doc of [...byRequestId.docs, ...byRequestEventId.docs]) {
    if (seen.has(doc.id)) continue;
    seen.add(doc.id);
    const data = doc.data() || {};
    const eventType = String(data.eventType || "").trim();
    if (!eventType.startsWith("photos/")) continue;
    combined.push({
      id: doc.id,
      eventType,
      requestId: String(data.requestId || "").trim(),
      requestEventId: String(data.requestEventId || "").trim(),
      createdAtMs: asMs(data.createdAtMs || data.createdAt || data.timestamp),
      payload: data.payload || {},
    });
  }
  combined.sort((a, b) => a.createdAtMs - b.createdAtMs);
  return combined;
}

async function queryBroadcastForPhoto(db, photoId) {
  const q = await db.collection(BROADCAST_COLLECTION).where("payload.id", "==", photoId).get();
  const rows = q.docs
    .map((doc) => {
      const data = doc.data() || {};
      return {
        id: doc.id,
        type: String(data.type || "").trim(),
        requestId: String(data?.payload?.requestId || "").trim(),
        createdAtMs: asMs(data.createdAtMs || data.createdAt || data.timestamp),
        payload: data.payload || {},
      };
    })
    .filter((row) =>
      [
        "photos/initiate_upload",
        "photos/complete_upload",
        "photos/fail_upload",
        "photos/complete_edit",
        "photos/fail_edit",
      ].includes(row.type),
    )
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
  return rows;
}

function summarizeRequest(request, syncEvents, broadcastRows) {
  const has = (suffix) => syncEvents.some((e) => e.eventType.endsWith(suffix));
  const hasStarted = has("image_transfer_started");
  const hasCompleted = has("image_transfer_completed");
  const hasFailed = has("image_transfer_failed");
  const hasSecretRequired = has("image_transfer_secret_required");
  const hasSecretProvided = has("image_transfer_secret_provided");
  const lastSync = syncEvents[syncEvents.length - 1] || null;

  const requestBroadcast = broadcastRows.filter(
    (b) => b.requestId && request.requestId && b.requestId === request.requestId,
  );
  const hasInitiate = requestBroadcast.some((b) => b.type === "photos/initiate_upload");
  const hasCompleteUpload = requestBroadcast.some((b) => b.type === "photos/complete_upload");
  const hasFailUpload = requestBroadcast.some((b) => b.type === "photos/fail_upload");

  const findings = [];
  if (hasSecretRequired && !hasSecretProvided) {
    findings.push("waiting_for_secret");
  }
  if (hasStarted && !hasCompleted && !hasFailed) {
    findings.push("started_no_terminal_event");
  }
  if (!hasStarted && !hasCompleted && !hasFailed && hasSecretProvided) {
    findings.push("secret_provided_but_no_reprocess");
  }
  if (hasCompleted && !hasCompleteUpload) {
    findings.push("completed_in_sync_but_missing_complete_upload_broadcast");
  }
  if (hasFailed && !hasFailUpload) {
    findings.push("failed_in_sync_but_missing_fail_upload_broadcast");
  }
  if (hasInitiate && !hasCompleteUpload && !hasFailUpload && !hasCompleted && !hasFailed) {
    findings.push("initiated_without_terminal_state");
  }

  return {
    request,
    hasStarted,
    hasCompleted,
    hasFailed,
    hasSecretRequired,
    hasSecretProvided,
    lastSync,
    hasInitiate,
    hasCompleteUpload,
    hasFailUpload,
    findings,
  };
}

function printTimeline(label, rows, mapper) {
  if (!rows.length) {
    console.log(`  ${label}: none`);
    return;
  }
  console.log(`  ${label}:`);
  for (const row of rows) {
    console.log(`    - ${mapper(row)}`);
  }
}

async function analyzePhoto(db, photoId, options) {
  const { limitPerPhoto, fallbackScanLimit } = options;
  console.log(`\n=== Photo ${photoId} ===`);
  const requests = await queryRequestsForPhoto(
    db,
    photoId,
    limitPerPhoto,
    fallbackScanLimit,
  );
  const broadcastRows = await queryBroadcastForPhoto(db, photoId);

  if (requests.length === 0) {
    console.log("  No request_photos_transfer docs found for this photo.");
    printTimeline(
      "Broadcast",
      broadcastRows,
      (b) =>
        `${fmtMs(b.createdAtMs)} ${b.type} req=${b.requestId || "n/a"} doc=${b.id}`,
    );
    return;
  }

  const syncByRequestDocId = new Map();
  for (const request of requests) {
    const syncRows = await querySyncForRequest(db, request);
    syncByRequestDocId.set(request.id, syncRows);
  }

  console.log(`  Requests found: ${requests.length}`);
  for (const request of requests) {
    const syncRows = syncByRequestDocId.get(request.id) || [];
    const summary = summarizeRequest(request, syncRows, broadcastRows);
    const findingText =
      summary.findings.length > 0 ? summary.findings.join(", ") : "none";

    console.log(
      `  Request ${request.id} reqId=${request.requestId || "n/a"} created=${fmtMs(request.createdAtMs)} sourceType=${request.sourceType || "n/a"}`,
    );
    console.log(`    Findings: ${findingText}`);
    console.log(
      `    Flags: started=${summary.hasStarted} completed=${summary.hasCompleted} failed=${summary.hasFailed} secret_required=${summary.hasSecretRequired} secret_provided=${summary.hasSecretProvided} broadcast_complete=${summary.hasCompleteUpload} broadcast_fail=${summary.hasFailUpload}`,
    );
    if (summary.lastSync) {
      console.log(
        `    Last sync: ${fmtMs(summary.lastSync.createdAtMs)} ${summary.lastSync.eventType} doc=${summary.lastSync.id}`,
      );
    } else {
      console.log("    Last sync: none");
    }

    printTimeline(
      "Sync timeline",
      syncRows,
      (e) =>
        `${fmtMs(e.createdAtMs)} ${e.eventType} reqId=${e.requestId || "n/a"} reqEventId=${e.requestEventId || "n/a"} doc=${e.id}`,
    );

    const requestBroadcast = broadcastRows.filter(
      (b) => b.requestId && request.requestId && b.requestId === request.requestId,
    );
    printTimeline(
      "Broadcast timeline (same requestId)",
      requestBroadcast,
      (b) => `${fmtMs(b.createdAtMs)} ${b.type} doc=${b.id}`,
    );
  }

  const latestBroadcast = broadcastRows[broadcastRows.length - 1] || null;
  console.log(
    `  Latest broadcast state: ${latestBroadcast ? `${latestBroadcast.type} at ${fmtMs(latestBroadcast.createdAtMs)} (req=${latestBroadcast.requestId || "n/a"})` : "none"}`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    showHelp();
    return;
  }

  const firestoreEnv = getStringArg(args, "firestore-env", "production");
  const limitPerPhotoRaw = Number(getStringArg(args, "limit-per-photo", String(DEFAULT_LIMIT_PER_PHOTO)));
  const fallbackScanRaw = Number(getStringArg(args, "fallback-scan", "3000"));
  const limitPerPhoto = Number.isFinite(limitPerPhotoRaw)
    ? Math.max(1, Math.min(5000, limitPerPhotoRaw))
    : DEFAULT_LIMIT_PER_PHOTO;
  const fallbackScanLimit = Number.isFinite(fallbackScanRaw)
    ? Math.max(0, Math.min(20000, fallbackScanRaw))
    : 3000;

  const repeated = getStringListArg(args, "photo-id");
  const csv = getStringArg(args, "photo-ids", "");
  const csvIds = csv
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const photoIds = [...new Set([...repeated, ...csvIds])];

  if (photoIds.length === 0) {
    throw new Error("Provide at least one --photo-id or --photo-ids.");
  }

  console.log("[analyze-stuck-photo-uploads] start");
  console.log(
    `[analyze-stuck-photo-uploads] env=${firestoreEnv} photoCount=${photoIds.length} limitPerPhoto=${limitPerPhoto} fallbackScan=${fallbackScanLimit}`,
  );
  console.log("[analyze-stuck-photo-uploads] mode=READ_ONLY");

  const db = await initFirestore(firestoreEnv);
  console.log("[analyze-stuck-photo-uploads] firestore client ready");

  for (const photoId of photoIds) {
    await analyzePhoto(db, photoId, { limitPerPhoto, fallbackScanLimit });
  }

  console.log("\n[analyze-stuck-photo-uploads] done");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

