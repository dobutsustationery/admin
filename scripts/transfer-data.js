#!/usr/bin/env node

/**
 * Data Transfer Tool for Dobutsu Admin
 *
 * Transfers Firestore data between environments (production → staging/emulator)
 *
 * This script exports data from a source Firestore instance and imports it
 * to a target Firestore instance. It's useful for:
 * - Populating staging with production data for testing
 * - Seeding the local emulator with real data
 * - Creating backups of production data
 *
 * Usage:
 *   npm run data:export -- --source production --output ./data-export
 *   npm run data:import -- --target emulator --input ./data-export
 *   npm run data:transfer -- --from production --to staging
 *
 * Collections transferred:
 * - All top-level collections (discovered dynamically)
 * - All nested subcollections (exported recursively)
 *
 * Note: Requires service account keys for non-emulator environments
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

// Parse command line arguments
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const key = args[i].substring(2);
    const nextArg = args[i + 1];
    if (!nextArg || nextArg.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = nextArg;
      i++;
    }
  }
}

// Command types
const COMMAND_EXPORT = "export";
const COMMAND_IMPORT = "import";
const COMMAND_TRANSFER = "transfer";

// Determine command
let command = null;
if (options.source && options.output) {
  command = COMMAND_EXPORT;
} else if (options.target && options.input) {
  command = COMMAND_IMPORT;
} else if (options.from && options.to) {
  command = COMMAND_TRANSFER;
}

if (!command) {
  console.error("❌ Invalid command options");
  console.log("\nUsage:");
  console.log("  Export:   --source <env> --output <directory>");
  console.log("  Import:   --target <env> --input <directory>");
  console.log("  Transfer: --from <env> --to <env>");
  console.log("\nEnvironments: production | staging | emulator");
  console.log("\nOptions:");
  console.log(
    "  --skip-broadcast     Skip the broadcast collection (not recommended)",
  );
  console.log("  --skip-users         Skip the users collection");
  console.log("  --skip-orders        Skip the dobutsu (orders) collection");
  console.log(
    "  --recursive-subcollections  Recursively export subcollections for all collections",
  );
  console.log(
    "  --append             Resume import by timestamp, overwriting from the latest target document",
  );
  console.log(
    "  --force              Required when importing/transferring to production",
  );
  process.exit(1);
}

// Configuration
const config = {
  skipBroadcast: options["skip-broadcast"] === true,
  skipUsers: options["skip-users"] === true,
  skipOrders: options["skip-orders"] === true,
  recursiveSubcollections: options["recursive-subcollections"] === true,
  append: options.append === true,
  force: options.force === true,
};

console.log("🔧 Configuration:", config);

const BATCH_SIZE = 100; // Firestore batch limit

function shouldSkipTopLevelCollection(collectionName) {
  if (config.skipBroadcast && collectionName === "broadcast") {
    return true;
  }
  if (config.skipUsers && collectionName === "users") {
    return true;
  }
  if (config.skipOrders && collectionName === "dobutsu") {
    return true;
  }
  return false;
}

function serializeFirestoreData(data) {
  return JSON.parse(
    JSON.stringify(data, (key, value) => {
      if (value && typeof value === "object" && value._seconds !== undefined) {
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

function deserializeFirestoreData(data) {
  return JSON.parse(JSON.stringify(data), (key, value) => {
    if (
      value &&
      typeof value === "object" &&
      value._timestamp === true &&
      value._seconds !== undefined
    ) {
      return new Timestamp(value._seconds, value._nanoseconds || 0);
    }
    return value;
  });
}

function normalizeCollectionDocuments(collectionPayload) {
  if (Array.isArray(collectionPayload)) {
    return collectionPayload;
  }
  if (
    collectionPayload &&
    typeof collectionPayload === "object" &&
    Array.isArray(collectionPayload.documents)
  ) {
    return collectionPayload.documents;
  }
  return [];
}

function countExportedDocumentsInCollection(collectionPayload) {
  const documents = normalizeCollectionDocuments(collectionPayload);
  let total = documents.length;
  for (const document of documents) {
    const subcollections = document.subcollections || {};
    for (const subcollectionPayload of Object.values(subcollections)) {
      total += countExportedDocumentsInCollection(subcollectionPayload);
    }
  }
  return total;
}

function normalizeTimestamp(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Timestamp) {
    return {
      seconds: value.seconds,
      nanoseconds: value.nanoseconds,
    };
  }

  if (value._timestamp === true && value._seconds !== undefined) {
    return {
      seconds: value._seconds,
      nanoseconds: value._nanoseconds || 0,
    };
  }

  if (value._seconds !== undefined) {
    return {
      seconds: value._seconds,
      nanoseconds: value._nanoseconds || 0,
    };
  }

  if (typeof value.toMillis === "function") {
    const millis = value.toMillis();
    return {
      seconds: Math.floor(millis / 1000),
      nanoseconds: (millis % 1000) * 1000000,
    };
  }

  return null;
}

function normalizeMillisTimestamp(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const millis = Number(value);
  if (!Number.isFinite(millis)) {
    return null;
  }

  const wholeMillis = Math.trunc(millis);
  return {
    seconds: Math.floor(wholeMillis / 1000),
    nanoseconds: (wholeMillis % 1000) * 1000000,
  };
}

const APPEND_CURSOR_FIELDS = [
  {
    name: "timestamp",
    normalize: normalizeTimestamp,
  },
  {
    name: "createdAtMs",
    normalize: normalizeMillisTimestamp,
  },
];

function compareTimestamps(a, b) {
  if (a.seconds !== b.seconds) {
    return a.seconds - b.seconds;
  }
  return a.nanoseconds - b.nanoseconds;
}

function getExportedDocumentCursor(document, cursorField) {
  return cursorField.normalize(document.data?.[cursorField.name]);
}

function getSortedDocumentsForCursor(documents, cursorField) {
  const cursorEntries = documents.map((document) => ({
    document,
    cursor: getExportedDocumentCursor(document, cursorField),
  }));

  if (cursorEntries.some((entry) => entry.cursor === null)) {
    return null;
  }

  return cursorEntries
    .sort((a, b) => {
      const cursorComparison = compareTimestamps(a.cursor, b.cursor);
      if (cursorComparison !== 0) {
        return cursorComparison;
      }
      return a.document.id.localeCompare(b.document.id);
    })
    .map((entry) => entry.document);
}

function formatTimestampForLog(timestamp) {
  if (!timestamp) {
    return "none";
  }
  return `${timestamp.seconds}.${String(timestamp.nanoseconds).padStart(9, "0")}`;
}

async function selectAppendDocuments(db, collectionPath, documents) {
  let sortedDocuments = null;

  for (const cursorField of APPEND_CURSOR_FIELDS) {
    sortedDocuments = getSortedDocumentsForCursor(documents, cursorField);
    if (sortedDocuments !== null) {
      return await selectAppendDocumentsForCursor(
        db,
        collectionPath,
        sortedDocuments,
        cursorField,
      );
    }
  }

  console.warn(
    `    ⚠️  Append requested for ${collectionPath}, but no cursor field is present on every document; importing full collection`,
  );
  return documents;
}

async function selectMissingAppendDocuments(
  db,
  collectionPath,
  sortedDocuments,
  cursorField,
) {
  const READ_BATCH_SIZE = 300;

  for (
    let offset = 0;
    offset < sortedDocuments.length;
    offset += READ_BATCH_SIZE
  ) {
    const chunk = sortedDocuments.slice(offset, offset + READ_BATCH_SIZE);
    const docRefs = chunk.map((document) =>
      db.doc(`${collectionPath}/${document.id}`),
    );
    const snapshots = await db.getAll(...docRefs);

    const missingIndex = snapshots.findIndex((snapshot) => !snapshot.exists);
    if (missingIndex === -1) {
      continue;
    }

    const firstMissingIndex = offset + missingIndex;
    const resumeIndex = Math.max(0, firstMissingIndex - 1);
    const resumeDocument = sortedDocuments[resumeIndex];

    console.log(
      `    Append: ${collectionPath} resumes by ${cursorField.name} at ${resumeDocument.id} (${formatTimestampForLog(getExportedDocumentCursor(resumeDocument, cursorField))}); first missing ${sortedDocuments[firstMissingIndex].id}; importing ${sortedDocuments.length - resumeIndex}/${sortedDocuments.length} docs`,
    );

    return sortedDocuments.slice(resumeIndex);
  }

  console.log(
    `    Append: ${collectionPath} already contains all ${sortedDocuments.length} ${cursorField.name}-ordered docs; skipping collection`,
  );
  return [];
}

function selectDocumentsFromTargetCursor(
  collectionPath,
  sortedDocuments,
  cursorField,
  latestTargetDocument,
) {
  const latestTargetCursor = cursorField.normalize(
    latestTargetDocument.get(cursorField.name),
  );

  if (!latestTargetCursor) {
    console.warn(
      `    ⚠️  Latest target document ${collectionPath}/${latestTargetDocument.id} has no usable ${cursorField.name}; importing full collection`,
    );
    return sortedDocuments;
  }

  const latestExportDocument = sortedDocuments[sortedDocuments.length - 1];
  const latestExportCursor = getExportedDocumentCursor(
    latestExportDocument,
    cursorField,
  );

  if (compareTimestamps(latestTargetCursor, latestExportCursor) >= 0) {
    return null;
  }

  let resumeIndex = sortedDocuments.findIndex(
    (document) => document.id === latestTargetDocument.id,
  );

  if (resumeIndex === -1) {
    resumeIndex = sortedDocuments.findIndex(
      (document) =>
        compareTimestamps(
          getExportedDocumentCursor(document, cursorField),
          latestTargetCursor,
        ) >= 0,
    );
  }

  if (resumeIndex === -1) {
    return null;
  }

  resumeIndex = Math.max(0, resumeIndex - 1);
  const resumeDocument = sortedDocuments[resumeIndex];

  console.log(
    `    Append: ${collectionPath} resumes by ${cursorField.name} at ${resumeDocument.id} (${formatTimestampForLog(getExportedDocumentCursor(resumeDocument, cursorField))}); importing ${sortedDocuments.length - resumeIndex}/${sortedDocuments.length} docs`,
  );

  return sortedDocuments.slice(resumeIndex);
}

async function getCollectionCount(collectionRef) {
  const snapshot = await collectionRef.count().get();
  return snapshot.data().count;
}

async function selectAppendDocumentsForCursor(
  db,
  collectionPath,
  sortedDocuments,
  cursorField,
) {
  const collectionRef = db.collection(collectionPath);
  let latestTargetDocument;

  try {
    const latestSnapshot = await collectionRef
      .orderBy(cursorField.name, "desc")
      .limit(1)
      .get();
    latestTargetDocument = latestSnapshot.docs[0];
  } catch (error) {
    console.warn(
      `    ⚠️  Could not query ${collectionPath} by ${cursorField.name} for append (${error.message}); importing full collection`,
    );
    return sortedDocuments;
  }

  if (!latestTargetDocument) {
    console.log(
      `    Append: ${collectionPath} is empty; importing all documents`,
    );
    return sortedDocuments;
  }

  const documentsFromCursor = selectDocumentsFromTargetCursor(
    collectionPath,
    sortedDocuments,
    cursorField,
    latestTargetDocument,
  );

  if (documentsFromCursor !== null) {
    return documentsFromCursor;
  }

  let targetCount;
  try {
    targetCount = await getCollectionCount(collectionRef);
  } catch (error) {
    console.warn(
      `    ⚠️  Could not count ${collectionPath} for append (${error.message}); falling back to missing-document scan`,
    );
    return await selectMissingAppendDocuments(
      db,
      collectionPath,
      sortedDocuments,
      cursorField,
    );
  }

  if (targetCount === sortedDocuments.length) {
    console.log(
      `    Append: ${collectionPath} appears complete by ${cursorField.name} and count (${targetCount}); skipping collection`,
    );
    return [];
  }

  console.warn(
    `    ⚠️  Append: ${collectionPath} appears finished by ${cursorField.name}, but target count is ${targetCount}/${sortedDocuments.length}; scanning for first missing document`,
  );
  return await selectMissingAppendDocuments(
    db,
    collectionPath,
    sortedDocuments,
    cursorField,
  );
}

function shouldRecurseSubcollectionsForTopLevel(topLevelCollection) {
  if (config.recursiveSubcollections) {
    return true;
  }
  // Default targeted recursion for known nested structure.
  return topLevelCollection === "google_auth_results";
}

async function exportCollectionRecursive(
  collectionRef,
  collectionPath,
  recurseSubcollections,
) {
  console.log(`\n  Exporting ${collectionPath}...`);
  const snapshot = await collectionRef.get();
  const documents = [];

  const docsSorted = [...snapshot.docs].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  for (const [index, doc] of docsSorted.entries()) {
    const serializedData = serializeFirestoreData(doc.data());
    const exportedDocument = {
      id: doc.id,
      data: serializedData,
    };

    if (recurseSubcollections) {
      const subcollectionRefs = await doc.ref.listCollections();
      const sortedSubcollectionRefs = [...subcollectionRefs].sort((a, b) =>
        a.id.localeCompare(b.id),
      );

      if (sortedSubcollectionRefs.length > 0) {
        exportedDocument.subcollections = {};
        for (const subcollectionRef of sortedSubcollectionRefs) {
          const subcollectionPath = `${collectionPath}/${doc.id}/${subcollectionRef.id}`;
          exportedDocument.subcollections[subcollectionRef.id] =
            await exportCollectionRecursive(
              subcollectionRef,
              subcollectionPath,
              true,
            );
        }
      }
    }

    documents.push(exportedDocument);
    if ((index + 1) % 500 === 0) {
      console.log(
        `    ...${collectionPath}: processed ${index + 1}/${docsSorted.length} docs`,
      );
    }
  }

  console.log(
    `    ✓ Exported ${documents.length} documents from ${collectionPath}`,
  );
  return {
    path: collectionPath,
    documents,
  };
}

async function importCollectionRecursive(
  db,
  collectionPath,
  collectionPayload,
) {
  let documents = normalizeCollectionDocuments(collectionPayload);
  if (documents.length === 0) {
    console.log(`    ✓ Imported 0 documents to ${collectionPath}`);
    return;
  }

  if (config.append) {
    documents = await selectAppendDocuments(db, collectionPath, documents);
    if (documents.length === 0) {
      console.log(`    ✓ Imported 0 documents to ${collectionPath}`);
      return;
    }
  }

  console.log(`\n  Importing ${collectionPath} (${documents.length} docs)...`);

  let batch = db.batch();
  let batchCount = 0;
  const pendingNestedImports = [];

  for (const document of documents) {
    const docRef = db.doc(`${collectionPath}/${document.id}`);
    const deserializedData = deserializeFirestoreData(document.data);

    batch.set(docRef, deserializedData);
    batchCount++;

    if (
      document.subcollections &&
      typeof document.subcollections === "object"
    ) {
      pendingNestedImports.push({
        docPath: `${collectionPath}/${document.id}`,
        subcollections: document.subcollections,
      });
    }

    if (batchCount >= BATCH_SIZE) {
      await batch.commit();
      console.log(`    Committed batch of ${batchCount} documents`);
      batch = db.batch();
      batchCount = 0;
    }
  }

  if (batchCount > 0) {
    await batch.commit();
    console.log(`    Committed final batch of ${batchCount} documents`);
  }

  console.log(
    `    ✓ Imported ${documents.length} documents to ${collectionPath}`,
  );

  for (const nestedImport of pendingNestedImports) {
    const subcollections = Object.entries(nestedImport.subcollections).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    for (const [subcollectionName, subcollectionPayload] of subcollections) {
      const subcollectionPath = `${nestedImport.docPath}/${subcollectionName}`;
      await importCollectionRecursive(
        db,
        subcollectionPath,
        subcollectionPayload,
      );
    }
  }
}

/**
 * Check if writing to production is allowed
 * Requires --force flag and special write credentials
 */
