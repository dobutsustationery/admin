#!/usr/bin/env node

/**
 * Helper script to load test data into Firestore emulator with local image URLs
 *
 * This version rewrites external image URLs to use locally downloaded images
 * for reliable e2e testing without external dependencies.
 * 
 * Usage:
 *   node e2e/helpers/load-test-data-with-local-images.js --match-jancodes=10
 */

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { cert, initializeApp } from "firebase-admin/app";
import { Timestamp, getFirestore } from "firebase-admin/firestore";

// Set emulator host before initializing Firebase Admin
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || "localhost:8080";
process.env.FIRESTORE_EMULATOR_HOST = emulatorHost;

// Initialize Firebase Admin for emulator
const app = initializeApp({
  projectId: "demo-test-project",
});

const db = getFirestore(app);

console.log(`🔧 Connected to Firestore emulator at ${emulatorHost}`);

/**
 * Load test data into Firestore emulator with local image URLs
 */
async function loadTestData() {
  const testDataPath = resolve(
    process.cwd(),
    "test-data",
    "firestore-export.json",
  );
  
  const mappingPath = resolve(
    process.cwd(),
    "e2e",
    "test-images",
    "url-mapping.json"
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
  
  // Load URL mapping if available
  let urlMapping = {};
  if (existsSync(mappingPath)) {
    urlMapping = JSON.parse(readFileSync(mappingPath, "utf8"));
    console.log(`   📍 Loaded ${Object.keys(urlMapping).length} image URL mappings`);
  } else {
    console.log(`   ⚠️  No image URL mapping found at ${mappingPath}`);
    console.log(`      Run: node e2e/helpers/download-test-images.js first`);
  }

  for (const [collectionName, documents] of Object.entries(
    exportData.collections,
  )) {
    // Apply prefix limit only to broadcast collection
    const docsToLoad = collectionName === 'broadcast' && prefixLimit 
      ? documents.slice(0, prefixLimit)
      : documents;
    
    console.log(`\n  Loading ${collectionName} (${docsToLoad.length} docs)...`);
    if (collectionName === 'broadcast' && prefixLimit && documents.length > prefixLimit) {
      console.log(`    (Skipped ${documents.length - prefixLimit} broadcast events due to --prefix=${prefixLimit})`);
    }

    let batch = db.batch();
    let batchCount = 0;
    let rewrittenCount = 0;
    const BATCH_SIZE = 100;

    for (const { id, data } of docsToLoad) {
      const docRef = db.collection(collectionName).doc(id);

      // Rewrite image URLs to local paths
      let modifiedData = data;
      if (data?.payload?.item?.image && urlMapping[data.payload.item.image]) {
        modifiedData = JSON.parse(JSON.stringify(data));
        const originalUrl = modifiedData.payload.item.image;
        modifiedData.payload.item.image = `http://localhost:4173${urlMapping[originalUrl]}`;
        rewrittenCount++;
      }

      // Restore Firestore Timestamps
      const deserializedData = JSON.parse(
        JSON.stringify(modifiedData),
        (key, value) => {
          if (
            value &&
            typeof value === "object" &&
            value._timestamp === true &&
            value._seconds !== undefined
          ) {
            return new Timestamp(value._seconds, value._nanoseconds || 0);
          }
          return value;
        },
      );

      batch.set(docRef, deserializedData);
      batchCount++;

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
      `    ✓ Loaded ${docsToLoad.length} documents to ${collectionName}`,
    );
    if (rewrittenCount > 0) {
      console.log(`    ✓ Rewrote ${rewrittenCount} image URLs to local paths`);
    }
  }

  console.log("\n✅ Test data loaded successfully with local images\n");
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
