#!/usr/bin/env node

import fs from "fs";
import path from "path";

function usage() {
  console.log(`Analyze replay-generated garbage actions in a Firestore JSON export.

Usage:
  node scripts/analyze-replay-garbage-actions.mjs <firestore-export.json|backup-dir>

The script reports:
  - definite replay garbage:
    - photos/fail_upload with requestId timeout-recovery-*
    - photos/complete_upload with requestId idempotent-resolve-*
  - likely replay churn:
    - photos/initiate_upload / photo-transfer-* after a photo already completed once
    - request_photos_transfer docs after a photo already completed once
  - broader suspicious volume:
    - all broadcast actions with requestId prefixes tied to PhotoUploadManager replay
`);
}

function resolveInput(inputArg) {
  if (!inputArg) {
    usage();
    process.exit(1);
  }

  const resolved = path.resolve(process.cwd(), inputArg);
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    return path.join(resolved, "firestore-export.json");
  }
  return resolved;
}

function readExport(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function timestampToMs(ts) {
  if (!ts || ts._timestamp !== true) return null;
  return ts._seconds * 1000 + Math.floor((ts._nanoseconds || 0) / 1e6);
}

function requestPrefix(requestId) {
  if (!requestId) return "";
  if (requestId.startsWith("timeout-recovery-")) return "timeout-recovery";
  if (requestId.startsWith("idempotent-resolve-")) return "idempotent-resolve";
  if (requestId.startsWith("photo-transfer-")) return "photo-transfer";
  return "";
}

function iso(ms) {
  return ms == null ? "" : new Date(ms).toISOString();
}

function pad(num) {
  return String(num).padStart(6);
}

function main() {
  const filePath = resolveInput(process.argv[2]);
  const data = readExport(filePath);

  const broadcastDocs = data.collections?.broadcast?.documents || [];
  const transferDocs = data.collections?.request_photos_transfer?.documents || [];

  const actions = broadcastDocs
    .map((doc) => {
      const action = doc.data || {};
      const payload = action.payload || {};
      return {
        docId: doc.id,
        type: action.type || "",
        payload,
        requestId: String(payload.requestId || ""),
        prefix: requestPrefix(String(payload.requestId || "")),
        photoId: String(payload.id || ""),
        ms: timestampToMs(action.timestamp),
      };
    })
    .filter((action) => action.ms != null)
    .sort((a, b) => a.ms - b.ms || String(a.docId).localeCompare(String(b.docId)));

  const firstCompleteUploadMsByPhoto = new Map();
  for (const action of actions) {
    if (action.type === "photos/complete_upload" && action.photoId) {
      if (!firstCompleteUploadMsByPhoto.has(action.photoId)) {
        firstCompleteUploadMsByPhoto.set(action.photoId, action.ms);
      }
    }
  }

  const totals = {
    totalActions: actions.length,
    definiteGarbage: 0,
    definiteTimeoutRecoveryFails: 0,
    definiteIdempotentResolves: 0,
    suspiciousReplayPrefixActions: 0,
    suspiciousPhotoTransferActions: 0,
    likelyInitiatesAfterComplete: 0,
    likelyInitiatesAfterCompleteUniqueIds: new Set(),
    likelyFailsAfterComplete: 0,
    likelyFailsAfterCompleteUniqueIds: new Set(),
  };

  const suspiciousByType = new Map();
  const suspiciousByDay = new Map();
  const sessionGapMs = 20 * 60 * 1000;
  const sessions = [];

  for (const action of actions) {
    if (action.prefix) {
      totals.suspiciousReplayPrefixActions += 1;
      suspiciousByType.set(
        action.type,
        (suspiciousByType.get(action.type) || 0) + 1,
      );

      const day = new Date(action.ms).toISOString().slice(0, 10);
      const dayBucket = suspiciousByDay.get(day) || {
        count: 0,
        timeout: 0,
        idem: 0,
        transfer: 0,
      };
      dayBucket.count += 1;
      if (action.prefix === "timeout-recovery") dayBucket.timeout += 1;
      if (action.prefix === "idempotent-resolve") dayBucket.idem += 1;
      if (action.prefix === "photo-transfer") dayBucket.transfer += 1;
      suspiciousByDay.set(day, dayBucket);

      let session = sessions[sessions.length - 1];
      if (!session || action.ms - session.lastMs > sessionGapMs) {
        session = {
          startMs: action.ms,
          lastMs: action.ms,
          count: 0,
          prefixes: new Map(),
          types: new Map(),
          ids: new Set(),
        };
        sessions.push(session);
      }
      session.lastMs = action.ms;
      session.count += 1;
      session.prefixes.set(
        action.prefix,
        (session.prefixes.get(action.prefix) || 0) + 1,
      );
      session.types.set(action.type, (session.types.get(action.type) || 0) + 1);
      if (action.photoId) session.ids.add(action.photoId);
    }

    if (action.prefix === "timeout-recovery") {
      totals.definiteGarbage += 1;
      totals.definiteTimeoutRecoveryFails += 1;
    }

    if (action.prefix === "idempotent-resolve") {
      totals.definiteGarbage += 1;
      totals.definiteIdempotentResolves += 1;
    }

    if (action.prefix === "photo-transfer") {
      totals.suspiciousPhotoTransferActions += 1;
      const firstCompleteMs = firstCompleteUploadMsByPhoto.get(action.photoId);

      if (
        action.type === "photos/initiate_upload" &&
        firstCompleteMs != null &&
        action.ms > firstCompleteMs
      ) {
        totals.likelyInitiatesAfterComplete += 1;
        totals.likelyInitiatesAfterCompleteUniqueIds.add(action.photoId);
      }

      if (
        action.type === "photos/fail_upload" &&
        firstCompleteMs != null &&
        action.ms > firstCompleteMs
      ) {
        totals.likelyFailsAfterComplete += 1;
        totals.likelyFailsAfterCompleteUniqueIds.add(action.photoId);
      }
    }
  }

  let transferRequestsAfterComplete = 0;
  const transferRequestsAfterCompleteIds = new Set();
  let transferRequestsFromUploadManager = 0;

  for (const doc of transferDocs) {
    const request = doc.data || {};
    if (String(request.source || "") === "photo-upload-manager") {
      transferRequestsFromUploadManager += 1;
    }

    const photoId = String(request.photoId || request.payload?.photoId || "");
    const requestMs =
      timestampToMs(request.timestamp) ||
      request.createdAtMs ||
      request.requestedAt ||
      null;

    const firstCompleteMs = firstCompleteUploadMsByPhoto.get(photoId);
    if (
      photoId &&
      requestMs != null &&
      firstCompleteMs != null &&
      requestMs > firstCompleteMs
    ) {
      transferRequestsAfterComplete += 1;
      transferRequestsAfterCompleteIds.add(photoId);
    }
  }

  const topSessions = [...sessions]
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map((session) => ({
      start: iso(session.startMs),
      end: iso(session.lastMs),
      minutes: Math.round((session.lastMs - session.startMs) / 60000),
      count: session.count,
      uniquePhotoIds: session.ids.size,
      prefixes: Object.fromEntries([...session.prefixes.entries()].sort()),
      types: Object.fromEntries(
        [...session.types.entries()].sort((a, b) => b[1] - a[1]),
      ),
    }));

  const suspiciousByTypeSorted = [...suspiciousByType.entries()].sort(
    (a, b) => b[1] - a[1],
  );
  const suspiciousByDaySorted = [...suspiciousByDay.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );

  console.log(`Replay Garbage Report`);
  console.log(`Backup: ${filePath}`);
  console.log(`Broadcast actions: ${actions.length}`);
  console.log(`Photos transfer requests: ${transferDocs.length}`);
  console.log("");

  console.log(`Definite replay garbage`);
  console.log(
    `  ${pad(totals.definiteGarbage)} actions (${(
      (totals.definiteGarbage / totals.totalActions) *
      100
    ).toFixed(2)}% of all broadcast actions)`,
  );
  console.log(
    `  ${pad(totals.definiteTimeoutRecoveryFails)} photos/fail_upload timeout-recovery-*`,
  );
  console.log(
    `  ${pad(totals.definiteIdempotentResolves)} photos/complete_upload idempotent-resolve-*`,
  );
  console.log("");

  console.log(`Broader replay-related churn`);
  console.log(
    `  ${pad(totals.suspiciousReplayPrefixActions)} suspicious broadcast actions with replay prefixes`,
  );
  console.log(
    `  ${pad(totals.suspiciousPhotoTransferActions)} of those are photo-transfer-* actions`,
  );
  console.log(
    `  ${pad(totals.likelyInitiatesAfterComplete)} likely redundant photos/initiate_upload after prior completion (${totals.likelyInitiatesAfterCompleteUniqueIds.size} unique photos)`,
  );
  console.log(
    `  ${pad(totals.likelyFailsAfterComplete)} likely bogus photos/fail_upload after prior completion (${totals.likelyFailsAfterCompleteUniqueIds.size} unique photos)`,
  );
  console.log(
    `  ${pad(transferRequestsAfterComplete)} request_photos_transfer docs after prior completion (${transferRequestsAfterCompleteIds.size} unique photos)`,
  );
  console.log(
    `  ${pad(transferRequestsFromUploadManager)} request_photos_transfer docs sourced from photo-upload-manager`,
  );
  console.log("");

  console.log(`Suspicious action types`);
  for (const [type, count] of suspiciousByTypeSorted) {
    console.log(`  ${pad(count)} ${type}`);
  }
  console.log("");

  console.log(`Suspicious activity by day`);
  for (const [day, bucket] of suspiciousByDaySorted) {
    console.log(
      `  ${day}  total=${pad(bucket.count)} transfer=${pad(bucket.transfer)} idem=${pad(bucket.idem)} timeout=${pad(bucket.timeout)}`,
    );
  }
  console.log("");

  console.log(`Largest suspicious bursts (20 minute gap heuristic)`);
  for (const session of topSessions) {
    console.log(
      `  ${session.start} .. ${session.end}  count=${pad(session.count)} uniquePhotos=${pad(session.uniquePhotoIds)} minutes=${String(session.minutes).padStart(4)}`,
    );
    console.log(`    prefixes=${JSON.stringify(session.prefixes)}`);
    console.log(`    types=${JSON.stringify(session.types)}`);
  }
}

main();
