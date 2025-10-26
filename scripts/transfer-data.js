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
 * - broadcast: Complete action history (required for state reconstruction)
 * - users: Admin user data
 * - dobutsu: Orders and payments
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
    options[key] = args[i + 1] || true;
    i++;
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
  console.log("  --skip-broadcast     Skip the broadcast collection (not recommended)");
  console.log("  --skip-users         Skip the users collection");
  console.log("  --skip-orders        Skip the dobutsu (orders) collection");
  console.log("  --force              Required when importing/transferring to production");
  process.exit(1);
}

// Configuration
const config = {
  skipBroadcast: options["skip-broadcast"] === true,
  skipUsers: options["skip-users"] === true,
  skipOrders: options["skip-orders"] === true,
  force: options.force === true,
};

console.log("🔧 Configuration:", config);

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
    console.error("   Writing data to production is dangerous and can overwrite live data.");
    console.error("   If you are certain you want to proceed, add --force to your command:");
    console.error(`   \n   ${process.argv.slice(0, 2).join(' ')} ${process.argv.slice(2).join(' ')} --force\n`);
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
    console.error("   Writing to production requires special write credentials.");
    console.error(`   Expected file: ${writeKeyPath}`);
    console.error("\n   This is separate from the read-only production service account.");
    console.error("   To create write credentials:");
    console.error("   1. Go to Firebase Console > Project Settings > Service Accounts");
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
        projectId: "dobutsu-stationery-6b227",
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
      keyPath = resolve(
        process.cwd(),
        "service-account-production-write.json",
      );
    } else {
      keyPath = resolve(
        process.cwd(),
        `service-account-${env}.json`,
      );
    }

    if (!existsSync(keyPath)) {
      console.error(
        `❌ Service account key not found: ${keyPath}`,
      );
      console.log(
        `\n💡 Download from Firebase Console > Project Settings > Service Accounts`,
      );
      console.log(`   Save as: ${keyPath.split('/').pop()}`);
      process.exit(1);
    }

    const serviceAccount = JSON.parse(readFileSync(keyPath, "utf8"));
    const app = initializeApp(
      {
        credential: cert(serviceAccount),
      },
      appName,
    );

    const accessType = (env === "production" && isWrite) ? " (WRITE ACCESS)" : "";
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

  const collections = [];
  
  if (!config.skipBroadcast) {
    collections.push("broadcast");
  }
  if (!config.skipUsers) {
    collections.push("users");
  }
  if (!config.skipOrders) {
    collections.push("dobutsu");
  }

  const exportData = {
    exportedAt: new Date().toISOString(),
    collections: {},
  };

  for (const collectionName of collections) {
    console.log(`\n  Exporting ${collectionName}...`);
    const collectionRef = db.collection(collectionName);
    
    const snapshot = await collectionRef.get();
    const documents = [];

    snapshot.forEach((doc) => {
      const data = doc.data();
      
      // Preserve Firestore Timestamps with full precision
      // Store them as objects with _seconds and _nanoseconds
      const serializedData = JSON.parse(
        JSON.stringify(data, (key, value) => {
          if (value && typeof value === "object" && value._seconds !== undefined) {
            // Firestore Timestamp - preserve exact seconds and nanoseconds
            return {
              _timestamp: true,
              _seconds: value._seconds,
              _nanoseconds: value._nanoseconds || 0,
            };
          }
          return value;
        }),
      );

      documents.push({
        id: doc.id,
        data: serializedData,
      });
    });

    exportData.collections[collectionName] = documents;
    console.log(`    ✓ Exported ${documents.length} documents`);
  }

  const outputFile = join(outputDir, "firestore-export.json");
  writeFileSync(outputFile, JSON.stringify(exportData, null, 2));
  console.log(`\n✅ Export complete: ${outputFile}`);
  
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

  for (const [collectionName, documents] of Object.entries(
    exportData.collections,
  )) {
    console.log(`\n  Importing ${collectionName} (${documents.length} docs)...`);
    
    const batch = db.batch();
    let batchCount = 0;
    const BATCH_SIZE = 500; // Firestore batch limit

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
        batchCount = 0;
      }
    }

    // Commit remaining documents
    if (batchCount > 0) {
      await batch.commit();
      console.log(`    Committed final batch of ${batchCount} documents`);
    }

    console.log(`    ✓ Imported ${documents.length} documents to ${collectionName}`);
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
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

main();
