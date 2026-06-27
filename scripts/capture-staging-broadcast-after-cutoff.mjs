/**
 * Capture broadcast docs whose timestamp is after a cutoff.
 *
 * The original use was staging-only cleanup after a fixed production backup
 * cutoff. The script is now parameterized so it can also capture a production
 * tail after the latest local backup and optionally write a combined replay
 * export.
 *
 * Usage:
 *   node scripts/capture-staging-broadcast-after-cutoff.mjs \
 *     --firestore-env production \
 *     --backup /tmp/production-backup-jun26-plus-tail \
 *     --out /tmp/prod-tail.json \
 *     --combined-output /tmp/prod-plus-tail/firestore-export.json
 *
 * Backward-compatible staging default:
 *   node scripts/capture-staging-broadcast-after-cutoff.mjs [out.json]
 */
import { cert, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

const LEGACY_CUTOFF_SECONDS = 1781186781;
const LEGACY_CUTOFF_NANOS = 164000000;

function parseArgs(argv) {
  const args = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  if (positionals[0] && !args.out) args.out = positionals[0];
  return args;
}

function usage() {
  console.log(`Capture broadcast docs after a cutoff.

Options:
  --firestore-env <env>       staging | production | emulator (default: staging)
  --backup <path>             Backup directory or firestore-export.json; cutoff is max broadcast timestamp
  --timestamp <value>         Explicit cutoff: ISO string, millis, or seconds.nanoseconds
  --out <path>                Tail output JSON (default: staging-after-cutoff-backup.json)
  --combined-output <path>    Optional combined backup + tail firestore-export.json
  --help                      Show this help

Examples:
  node scripts/capture-staging-broadcast-after-cutoff.mjs --firestore-env production \\
    --backup /tmp/production-backup-jun26-plus-tail --out /tmp/prod-tail.json

  node scripts/capture-staging-broadcast-after-cutoff.mjs --firestore-env production \\
    --backup /tmp/production-backup-jun26-plus-tail \\
    --combined-output /tmp/production-backup-jun26-plus-latest/firestore-export.json
`);
}

function backupFilePath(path) {
  const resolved = resolve(process.cwd(), path);
  if (resolved.endsWith(".json")) return resolved;
  return resolve(resolved, "firestore-export.json");
}

function normalizeTimestamp(value) {
  if (!value) return null;
  if (value instanceof Timestamp) {
    return { seconds: value.seconds, nanoseconds: value.nanoseconds };
  }
  if (value._timestamp === true && typeof value._seconds === "number") {
    return {
      seconds: value._seconds,
      nanoseconds: Number(value._nanoseconds) || 0,
    };
  }
  if (typeof value._seconds === "number") {
    return {
      seconds: value._seconds,
      nanoseconds: Number(value._nanoseconds) || 0,
    };
  }
  if (typeof value.seconds === "number") {
    return {
      seconds: value.seconds,
      nanoseconds: Number(value.nanoseconds) || 0,
    };
  }
  return null;
}

function compareTimestamps(a, b) {
  if (a.seconds !== b.seconds) return a.seconds - b.seconds;
  return a.nanoseconds - b.nanoseconds;
}

function parseExplicitCutoff(value) {
  if (!value) return null;
  if (/^\d+\.\d+$/.test(value)) {
    const [seconds, nanoseconds] = value.split(".");
    return {
      seconds: Number(seconds),
      nanoseconds: Number(nanoseconds.padEnd(9, "0").slice(0, 9)),
    };
  }
  if (/^\d+$/.test(value)) {
    const millis = Number(value);
    if (millis > 10_000_000_000) {
      return {
        seconds: Math.floor(millis / 1000),
        nanoseconds: (millis % 1000) * 1_000_000,
      };
    }
    return { seconds: millis, nanoseconds: 0 };
  }
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) {
    return {
      seconds: Math.floor(parsed / 1000),
      nanoseconds: (parsed % 1000) * 1_000_000,
    };
  }
  throw new Error(`Could not parse cutoff timestamp: ${value}`);
}

function formatTimestamp(timestamp) {
  return `${timestamp.seconds}.${String(timestamp.nanoseconds).padStart(9, "0")}`;
}

function timestampToIso(timestamp) {
  return new Timestamp(timestamp.seconds, timestamp.nanoseconds)
    .toDate()
    .toISOString();
}

function readBackup(path) {
  const file = backupFilePath(path);
  if (!existsSync(file)) throw new Error(`Backup not found: ${file}`);
  const backup = JSON.parse(readFileSync(file, "utf8"));
  const documents = backup.collections?.broadcast?.documents;
  if (!Array.isArray(documents)) {
    throw new Error(`Backup has no collections.broadcast.documents: ${file}`);
  }
  return { file, backup, documents };
}

function cutoffFromBackup(path) {
  const { file, documents } = readBackup(path);
  let max = null;
  let maxDocument = null;
  for (const document of documents) {
    const timestamp = normalizeTimestamp(document.data?.timestamp);
    if (!timestamp) continue;
    if (!max || compareTimestamps(timestamp, max) > 0) {
      max = timestamp;
      maxDocument = document;
    }
  }
  if (!max) throw new Error(`No usable broadcast timestamps in backup: ${file}`);
  return { cutoff: max, backupFile: file, maxDocument };
}