function checkProductionWriteProtection(targetEnv) {
  if (targetEnv !== "production") {
    return; // No protection needed for non-production
  }

  // Check for --force flag
  if (!config.force) {
    console.error("\n❌ ERROR: Writing to production requires --force flag");
    console.error("\n⚠️  PRODUCTION WRITE PROTECTION");
    console.error(
      "   Writing data to production is dangerous and can overwrite live data.",
    );
    console.error(
      "   If you are certain you want to proceed, add --force to your command:",
    );
    console.error(
      `   \n   ${process.argv.slice(0, 2).join(" ")} ${process.argv.slice(2).join(" ")} --force\n`,
    );
    process.exit(1);
  }

  // Check for special write credentials
  const writeKeyPath = resolve(
    process.cwd(),
    "service-account-production-write.json",
  );

  if (!existsSync(writeKeyPath)) {
    console.error("\n❌ ERROR: Production write credentials not found");
    console.error("\n⚠️  PRODUCTION WRITE PROTECTION");
    console.error(
      "   Writing to production requires special write credentials.",
    );
    console.error(`   Expected file: ${writeKeyPath}`);
    console.error(
      "\n   This is separate from the read-only production service account.",
    );
    console.error("   To create write credentials:");
    console.error(
      "   1. Go to Firebase Console > Project Settings > Service Accounts",
    );
    console.error("   2. Create a new service account with write permissions");
    console.error("   3. Save as: service-account-production-write.json");
    console.error("\n   ⚠️  Keep these credentials extremely secure!\n");
    process.exit(1);
  }

  // Final warning
  console.warn("\n⚠️  WARNING: WRITING TO PRODUCTION");
  console.warn("   You are about to write data to the PRODUCTION environment.");
  console.warn("   This will OVERWRITE existing production data.");
  console.warn("   Make sure you have a backup before proceeding.");
  console.warn("");
}

