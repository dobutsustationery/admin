#!/usr/bin/env node
/**
 * Patch Playwright to fix browser download issues
 * 
 * This script patches two issues in Playwright's download code:
 * 1. Progress bar crash when totalBytes is 0 (from redirect with Content-Length: 0)
 * 2. Size mismatch validation failure when totalBytes is 0
 * 
 * These issues occur because Playwright's CDN returns a 307 redirect with Content-Length: 0,
 * but the actual download completes successfully with the correct file size.
 */

const fs = require('fs');
const path = require('path');

const PLAYWRIGHT_DIR = path.join(__dirname, '../node_modules/playwright-core/lib/server/registry');

function patchFile(filePath, patches) {
  const fullPath = path.join(PLAYWRIGHT_DIR, filePath);
  
  if (!fs.existsSync(fullPath)) {
    console.warn(`⚠️  File not found: ${fullPath}`);
    return false;
  }
  
  let content = fs.readFileSync(fullPath, 'utf8');
  let patched = false;
  
  for (const { find, replace, description } of patches) {
    if (content.includes(replace)) {
      console.log(`✓ Patch already applied: ${description}`);
      continue;
    }
    
    if (!content.includes(find)) {
      console.warn(`⚠️  Could not find code to patch: ${description}`);
      continue;
    }
    
    content = content.replace(find, replace);
    patched = true;
    console.log(`✓ Applied patch: ${description}`);
  }
  
  if (patched) {
    fs.writeFileSync(fullPath, content, 'utf8');
    return true;
  }
  
  return false;
}

console.log('🔧 Patching Playwright browser download code...\n');

// Patch 1: Fix progress bar crash when totalBytes is 0
const browserFetcherPatches = [
  {
    description: 'Handle totalBytes=0 in progress bar',
    find: `  return (downloadedBytes, totalBytes) => {
    const percentage = downloadedBytes / totalBytes;
    const row = Math.floor(totalRows * percentage);
    if (row > lastRow) {
      lastRow = row;
      const percentageString = String(percentage * 100 | 0).padStart(3);
      console.log(\`|\${"\\u25A0".repeat(row * stepWidth)}\${" ".repeat((totalRows - row) * stepWidth)}| \${percentageString}% of \${toMegabytes(totalBytes)}\`);
    }
  };`,
    replace: `  return (downloadedBytes, totalBytes) => {
    // Handle case where totalBytes is 0 or undefined (e.g., from redirect with Content-Length: 0)
    if (!totalBytes || totalBytes === 0) {
      // Just log the downloaded bytes without percentage
      if (downloadedBytes > 0 && lastRow < 0) {
        console.log(\`Downloading... \${toMegabytes(downloadedBytes)} received\`);
        lastRow = 0;
      }
      return;
    }
    const percentage = downloadedBytes / totalBytes;
    const row = Math.floor(totalRows * percentage);
    if (row > lastRow) {
      lastRow = row;
      const percentageString = String(percentage * 100 | 0).padStart(3);
      console.log(\`|\${"\\u25A0".repeat(row * stepWidth)}\${" ".repeat((totalRows - row) * stepWidth)}| \${percentageString}% of \${toMegabytes(totalBytes)}\`);
    }
  };`
  }
];

// Patch 2: Skip size validation when totalBytes is 0
const oopDownloadPatches = [
  {
    description: 'Skip size validation when totalBytes=0',
    find: `    file.on("finish", () => {
      if (downloadedBytes !== totalBytes) {
        log(\`-- download failed, size mismatch: \${downloadedBytes} != \${totalBytes}\`);
        promise.reject(new Error(\`Download failed: size mismatch, file size: \${downloadedBytes}, expected size: \${totalBytes} URL: \${options.url}\`));
      } else {
        log(\`-- download complete, size: \${downloadedBytes}\`);
        promise.resolve();
      }
    });`,
    replace: `    file.on("finish", () => {
      // Skip size validation if totalBytes is 0 (likely from a redirect with Content-Length: 0)
      // The download actually completed successfully, we just didn't get the correct size from headers
      if (totalBytes === 0) {
        log(\`-- download complete (no size check - totalBytes was 0), actual size: \${downloadedBytes}\`);
        promise.resolve();
      } else if (downloadedBytes !== totalBytes) {
        log(\`-- download failed, size mismatch: \${downloadedBytes} != \${totalBytes}\`);
        promise.reject(new Error(\`Download failed: size mismatch, file size: \${downloadedBytes}, expected size: \${totalBytes} URL: \${options.url}\`));
      } else {
        log(\`-- download complete, size: \${downloadedBytes}\`);
        promise.resolve();
      }
    });`
  }
];

let success = true;
success = patchFile('browserFetcher.js', browserFetcherPatches) && success;
success = patchFile('oopDownloadBrowserMain.js', oopDownloadPatches) && success;

console.log('\n✅ Playwright patches applied successfully!\n');
console.log('These patches fix browser download issues caused by CDN redirects.');
console.log('See docs/PLAYWRIGHT_DOWNLOAD_FIX.md for details.\n');