function serializeFirestoreData(data) {
  return JSON.parse(
    JSON.stringify(data, (_key, value) => {
      if (value instanceof Timestamp) {
        return {
          _timestamp: true,
          _seconds: value.seconds,
          _nanoseconds: value.nanoseconds,
        };
      }
      if (value && typeof value === "object" && "_seconds" in value) {
        return {
          _timestamp: true,
          _seconds: value._seconds,
          _nanoseconds: value._nanoseconds || 0,
        };
      }
      return value;
    }),
  );
}

function sortBroadcastDocuments(documents) {
  return [...documents].sort((a, b) => {
    const aTs = normalizeTimestamp(a.data?.timestamp);
    const bTs = normalizeTimestamp(b.data?.timestamp);
    if (aTs && bTs) {
      const comparison = compareTimestamps(aTs, bTs);
      if (comparison !== 0) return comparison;
    } else if (aTs) {
      return -1;
    } else if (bTs) {
      return 1;
    }
    return String(a.id).localeCompare(String(b.id));
  });
}

async function initFirestore(firestoreEnv) {
  if (firestoreEnv === "emulator") {
    process.env.FIRESTORE_EMULATOR_HOST =
      process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
    const app = initializeApp(
      { projectId: process.env.FIREBASE_PROJECT_ID || "demo-test-project" },
      `capture-broadcast-${firestoreEnv}-${Date.now()}`,
    );
    return getFirestore(app);
  }

  if (!["staging", "production"].includes(firestoreEnv)) {
    throw new Error(
      `Invalid --firestore-env ${firestoreEnv}; expected staging, production, or emulator`,
    );
  }

  const keyPath = resolve(
    process.cwd(),
    `service-account-${firestoreEnv}.json`,
  );
  if (!existsSync(keyPath)) {
    throw new Error(`Service account key not found: ${keyPath}`);
  }
  const app = initializeApp(
    { credential: cert(JSON.parse(readFileSync(keyPath, "utf8"))) },
    `capture-broadcast-${firestoreEnv}-${Date.now()}`,
  );
  return getFirestore(app);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  usage();
  process.exit(0);
}

const firestoreEnv = String(args["firestore-env"] || "staging");
const outPath = resolve(
  process.cwd(),
  String(args.out || "staging-after-cutoff-backup.json"),
);

let cutoff;
let cutoffSource = "legacy";
let backupInfo = null;

if (args.backup) {
  backupInfo = cutoffFromBackup(String(args.backup));
  cutoff = backupInfo.cutoff;
  cutoffSource = backupInfo.backupFile;
} else if (args.timestamp) {
  cutoff = parseExplicitCutoff(String(args.timestamp));
  cutoffSource = "--timestamp";
} else {
  cutoff = {
    seconds: LEGACY_CUTOFF_SECONDS,
    nanoseconds: LEGACY_CUTOFF_NANOS,
  };
}

const cutoffTimestamp = new Timestamp(cutoff.seconds, cutoff.nanoseconds);
const db = await initFirestore(firestoreEnv);

const total = (await db.collection("broadcast").count().get()).data().count;
const snap = await db
  .collection("broadcast")
  .where("timestamp", ">", cutoffTimestamp)
  .orderBy("timestamp", "asc")
  .get();

const documents = [];
snap.forEach((doc) =>
  documents.push({ id: doc.id, data: serializeFirestoreData(doc.data()) }),
);

const out = {
  capturedAt: new Date().toISOString(),
  firestoreEnv,
  cutoffSource,
  cutoff: {
    _seconds: cutoff.seconds,
    _nanoseconds: cutoff.nanoseconds,
  },
  collections: { broadcast: { documents } },
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(out, null, 2));

let combinedPath = null;
if (args["combined-output"]) {
  if (!args.backup) {
    throw new Error("--combined-output requires --backup");
  }
  const { backup } = readBackup(String(args.backup));
  const existingById = new Map(
    backup.collections.broadcast.documents.map((document) => [
      document.id,
      document,
    ]),
  );
  for (const document of documents) existingById.set(document.id, document);
  backup.collections.broadcast.documents = sortBroadcastDocuments(
    Array.from(existingById.values()),
  );
  backup.exportedAt = new Date().toISOString();
  backup.tailCapture = {
    capturedAt: out.capturedAt,
    firestoreEnv,
    cutoffSource,
    cutoff: out.cutoff,
    tailDocumentCount: documents.length,
  };

  combinedPath = resolve(process.cwd(), String(args["combined-output"]));
  mkdirSync(dirname(combinedPath), { recursive: true });
  writeFileSync(combinedPath, JSON.stringify(backup, null, 2));
}

console.log(`Environment: ${firestoreEnv}`);
console.log(`Cutoff source: ${cutoffSource}`);
console.log(`Cutoff: ${timestampToIso(cutoff)} (${formatTimestamp(cutoff)})`);
if (backupInfo?.maxDocument) {
  console.log(
    `Backup max doc: ${backupInfo.maxDocument.id} ${backupInfo.maxDocument.data?.type || ""}`,
  );
}
console.log(`Broadcast total in ${firestoreEnv}: ${total}`);
console.log(`After-cutoff docs captured: ${documents.length}`);
console.log(`Expected total before cutoff/in backup: ${total - documents.length}`);
console.log(`Wrote tail: ${outPath}`);
if (combinedPath) console.log(`Wrote combined export: ${combinedPath}`);
process.exit(0);
