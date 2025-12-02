# Local Images for E2E Testing

This directory contains tools for downloading external images referenced in test data and using them locally for reliable e2e testing.

## Problem

About 43% of external images fail to load in Playwright tests due to:
- CDN bot protection (Cloudflare/Akamai blocking headless browsers)
- CORS policy restrictions
- SSL certificate chain issues in headless mode  
- Browser security settings

This causes screenshots to contain broken image placeholders, making visual regression testing unreliable.

## Solution

Download all images referenced in the test data and serve them locally from the SvelteKit static directory.

## Setup

### 1. Download Images

Run the download script to fetch all images from the first 400 broadcast records:

```bash
node e2e/helpers/download-test-images.js
```

This will:
- Extract all unique image URLs from test data
- Download each image using curl
- Save them to `e2e/test-images/` with hash-based filenames
- Create `e2e/test-images/url-mapping.json` for URL rewriting

### 2. Run Tests with Local Images

Use the special test runner that loads data with rewritten URLs:

```bash
bash e2e/run-tests-local-images.sh
```

Or manually:

```bash
# Start emulators
npm run emulators &

# Load test data with local image URLs
node e2e/helpers/load-test-data-with-local-images.js --prefix=400

# Build and run tests
npm run build:local
npx playwright test
```

## How It Works

1. **download-test-images.js**: Downloads all unique images from test data
   - Creates MD5-based filenames to avoid URL encoding issues
   - Saves mapping from original URL to local path in `url-mapping.json`
   - Skips already-downloaded images (cached)

2. **load-test-data-with-local-images.js**: Modified data loader
   - Reads the URL mapping file
   - Rewrites `item.image` URLs to `http://localhost:4173/test-images/{hash}.{ext}`
   - Loads data into Firestore emulator with local URLs

3. **static/test-images**: Symlink to e2e/test-images
   - Makes downloaded images available via SvelteKit static file serving
   - Images accessible at `/test-images/{filename}` in the test app

## Files

- `e2e/helpers/download-test-images.js` - Image download script
- `e2e/helpers/load-test-data-with-local-images.js` - Modified data loader
- `e2e/run-tests-local-images.sh` - Test runner for local images
- `e2e/test-images/` - Downloaded images (gitignored)
- `e2e/test-images/url-mapping.json` - URL rewrite mapping
- `static/test-images/` - Symlink for serving images

## Maintenance

### Re-download Images

If test data changes or images are updated:

```bash
# Remove cached images
rm -rf e2e/test-images/*

# Download fresh images
node e2e/helpers/download-test-images.js
```

### Verify Image Coverage

Check how many images were successfully downloaded:

```bash
node e2e/helpers/download-test-images.js | grep "Success:"
```

### Troubleshoot Failed Downloads

Some images may fail to download due to:
- Timeout (5 second limit)
- 403 Forbidden (bot protection)
- URL no longer exists

Check the download output for specific failures. These images will still show as broken in tests, but now it's a smaller, known set.

## Benefits

✅ Reliable e2e tests - no external dependencies
✅ Faster tests - images load instantly from localhost  
✅ Consistent screenshots - same images every time
✅ Offline testing - works without internet
✅ Reduced flakiness - no CDN timeouts or bot blocks

## NPM Scripts

Add to package.json:

```json
{
  "scripts": {
    "test:e2e:local-images": "bash e2e/run-tests-local-images.sh",
    "test:download-images": "node e2e/helpers/download-test-images.js"
  }
}
```
