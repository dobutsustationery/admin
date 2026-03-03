#!/usr/bin/env node

/**
 * Pre-commit check to ensure E2E engineering standards are met.
 *
 * Checks:
 * 1. No waitForTimeout calls (banned for flakiness)
 * 2. No maxDiffPixelRatio or threshold overrides (strict zero-pixel tolerance)
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { exit } from "node:process";

const checks = [
  {
    name: "waitForTimeout",
    pattern: /waitForTimeout/g,
    message: "waitForTimeout introduces arbitrary delays and is banned. Use proper wait mechanisms (waitFor, expect, etc.) instead."
  },
  {
    name: "maxDiffPixelRatio",
    pattern: /maxDiffPixelRatio/g,
    message: "maxDiffPixelRatio overrides are banned. We enforce strict zero-pixel tolerance for screenshots."
  },
  {
    name: "threshold",
    pattern: /threshold/g,
    message: "threshold overrides are banned. We enforce strict zero-pixel tolerance for screenshots."
  }
];

// Target directories and files
const searchTargets = [
  "e2e",
  "playwright.config.ts",
  "playwright.live.config.ts",
  "playwright.nonlive.config.ts"
];

let failed = false;

console.log("🔍 Checking E2E engineering standards...");

function walkDir(dir, callback) {
  const files = readdirSync(dir);
  for (const file of files) {
    const path = join(dir, file);
    if (statSync(path).isDirectory()) {
      if (file !== "node_modules" && file !== ".git" && file !== "test-results") {
        walkDir(path, callback);
      }
    } else {
      if (file.endsWith(".ts") || file.endsWith(".js")) {
        callback(path);
      }
    }
  }
}

const filesToCheck = [];
for (const target of searchTargets) {
  const fullPath = resolve(process.cwd(), target);
  try {
    if (statSync(fullPath).isDirectory()) {
      walkDir(fullPath, (path) => filesToCheck.push(path));
    } else {
      filesToCheck.push(fullPath);
    }
  } catch (e) {
    // Skip missing files
  }
}

for (const filePath of filesToCheck) {
  const relativePath = relative(process.cwd(), filePath);
  // Skip this script
  if (relativePath.includes('check-e2e-standards.js')) continue;

  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");

  for (const check of checks) {
    for (let i = 0; i < lines.length; i++) {
      if (check.pattern.test(lines[i])) {
        // Double check it's not a comment or false positive (very basic)
        const trimmed = lines[i].trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;

        console.error(`\n❌ FAILED: ${check.name} detected in ${relativePath}:${i + 1}`);
        console.error(`   ${check.message}`);
        console.error(`   Line ${i + 1}: ${trimmed}`);
        failed = true;
      }
    }
  }
}

if (failed) {
  console.error("\n❌ E2E standards check failed. Please fix the violations before committing.");
  exit(1);
}

console.log("\n✅ All E2E engineering standards checks passed.");
exit(0);