/**
 * Initialize Firebase Admin SDK for a specific environment
 */
function initializeFirebaseForEnv(env, appName = undefined, isWrite = false) {
  if (env === "emulator") {
    // For emulator, use default credentials and connect to emulator
    const app = initializeApp(
      {
        projectId: "dobutsu-admin",
      },
      appName,
    );
    const db = getFirestore(app);

    // Connect to emulator
    const host = process.env.FIRESTORE_EMULATOR_HOST || "localhost:8080";
    db.settings({
      host: host,
      ssl: false,
    });

    console.log(`🔧 Connected to Firestore emulator at ${host}`);
    return db;
  } else {
    // For production/staging, use service account key
    // Production writes require special write credentials
    let keyPath;
    if (env === "production" && isWrite) {
      keyPath = resolve(process.cwd(), "service-account-production-write.json");
    } else {
      keyPath = resolve(process.cwd(), `service-account-${env}.json`);
    }

    if (!existsSync(keyPath)) {
      console.error(`❌ Service account key not found: ${keyPath}`);
      console.log(
        `\n💡 Download from Firebase Console > Project Settings > Service Accounts`,
      );
      console.log(`   Save as: ${keyPath.split("/").pop()}`);
      process.exit(1);
    }

    const serviceAccount = JSON.parse(readFileSync(keyPath, "utf8"));
    const app = initializeApp(
      {
        credential: cert(serviceAccount),
      },
      appName,
    );

    const accessType = env === "production" && isWrite ? " (WRITE ACCESS)" : "";
    console.log(`🔥 Connected to ${env} Firestore${accessType}`);
    return getFirestore(app);
  }
}

