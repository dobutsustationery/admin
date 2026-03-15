#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    file: "test-data/check-timestamps.json",
    collections: null,
    allCollections: false,
    maxExamples: 5,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--file") {
      args.file = argv[++i];
      continue;
    }
    if (arg === "--collections") {
      args.collections = String(argv[++i] || "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      continue;
    }
    if (arg === "--all-collections") {
      args.allCollections = true;
      continue;
    }
    if (arg === "--max-examples") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) args.maxExamples = Math.floor(n);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelpAndExit(0);
    }
    console.error(`Unknown argument: ${arg}`);
    printHelpAndExit(1);
  }

  return args;
}

function printHelpAndExit(code) {
  console.log(`Usage:
  node scripts/check-event-log-timestamps.mjs [options]

Options:
  --file <path>              Backup JSON file (default: test-data/check-timestamps.json)
  --collections a,b,c        Explicit collection list
  --all-collections          Check every collection in backup
  --max-examples <n>         Max missing examples per collection (default: 5)
`);
  process.exit(code);
}

function isTimestampObject(value) {
  if (!value || typeof value !== "object") return false;

  // Export format from firestore export helper
  if (
    value._timestamp === true &&
    typeof value._seconds === "number" &&
    typeof value._nanoseconds === "number"
  ) {
    return true;
  }

  // Alternate serialized format occasionally seen in logs/tooling
  if (
    value.type === "firestore/timestamp/1.0" &&
    typeof value.seconds === "number" &&
    typeof value.nanoseconds === "number"
  ) {
    return true;
  }

  // Plain object timestamp shape
  if (
    typeof value.seconds === "number" &&
    typeof value.nanoseconds === "number"
  ) {
    return true;
  }

  return false;
}

function toCollectionMap(raw) {
  if (raw && typeof raw === "object" && raw.collections) {
    return raw.collections;
  }
  return raw;
}

function defaultEventCollections(collectionMap) {
  const defaults = ["broadcast", "sync"];
  return defaults.filter((name) => Array.isArray(collectionMap?.[name]));
}

function main() {
  const args = parseArgs(process.argv);
  const absFile = path.resolve(args.file);
  const raw = JSON.parse(fs.readFileSync(absFile, "utf8"));
  const collectionMap = toCollectionMap(raw);

  if (!collectionMap || typeof collectionMap !== "object") {
    throw new Error("Backup file does not contain a collections object");
  }

  let targetCollections = [];
  if (args.allCollections) {
    targetCollections = Object.keys(collectionMap).filter((k) =>
      Array.isArray(collectionMap[k]),
    );
  } else if (args.collections && args.collections.length > 0) {
    targetCollections = args.collections;
  } else {
    targetCollections = defaultEventCollections(collectionMap);
  }

  if (targetCollections.length === 0) {
    console.log("No matching collections found to inspect.");
    process.exit(0);
  }

  console.log(`[timestamp-audit] file=${absFile}`);
  console.log(
    `[timestamp-audit] collections=${targetCollections.join(",")} maxExamples=${args.maxExamples}`,
  );

  let totalDocs = 0;
  let totalMissing = 0;
  let totalInvalid = 0;

  for (const name of targetCollections) {
    const docs = Array.isArray(collectionMap[name]) ? collectionMap[name] : [];
    let missing = 0;
    let invalid = 0;
    const examples = [];

    for (const doc of docs) {
      const docId = String(doc?.id || "");
      const data = doc?.data || {};
      const ts = data?.timestamp;
      if (ts === undefined) {
        missing += 1;
        if (examples.length < args.maxExamples) {
          examples.push({ id: docId, reason: "missing_timestamp_field" });
        }
        continue;
      }
      if (!isTimestampObject(ts)) {
        invalid += 1;
        if (examples.length < args.maxExamples) {
          examples.push({
            id: docId,
            reason: "invalid_timestamp_shape",
            sample: ts,
          });
        }
      }
    }

    totalDocs += docs.length;
    totalMissing += missing;
    totalInvalid += invalid;

    console.log(
      `\n[${name}] docs=${docs.length} missing=${missing} invalid=${invalid} ok=${docs.length - missing - invalid}`,
    );
    if (examples.length > 0) {
      console.log(`[${name}] examples:`);
      for (const ex of examples) {
        console.log(`  - ${JSON.stringify(ex)}`);
      }
    }
  }

  console.log(
    `\n[timestamp-audit] totalDocs=${totalDocs} missing=${totalMissing} invalid=${totalInvalid} ok=${totalDocs - totalMissing - totalInvalid}`,
  );

  process.exit(totalMissing === 0 && totalInvalid === 0 ? 0 : 2);
}

main();
