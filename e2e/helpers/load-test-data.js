#!/usr/bin/env node

/**
 * Helper script to load test data into Firestore emulator for E2E tests
 *
 * This script loads the test-data/firestore-export.json into the Firestore emulator
 * before running E2E tests.
 * 
 * Usage:
 *   node e2e/helpers/load-test-data.js                    # Load all data
 *   node e2e/helpers/load-test-data.js --match-jancodes=10 # Load records matching JAN codes from first 10 records
 * 
 * The --match-jancodes flag loads the first N records, extracts their JAN codes, then loads
 * all records that reference those JAN codes. This ensures complete test coverage for the
 * items in the first N records while keeping test data loading fast.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { cert, initializeApp } from "firebase-admin/app";
import { Timestamp, getFirestore } from "firebase-admin/firestore";

// Set emulator host before initializing Firebase Admin
// This is the proper way to connect to the Firestore emulator
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || "localhost:8080";
process.env.FIRESTORE_EMULATOR_HOST = emulatorHost;

// Initialize Firebase Admin for emulator
// Use the same project ID as configured for e2e tests
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
 * Load test data into Firestore emulator
 */
async function loadTestData() {
  const testDataPath = resolve(
    process.cwd(),
    "test-data",
    "firestore-export.json",
  );

  // Parse --match-jancodes argument if provided
  const matchJancodesArg = process.argv.find(arg => arg.startsWith('--match-jancodes='));
  const matchJancodesLimit = matchJancodesArg ? parseInt(matchJancodesArg.split('=')[1], 10) : null;

  console.log(`\n📥 Loading test data from ${testDataPath}...`);
  if (matchJancodesLimit) {
    console.log(`   ⚠️  Match JAN codes mode: Loading records matching JAN codes from first ${matchJancodesLimit} records`);
  }

  const exportData = JSON.parse(readFileSync(testDataPath, "utf8"));
  console.log(`   Exported at: ${exportData.exportedAt}`);

  // Clear existing data from emulator using the REST API
  // This is much faster and more reliable than deleting documents one by one
  console.log(`\n🧹 Clearing existing data from emulator...`);
  try {
    const clearUrl = `http://${emulatorHost}/emulator/v1/projects/demo-test-project/databases/(default)/documents`;
    const response = await fetch(clearUrl, { method: 'DELETE' });

    if (response.ok) {
      console.log(`   ✓ Emulator data cleared via REST API`);
    } else {
      console.warn(`   ⚠️  Failed to clear data via REST API: ${response.status} ${response.statusText}`);
      console.warn(`       Falling back to standard loading (data might persist)`);
    }
  } catch (error) {
    console.warn(`   ⚠️  Error calling clear endpoint: ${error.message}`);
  }

  // Load URL mapping if available
  const mappingPath = resolve(
    process.cwd(),
    "e2e",
    "test-images",
    "url-mapping.json"
  );
  let urlMapping = {};
  if (existsSync(mappingPath)) {
    urlMapping = JSON.parse(readFileSync(mappingPath, "utf8"));
    console.log(`   📍 Loaded ${Object.keys(urlMapping).length} image URL mappings`);
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
    console.log(`   JAN codes: ${janCodesToMatch.slice(0, 10).join(', ')}${janCodesToMatch.length > 10 ? '...' : ''}`);
  }

  for (const [collectionName, documents] of Object.entries(
    exportData.collections,
  )) {
    let docsToLoad;

    // Apply appropriate filtering based on mode
    if (collectionName === 'broadcast') {
      if (matchJancodesLimit && janCodesToMatch) {
        // Filter by JAN codes
        docsToLoad = filterByJanCodes(documents, janCodesToMatch);
      } else {
        // Load all
        docsToLoad = documents;
      }
    } else {
      // Non-broadcast collections are always loaded completely
      docsToLoad = documents;
    }

    console.log(`\n  Loading ${collectionName} (${docsToLoad.length} docs)...`);
    if (collectionName === 'broadcast') {
      if (matchJancodesLimit && janCodesToMatch) {
        console.log(`    (Filtered ${documents.length} broadcast events to ${docsToLoad.length} matching JAN codes)`);
      }
    }

    let batch = db.batch();
    let batchCount = 0;
    let rewrittenCount = 0;
    // Reduced batch size to avoid gRPC message size limit (4MB)
    // The emulator enforces a 4MB limit per gRPC message. With the test data
    // averaging ~6.5KB per document, 500 documents (~3.25MB) was approaching
    // the limit. Using 100 documents (~650KB) provides a safe margin.
    const BATCH_SIZE = 100;

    for (const { id, data } of docsToLoad) {
      const docRef = db.collection(collectionName).doc(id);

      // Rewrite image URLs to local paths if mapping exists
      let modifiedData = data;
      if (data?.payload?.item?.image && urlMapping[data.payload.item.image]) {
        modifiedData = JSON.parse(JSON.stringify(data));
        const originalUrl = modifiedData.payload.item.image;
        modifiedData.payload.item.image = `http://localhost:4173${urlMapping[originalUrl]}`;
        rewrittenCount++;
      }

      // Restore Firestore Timestamps from stored _seconds and _nanoseconds
      const deserializedData = JSON.parse(
        JSON.stringify(modifiedData),
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
    if (rewrittenCount > 0) {
      console.log(`    ✓ Rewrote ${rewrittenCount} image URLs to local paths`);
    }
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