/**
 * Export data from a Firestore instance
 */
async function exportData(db, outputDir) {
  console.log(`\n📦 Exporting data to ${outputDir}...`);

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const topLevelCollectionRefs = await db.listCollections();
  const topLevelCollectionNames = topLevelCollectionRefs
    .map((ref) => ref.id)
    .sort((a, b) => a.localeCompare(b))
    .filter((name) => !shouldSkipTopLevelCollection(name));

  console.log(
    `\n  Found ${topLevelCollectionNames.length} top-level collections after filters`,
  );
  for (const collectionName of topLevelCollectionNames) {
    console.log(`    - ${collectionName}`);
  }

  const exportData = {
    exportedAt: new Date().toISOString(),
    collections: {},
  };

  for (const collectionName of topLevelCollectionNames) {
    const collectionRef = db.collection(collectionName);
    const recurseSubcollections =
      shouldRecurseSubcollectionsForTopLevel(collectionName);
    if (recurseSubcollections) {
      console.log(
        `    (subcollection recursion enabled for ${collectionName})`,
      );
    }
    exportData.collections[collectionName] = await exportCollectionRecursive(
      collectionRef,
      collectionName,
      recurseSubcollections,
    );
  }

  const outputFile = join(outputDir, "firestore-export.json");
  writeFileSync(outputFile, JSON.stringify(exportData, null, 2));
  const totalDocuments = Object.values(exportData.collections).reduce(
    (sum, collectionPayload) =>
      sum + countExportedDocumentsInCollection(collectionPayload),
    0,
  );
  console.log(`\n✅ Export complete: ${outputFile}`);
  console.log(
    `   Exported ${Object.keys(exportData.collections).length} collections and ${totalDocuments} total documents (including nested subcollections)`,
  );

  return exportData;
}

