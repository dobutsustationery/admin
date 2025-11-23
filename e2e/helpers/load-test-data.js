#!/usr/bin/env node

/**
 * Helper script to load test data into Firestore emulator for E2E tests
 *
 * This script loads the test-data/firestore-export.json into the Firestore emulator
 * before running E2E tests.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cert, initializeApp } from "firebase-admin/app";
import { Timestamp, getFirestore } from "firebase-admin/firestore";

// Set emulator host before initializing Firebase Admin
// This is the proper way to connect to the Firestore emulator
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || "localhost:8080";
process.env.FIRESTORE_EMULATOR_HOST = emulatorHost;

// Initialize Firebase Admin for emulator
const app = initializeApp({
  projectId: "demo-test-project",
});

const db = getFirestore(app);

console.log(`🔧 Connected to Firestore emulator at ${emulatorHost}`);

/**
 * Load test data into Firestore emulator
 */
async function loadTestData() {
  const testDataPath = resolve(
    process.cwd(),
    "test-data",
    "firestore-export.json",
  );

  console.log(`\n📥 Loading test data from ${testDataPath}...`);

  const exportData = JSON.parse(readFileSync(testDataPath, "utf8"));
  console.log(`   Exported at: ${exportData.exportedAt}`);

  for (const [collectionName, documents] of Object.entries(
    exportData.collections,
  )) {
    console.log(`\n  Loading ${collectionName} (${documents.length} docs)...`);

    let batch = db.batch();
    let batchCount = 0;
    // Reduced batch size to avoid gRPC message size limit (4MB)
    // The emulator enforces a 4MB limit per gRPC message. With the test data
    // averaging ~6.5KB per document, 500 documents (~3.25MB) was approaching
    // the limit. Using 100 documents (~650KB) provides a safe margin.
    const BATCH_SIZE = 100;

    for (const { id, data } of documents) {
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
      `    ✓ Loaded ${documents.length} documents to ${collectionName}`,
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
