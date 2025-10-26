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
 * - broadcast: Action history (with optional time filtering)
 * - users: Admin user data
 * - dobutsu: Orders and payments (optional)
 *
 * Note: Requires service account keys for non-emulator environments
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

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
  console.log("  --days <number>      Only export broadcast actions from last N days (default: 30)");
  console.log("  --skip-broadcast     Skip the broadcast collection");
  console.log("  --skip-users         Skip the users collection");
  console.log("  --include-orders     Include the dobutsu (orders) collection");
  process.exit(1);
}

// Configuration
const config = {
  days: Number.parseInt(options.days || "30", 10),
  skipBroadcast: options["skip-broadcast"] === true,
  skipUsers: options["skip-users"] === true,
  includeOrders: options["include-orders"] === true,
};

console.log("🔧 Configuration:", config);

/**
 * Initialize Firebase Admin SDK for a specific environment
 */
function initializeFirebaseForEnv(env, appName = undefined) {
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
    const keyPath = resolve(
      process.cwd(),
      `service-account-${env}.json`,
    );

    if (!existsSync(keyPath)) {
      console.error(
        `❌ Service account key not found: ${keyPath}`,
      );
      console.log(
        `\n💡 Download from Firebase Console > Project Settings > Service Accounts`,
      );
      console.log(`   Save as: service-account-${env}.json`);
      process.exit(1);
    }

    const serviceAccount = JSON.parse(readFileSync(keyPath, "utf8"));
    const app = initializeApp(
      {
        credential: cert(serviceAccount),
      },
      appName,
    );

    console.log(`🔥 Connected to ${env} Firestore`);
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
  if (config.includeOrders) {
    collections.push("dobutsu");
  }

  const exportData = {
    exportedAt: new Date().toISOString(),
    collections: {},
  };

  for (const collectionName of collections) {
    console.log(`\n  Exporting ${collectionName}...`);
    const collectionRef = db.collection(collectionName);
    
    let query = collectionRef;
    
    // Filter broadcast by date if specified
    if (collectionName === "broadcast" && config.days > 0) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - config.days);
      console.log(`    Filtering actions since ${cutoffDate.toISOString()}`);
      query = query.where("timestamp", ">=", cutoffDate);
    }

    const snapshot = await query.get();
    const documents = [];

    snapshot.forEach((doc) => {
      const data = doc.data();
      
      // Convert Firestore timestamps to ISO strings for JSON serialization
      const serializedData = JSON.parse(
        JSON.stringify(data, (key, value) => {
          if (value && typeof value === "object" && value._seconds) {
            // Firestore Timestamp
            return new Date(
              value._seconds * 1000 + value._nanoseconds / 1000000,
            ).toISOString();
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
      
      // Convert ISO date strings back to Firestore Timestamps
      const deserializedData = JSON.parse(
        JSON.stringify(data),
        (key, value) => {
          if (
            typeof value === "string" &&
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)
          ) {
            return new Date(value);
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
      
      console.log(`📥 Importing to ${targetEnv} from ${inputDir}`);
      const db = initializeFirebaseForEnv(targetEnv);
      await importData(db, inputDir);
      
    } else if (command === COMMAND_TRANSFER) {
      const fromEnv = options.from;
      const toEnv = options.to;
      const tempDir = resolve(process.cwd(), ".data-transfer-tmp");
      
      console.log(`🔄 Transferring from ${fromEnv} to ${toEnv}`);
      
      // Export from source
      const sourceDb = initializeFirebaseForEnv(fromEnv, "source");
      await exportData(sourceDb, tempDir);
      
      // Import to target
      const targetDb = initializeFirebaseForEnv(toEnv, "target");
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