/**
 * Import data to a Firestore instance
 */
async function importData(db, inputDir) {
  console.log(`\n📥 Importing data from ${inputDir}...`);

  const inputFile = join(inputDir, "firestore-export.json");

  if (!existsSync(inputFile)) {
    console.error(`❌ Export file not found: ${inputFile}`);
    process.exit(1);
  }

  const exportData = JSON.parse(readFileSync(inputFile, "utf8"));
  console.log(`   Exported at: ${exportData.exportedAt}`);

  const topLevelCollections = Object.entries(exportData.collections).sort(
    ([a], [b]) => a.localeCompare(b),
  );
  for (const [collectionName, collectionPayload] of topLevelCollections) {
    await importCollectionRecursive(db, collectionName, collectionPayload);
  }

  console.log("\n✅ Import complete");
}

/**
 * Main execution
 */
async function main() {
  try {
    if (command === COMMAND_EXPORT) {
      const sourceEnv = options.source;
      const outputDir = resolve(process.cwd(), options.output);

      console.log(`📤 Exporting from ${sourceEnv} to ${outputDir}`);
      const db = initializeFirebaseForEnv(sourceEnv);
      await exportData(db, outputDir);
    } else if (command === COMMAND_IMPORT) {
      const targetEnv = options.target;
      const inputDir = resolve(process.cwd(), options.input);

      // Check production write protection
      checkProductionWriteProtection(targetEnv);

      console.log(`📥 Importing to ${targetEnv} from ${inputDir}`);
      const db = initializeFirebaseForEnv(targetEnv, undefined, true);
      await importData(db, inputDir);
    } else if (command === COMMAND_TRANSFER) {
      const fromEnv = options.from;
      const toEnv = options.to;
      const tempDir = resolve(process.cwd(), ".data-transfer-tmp");

      // Check production write protection
      checkProductionWriteProtection(toEnv);

      console.log(`🔄 Transferring from ${fromEnv} to ${toEnv}`);

      // Export from source
      const sourceDb = initializeFirebaseForEnv(fromEnv, "source");
      await exportData(sourceDb, tempDir);

      // Import to target (with write flag for production)
      const targetDb = initializeFirebaseForEnv(toEnv, "target", true);
      await importData(targetDb, tempDir);

      console.log(`\n✅ Transfer complete from ${fromEnv} to ${toEnv}`);
      console.log(`   Temporary export saved at: ${tempDir}`);
    }

    console.log("\n✨ Done!");
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Error:", error.message);

    // Provide helpful diagnostics for common errors
    if (error.code === 5 || error.message.includes("NOT_FOUND")) {
      console.error("\n💡 Troubleshooting tips:");
      console.error(
        "   - This error usually means a collection doesn't exist in Firestore",
      );
      console.error(
        "   - Check that your service account has permission to read from Firestore",
      );
      console.error(
        "   - Verify you're connecting to the correct Firebase project",
      );
      console.error(
        "   - Make sure the collections exist in your Firestore database",
      );
    } else if (error.message.includes("Permission denied")) {
      console.error("\n💡 Troubleshooting tips:");
      console.error(
        "   - Check that your service account has the 'Cloud Datastore User' role",
      );
      console.error(
        "   - Verify the service account key is valid and not expired",
      );
      console.error(
        "   - Ensure Firestore security rules allow service account access",
      );
    }

    if (error.stack) {
      console.error("\nStack trace:");
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
