#!/usr/bin/env node

/**
 * Download all external images referenced in test data and save them locally
 * 
 * This script:
 * 1. Extracts all unique image URLs from broadcast records (filtered by --prefix or --match-jancodes)
 * 2. Downloads each image using curl
 * 3. Saves them to e2e/test-images/ directory
 * 4. Creates a mapping file for URL rewriting
 * 
 * Usage:
 *   node e2e/helpers/download-test-images.js                    # All records
 *   node e2e/helpers/download-test-images.js --prefix=400       # First 400 records
 *   node e2e/helpers/download-test-images.js --match-jancodes=10 # Match JAN codes from first 10
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

/**
 * Extract JAN code from a broadcast event payload
 */
function extractJanCode(broadcast) {
  const payload = broadcast.data?.payload;
  if (!payload) return null;
  
  const janCode = payload.item?.janCode || payload.janCode;
  if (janCode) return janCode;
  
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

console.log("📥 Loading test data...");
const exportData = JSON.parse(readFileSync(TEST_DATA_PATH, "utf8"));

// Parse arguments
const prefixArg = process.argv.find(arg => arg.startsWith('--prefix='));
const prefixLimit = prefixArg ? parseInt(prefixArg.split('=')[1], 10) : null;

const matchJancodesArg = process.argv.find(arg => arg.startsWith('--match-jancodes='));
const matchJancodesLimit = matchJancodesArg ? parseInt(matchJancodesArg.split('=')[1], 10) : null;

const broadcastDocs = exportData.collections.broadcast || [];
let recordsToProcess;

if (matchJancodesLimit) {
  console.log(`🔍 Extracting JAN codes from first ${matchJancodesLimit} records...`);
  const firstNRecords = broadcastDocs.slice(0, matchJancodesLimit);
  const janCodesSet = new Set();
  
  firstNRecords.forEach(broadcast => {
    const janCode = extractJanCode(broadcast);
    if (janCode) {
      janCodesSet.add(janCode);
    }
  });
  
  const janCodesToMatch = Array.from(janCodesSet);
  console.log(`   Found ${janCodesToMatch.length} unique JAN codes`);
  console.log(`   Filtering ${broadcastDocs.length} records by these JAN codes...`);
  
  recordsToProcess = filterByJanCodes(broadcastDocs, janCodesToMatch);
  console.log(`   Will process ${recordsToProcess.length} matching records`);
} else if (prefixLimit) {
  console.log(`🔍 Extracting image URLs from first ${prefixLimit} broadcast records...`);
  recordsToProcess = broadcastDocs.slice(0, prefixLimit);
} else {
  console.log(`🔍 Extracting image URLs from all ${broadcastDocs.length} broadcast records...`);
  recordsToProcess = broadcastDocs;
}

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
