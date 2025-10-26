#!/usr/bin/env node

/**
 * Environment Switcher for Dobutsu Admin
 *
 * This script helps users quickly switch between different environments
 * by copying the appropriate .env file to .env
 *
 * Usage:
 *   npm run env:local
 *   npm run env:staging
 *   npm run env:production
 */

import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const env = args[0];

if (!env) {
  console.error("❌ Error: No environment specified");
  console.log("\nUsage: node scripts/switch-env.js [local|staging|production]");
  console.log("\nOr use the npm scripts:");
  console.log("  npm run env:local");
  console.log("  npm run env:staging");
  console.log("  npm run env:production");
  process.exit(1);
}

const validEnvs = ["local", "staging", "production"];
if (!validEnvs.includes(env)) {
  console.error(`❌ Error: Invalid environment '${env}'`);
  console.log(`\nValid environments: ${validEnvs.join(", ")}`);
  process.exit(1);
}

// Map environment names to their corresponding .env files
// "local" uses .env.emulator to avoid Vite's mode name conflict with .env.local
const envFileMap = {
  local: ".env.emulator",
  staging: ".env.staging",
  production: ".env.production",
};

const sourceFile = resolve(process.cwd(), envFileMap[env]);
const targetFile = resolve(process.cwd(), ".env");

if (!existsSync(sourceFile)) {
  console.error(`❌ Error: Environment file not found: ${sourceFile}`);
  process.exit(1);
}

try {
  copyFileSync(sourceFile, targetFile);
  console.log(`✅ Environment switched to: ${env}`);
  console.log(`   Copied: ${envFileMap[env]} → .env`);
  console.log(`\n💡 Run 'npm run dev' to start with ${env} environment`);
} catch (error) {
  console.error(`❌ Error copying file: ${error.message}`);
  process.exit(1);
}
