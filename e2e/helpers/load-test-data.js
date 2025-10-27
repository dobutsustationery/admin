#!/usr/bin/env node

/**
 * Helper script to load test data into Firestore emulator for E2E tests
 *
 * This script loads the test-data/firestore-export.json into the Firestore emulator
 * before running E2E tests.
 * 
 * Usage:
 *   node e2e/helpers/load-test-data.js              # Load all data
 *   node e2e/helpers/load-test-data.js --prefix=400 # Load only first 400 broadcast events
 * 
 * The --prefix flag is recommended for faster test data loading. It loads only the first N
 * broadcast events (which must be the oldest/first events chronologically) while still loading
 * all documents from other collections. Use --prefix=400 for typical E2E testing.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cert, initializeApp } from "firebase-admin/app";
import { Timestamp, getFirestore } from "firebase-admin/firestore";

// Initialize Firebase Admin for emulator
const app = initializeApp({
  projectId: "demo-test-project",
});

const db = getFirestore(app);

// Connect to emulator
db.settings({
  host: "localhost:8080",
  ssl: false,
});

console.log("🔧 Connected to Firestore emulator at localhost:8080");

/**
 * Load test data into Firestore emulator
 */
async function loadTestData() {
  const testDataPath = resolve(
    process.cwd(),
    "test-data",
    "firestore-export.json",
  );

  // Parse --prefix argument if provided
  const prefixArg = process.argv.find(arg => arg.startsWith('--prefix='));
  const prefixLimit = prefixArg ? parseInt(prefixArg.split('=')[1], 10) : null;

  console.log(`\n📥 Loading test data from ${testDataPath}...`);
  if (prefixLimit) {
    console.log(`   ⚠️  Prefix mode: Loading only first ${prefixLimit} broadcast events`);
  }

  const exportData = JSON.parse(readFileSync(testDataPath, "utf8"));
  console.log(`   Exported at: ${exportData.exportedAt}`);

  for (const [collectionName, documents] of Object.entries(
    exportData.collections,
  )) {
    // Apply prefix limit only to broadcast collection (must be first events)
    const docsToLoad = collectionName === 'broadcast' && prefixLimit 
      ? documents.slice(0, prefixLimit)
      : documents;
    
    console.log(`\n  Loading ${collectionName} (${docsToLoad.length} docs)...`);
    if (collectionName === 'broadcast' && prefixLimit && documents.length > prefixLimit) {
      console.log(`    (Skipped ${documents.length - prefixLimit} broadcast events due to --prefix=${prefixLimit})`);
    }

    let batch = db.batch();
    let batchCount = 0;
    const BATCH_SIZE = 500; // Firestore batch limit

    for (const { id, data } of docsToLoad) {
      const docRef = db.collection(collectionName).doc(id);

      // Restore Firestore Timestamps from stored _seconds and _nanoseconds
      const deserializedData = JSON.parse(
        JSON.stringify(data),
        (key, value) => {
          if (
            value &&
            typeof value === "object" &&
            value._timestamp === true &&
            value._seconds !== undefined
          ) {
            // Restore as Firestore Timestamp with exact precision
            return new Timestamp(value._seconds, value._nanoseconds || 0);
          }
          return value;
        },
      );

      batch.set(docRef, deserializedData);
      batchCount++;

      // Commit batch when it reaches the limit
      if (batchCount >= BATCH_SIZE) {
        await batch.commit();
        console.log(`    Committed batch of ${batchCount} documents`);
        // Create a new batch for the next set of documents
        batch = db.batch();
        batchCount = 0;
      }
    }

    // Commit remaining documents
    if (batchCount > 0) {
      await batch.commit();
      console.log(`    Committed final batch of ${batchCount} documents`);
    }

    console.log(
      `    ✓ Loaded ${docsToLoad.length} documents to ${collectionName}`,
    );
  }

  console.log("\n✅ Test data loaded successfully\n");
}

// Run the loader
loadTestData()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Error loading test data:", error);
    process.exit(1);
  });
