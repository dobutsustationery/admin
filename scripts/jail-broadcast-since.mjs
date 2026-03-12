#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cert, initializeApp } from "firebase-admin/app";
import {
  FieldPath,
  FieldValue,
  Timestamp,
  getFirestore,
} from "firebase-admin/firestore";

const BROADCAST_COLLECTION = "broadcast";
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

function getStringArg(args, key, fallback = "") {
  const value = args[key];
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  return fallback;
}

function showHelp() {
  console.log(`Move broadcast docs at/after a timestamp into a jail collection.

Usage:
  node scripts/jail-broadcast-since.mjs --timestamp <ms|iso> --jail-collection <name> [options]

Options:
  --timestamp <value>          Required. Unix ms (e.g. 1735689600000) or ISO-8601
  --jail-collection <name>     Required. Target top-level collection name
  --firestore-env <env>        emulator | staging | production (default: production)
  --batch-size <n>             Docs per page/batch (default: 200, max: 250)
  --dry-run                    Report how many docs would be moved, make no writes
  --help                       Show help
`);
}

function parseCutoffTimestamp(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) throw new Error("Missing --timestamp");

  if (/^\d+$/.test(trimmed)) {
    const millis = Number(trimmed);
    if (!Number.isFinite(millis)) {
      throw new Error(`Invalid numeric timestamp: ${trimmed}`);
    }
    return Timestamp.fromMillis(millis);
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid timestamp format: ${trimmed}`);
  }
  return Timestamp.fromMillis(parsed);
}

function validateJailCollection(name) {
  const value = String(name || "").trim();
  if (!value) throw new Error("Missing --jail-collection");
  if (value === BROADCAST_COLLECTION) {
    throw new Error('--jail-collection cannot be "broadcast"');
  }
  if (value.includes("/")) {
    throw new Error("--jail-collection must be a top-level collection name");
  }
  return value;
}

async function initFirestore(firestoreEnv) {
  console.log(`[jail-broadcast] initFirestore start env=${firestoreEnv}`);
  if (firestoreEnv === "emulator") {
    console.log("[jail-broadcast] using emulator configuration");
    const app = initializeApp(
      {
        projectId: process.env.FIREBASE_EMULATOR_PROJECT_ID || "dobutsu-admin",
      },
      `jail-broadcast-${Date.now()}`,
    );
    console.log("[jail-broadcast] firebase app initialized (emulator)");
    const db = getFirestore(app);
    console.log("[jail-broadcast] firestore client created (emulator)");
    db.settings({
      host: process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080",
      ssl: false,
    });
    console.log(
      `[jail-broadcast] firestore emulator host=${process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080"}`,
    );
    console.log("[jail-broadcast] initFirestore complete (emulator)");
    return db;
  }

  const keyPath = resolve(
    process.cwd(),
    `service-account-${firestoreEnv}.json`,
  );
  console.log(
    `[jail-broadcast] using service account credentials path=${keyPath}`,
  );
  if (!existsSync(keyPath)) {
    throw new Error(`Missing service account key: ${keyPath}`);
  }

  console.log("[jail-broadcast] reading service account key");
  const serviceAccount = JSON.parse(readFileSync(keyPath, "utf8"));
  console.log("[jail-broadcast] service account key parsed");
  const app = initializeApp(
    { credential: cert(serviceAccount) },
    `jail-broadcast-${firestoreEnv}-${Date.now()}`,
  );
  console.log("[jail-broadcast] firebase app initialized (service account)");
  const db = getFirestore(app);
  console.log("[jail-broadcast] firestore client created (service account)");
  console.log("[jail-broadcast] initFirestore complete");
  return db;
}

async function main() {
  console.log("[jail-broadcast] start");
  const args = parseArgs(process.argv.slice(2));
  console.log("[jail-broadcast] args parsed");
  if (args.help) {
    showHelp();
    return;
  }

  const firestoreEnv = getStringArg(args, "firestore-env", "production");
  const jailCollection = validateJailCollection(
    getStringArg(args, "jail-collection"),
  );
  const cutoff = parseCutoffTimestamp(getStringArg(args, "timestamp"));
  const dryRun = Boolean(args["dry-run"]);
  const parsedBatchSize = Number(getStringArg(args, "batch-size", "200"));
  const batchSize = Math.max(
    1,
    Math.min(250, Number.isFinite(parsedBatchSize) ? parsedBatchSize : 200),
  );
  console.log("[jail-broadcast] arguments validated");

  console.log("[jail-broadcast] initializing firestore client...");
  const db = await initFirestore(firestoreEnv);
  console.log("[jail-broadcast] firestore client ready");

  const cutoffDate = cutoff.toDate();
  console.log(
    `[jail-broadcast] env=${firestoreEnv} cutoff=${cutoffDate.toISOString()} (${cutoff.toMillis()}) jail=${jailCollection} batchSize=${batchSize} dryRun=${dryRun}`,
  );

  let moved = 0;
  let seen = 0;
  let batches = 0;
  let lastDoc = null;

  while (true) {
    console.log(
      `[jail-broadcast] building query for batch=${batches + 1} lastDoc=${lastDoc ? lastDoc.id : "none"}`,
    );
    let q = db
      .collection(BROADCAST_COLLECTION)
      .where("timestamp", ">=", cutoff)
      .orderBy("timestamp")
      .orderBy(FieldPath.documentId())
      .limit(batchSize);

    if (lastDoc) {
      console.log(
        `[jail-broadcast] applying cursor startAfter docId=${lastDoc.id}`,
      );
      q = q.startAfter(lastDoc);
    }

    console.log("[jail-broadcast] executing query...");
    const snap = await q.get();
    console.log(
      `[jail-broadcast] query complete docs=${snap.size} empty=${snap.empty}`,
    );
    if (snap.empty) break;

    batches++;
    seen += snap.size;
    lastDoc = snap.docs[snap.docs.length - 1];
    console.log(
      `[jail-broadcast] processing batch=${batches} firstDoc=${snap.docs[0]?.id || "n/a"} lastDoc=${lastDoc?.id || "n/a"} totalSeen=${seen}`,
    );

    if (dryRun) {
      console.log(
        `[jail-broadcast] dry-run batch=${batches} docs=${snap.size} totalSeen=${seen}`,
      );
      continue;
    }

    const batch = db.batch();
    console.log(
      `[jail-broadcast] assembling write batch=${batches} docs=${snap.size}`,
    );
    for (const docSnap of snap.docs) {
      const sourceRef = db.collection(BROADCAST_COLLECTION).doc(docSnap.id);
      const jailRef = db.collection(jailCollection).doc(docSnap.id);
      const data = docSnap.data();

      batch.set(jailRef, {
        ...data,
        jailedFrom: BROADCAST_COLLECTION,
        jailedAtMs: Date.now(),
        jailedAt: FieldValue.serverTimestamp(),
      });
      batch.delete(sourceRef);
    }
    console.log(`[jail-broadcast] committing write batch=${batches}`);
    await batch.commit();
    console.log(`[jail-broadcast] commit complete batch=${batches}`);
    moved += snap.size;
    console.log(
      `[jail-broadcast] moved batch=${batches} docs=${snap.size} totalMoved=${moved}`,
    );
  }

  if (dryRun) {
    console.log(`[jail-broadcast] dry-run complete. matchingDocs=${seen}`);
  } else {
    console.log(`[jail-broadcast] complete. movedDocs=${moved}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
