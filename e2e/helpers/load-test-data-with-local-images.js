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
 * Extract JAN code from a broadcast event payload
 */
function extractJanCode(broadcast) {
  const payload = broadcast.data?.payload;
  if (!payload) return null;

  // JAN code can be in different locations depending on action type
  const janCode = payload.item?.janCode || payload.janCode;

  // Also check payload.id - it may contain the janCode (possibly with suffix)
  // We need to extract just the numeric part
  if (janCode) return janCode;

  // For update_field and other actions, payload.id might be the janCode (or janCode + suffix)
  // Extract numeric prefix from payload.id
  if (payload.id && typeof payload.id === 'string') {
    const match = payload.id.match(/^(\d+)/);
    if (match) return match[1];
  }

  return null;
}

/**
 * Filter broadcast events using three-step logic:
 * 1. If JAN code occurs anywhere in stringified JSON → include
 * 2. Else if no match but action has itemKey or janCode field → exclude
 * 3. Else → include (actions unrelated to JAN codes)
 */
function filterByJanCodes(broadcasts, janCodes) {
  return broadcasts.filter(broadcast => {
    // Step 1: Check if any target JAN code appears in the JSON
    const jsonStr = JSON.stringify(broadcast);
    const hasMatchingJanCode = janCodes.some(janCode => jsonStr.includes(janCode));

    if (hasMatchingJanCode) {
      return true;  // Include: action involves target JAN codes
    }

    // Step 2: Check if action has itemKey or janCode field
    const payload = broadcast.data?.payload;
    const hasItemKey = payload?.itemKey !== undefined;
    const hasJanCode = payload?.janCode !== undefined || payload?.item?.janCode !== undefined;

    if (hasItemKey || hasJanCode) {
      return false;  // Exclude: action references OTHER JAN codes
    }

    // Step 3: Include actions unrelated to JAN codes
    return true;
  });
}

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

  console.log(`\n📥 Loading test data from ${testDataPath}...`);

  const exportData = JSON.parse(readFileSync(testDataPath, "utf8"));
  console.log(`   Exported at: ${exportData.exportedAt}`);

  // Clear existing data from collections to ensure clean state
  // This prevents data accumulation from multiple test runs
  console.log(`\n🧹 Clearing existing data from emulator...`);
  const collectionsToClear = Object.keys(exportData.collections);
  for (const collectionName of collectionsToClear) {
    const collectionRef = db.collection(collectionName);
    const snapshot = await collectionRef.get();
    if (snapshot.size > 0) {
      console.log(`   Deleting ${snapshot.size} existing documents from ${collectionName}...`);
      const batch = db.batch();
      snapshot.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    }
  }
  console.log(`   ✓ Emulator data cleared`);

  // Load URL mapping if available
  let urlMapping = {};
  if (existsSync(mappingPath)) {
    urlMapping = JSON.parse(readFileSync(mappingPath, "utf8"));
    console.log(`   📍 Loaded ${Object.keys(urlMapping).length} image URL mappings`);
  } else {
    console.log(`   ⚠️  No image URL mapping found at ${mappingPath}`);
    console.log(`      Run: node e2e/helpers/download-test-images.js first`);
  }

  // Parse --match-jancodes argument if provided
  const matchJancodesArg = process.argv.find(arg => arg.startsWith('--match-jancodes='));
  const matchJancodesLimit = matchJancodesArg ? parseInt(matchJancodesArg.split('=')[1], 10) : null;

  if (matchJancodesLimit) {
    console.log(`   ⚠️  Match JAN codes mode: Loading records matching JAN codes from first ${matchJancodesLimit} records`);
  }

  // If using --match-jancodes, extract JAN codes from first N records
  let janCodesToMatch = null;
  if (matchJancodesLimit && exportData.collections.broadcast) {
    const firstNRecords = exportData.collections.broadcast.slice(0, matchJancodesLimit);
    const janCodesSet = new Set();

    firstNRecords.forEach(broadcast => {
      const janCode = extractJanCode(broadcast);
      if (janCode) {
        janCodesSet.add(janCode);
      }
    });

    janCodesToMatch = Array.from(janCodesSet);
    console.log(`   Found ${janCodesToMatch.length} unique JAN codes in first ${matchJancodesLimit} records`);
  }

  for (const [collectionName, documents] of Object.entries(
    exportData.collections,
  )) {
    // Determine docs to load based on filtering
    let docsToLoad;

    if (collectionName === 'broadcast') {
      if (matchJancodesLimit && janCodesToMatch) {
        docsToLoad = filterByJanCodes(documents, janCodesToMatch);
      } else {
        docsToLoad = documents;
      }
    } else {
      docsToLoad = documents;
    }

    console.log(`\n  Loading ${collectionName} (${docsToLoad.length} docs)...`);
    if (collectionName === 'broadcast' && matchJancodesLimit) {
      console.log(`    (Filtered ${documents.length} broadcast events to ${docsToLoad.length} matching JAN codes)`);
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
