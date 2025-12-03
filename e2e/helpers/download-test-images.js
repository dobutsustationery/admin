#!/usr/bin/env node

/**
 * Download all external images referenced in test data and save them locally
 * 
 * This script:
 * 1. Extracts all unique image URLs from the first 400 broadcast records
 * 2. Downloads each image using curl
 * 3. Saves them to e2e/test-images/ directory
 * 4. Creates a mapping file for URL rewriting
 * 
 * Usage:
 *   node e2e/helpers/download-test-images.js
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { execSync } from "node:child_process";
import crypto from "node:crypto";

const TEST_DATA_PATH = resolve(process.cwd(), "test-data", "firestore-export.json");
const IMAGES_DIR = resolve(process.cwd(), "e2e", "test-images");
const MAPPING_FILE = resolve(IMAGES_DIR, "url-mapping.json");

// Ensure images directory exists
if (!existsSync(IMAGES_DIR)) {
  mkdirSync(IMAGES_DIR, { recursive: true });
}

console.log("📥 Loading test data...");
const exportData = JSON.parse(readFileSync(TEST_DATA_PATH, "utf8"));

console.log("🔍 Extracting image URLs from first 400 broadcast records...");
const broadcastDocs = exportData.collections.broadcast || [];
const recordsToProcess = broadcastDocs.slice(0, 400);

const imageUrls = new Set();

for (const { data } of recordsToProcess) {
  if (data?.payload?.item?.image) {
    const imageUrl = data.payload.item.image;
    if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
      imageUrls.add(imageUrl);
    }
  }
}

console.log(`   Found ${imageUrls.size} unique image URLs`);

const urlMapping = {};
let successCount = 0;
let failCount = 0;

console.log("\n📦 Downloading images...");

for (const url of imageUrls) {
  try {
    // Create a hash-based filename to avoid URL encoding issues
    const urlHash = crypto.createHash('md5').update(url).digest('hex');
    const ext = url.match(/\.(jpg|jpeg|png|gif|webp)(\?|$)/i)?.[1] || 'jpg';
    const filename = `${urlHash}.${ext}`;
    const localPath = join(IMAGES_DIR, filename);
    
    // Skip if already downloaded
    if (existsSync(localPath)) {
      console.log(`   ✓ Cached: ${url.substring(0, 60)}...`);
      urlMapping[url] = `/test-images/${filename}`;
      successCount++;
      continue;
    }
    
    // Download using curl with timeout
    console.log(`   ⬇️  Downloading: ${url.substring(0, 60)}...`);
    execSync(
      `curl -s -m 5 -o "${localPath}" "${url}"`,
      { stdio: 'pipe' }
    );
    
    // Verify the file was created and has content
    if (existsSync(localPath)) {
      const stats = statSync(localPath);
      if (stats.size > 0) {
        urlMapping[url] = `/test-images/${filename}`;
        successCount++;
        console.log(`      ✓ Saved as ${filename} (${stats.size} bytes)`);
      } else {
        console.log(`      ⚠️  Failed: Empty file`);
        failCount++;
      }
    } else {
      console.log(`      ⚠️  Failed: Could not save`);
      failCount++;
    }
  } catch (error) {
    console.log(`   ⚠️  Error downloading ${url.substring(0, 60)}...`);
    console.log(`      ${error.message}`);
    failCount++;
  }
}

// Save the mapping
writeFileSync(MAPPING_FILE, JSON.stringify(urlMapping, null, 2));

console.log(`\n✅ Download complete!`);
console.log(`   Success: ${successCount}`);
console.log(`   Failed: ${failCount}`);
console.log(`   Mapping saved to: ${MAPPING_FILE}`);
