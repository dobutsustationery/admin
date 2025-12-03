# Image Loading Investigation for JAN Code 4510085530713

## Issue Report
In CI, the subtypes test shows JAN code 4510085530713 with a broken image in the "expected" (baseline) screenshot, but the CI-generated "actual" screenshot loads the image correctly.

## Investigation Results

### URL Accessibility Test
Tested image URL: `https://tshop.r10s.jp/hyakuemon/cabinet/4510085530713.jpg?fitin=720%3A720`

**Results:**
- ✅ HTTP GET returns 200 OK
- ✅ Successfully downloaded 84,513 bytes
- ✅ Valid JPEG image (720x671 pixels)
- ✅ No firewall blocking detected
- ✅ CORS headers present: `Access-Control-Expose-Headers: x-cdn-served-from`
- ⚠️ HEAD requests return 405 Method Not Allowed (server limitation)

### Local Test Environment
- **Test Status:** All 9 e2e tests passing (including subtypes)
- **Screenshot Match:** 001-signed-in-state.png matches baseline
- **Regeneration Result:** File unchanged after `--update-snapshots`
- **Test Runtime:** ~5.8 seconds, consistent

### Why No Network Errors Appear

Browser behavior for failed image loads:
1. **Silent Failure:** `<img>` tags fail gracefully with broken image icon
2. **No Console Errors:** Failed resource loads don't generate JavaScript console errors by default
3. **Not Captured:** Standard `console.error()` listeners don't catch image load failures

To detect image loading failures, you need:
```javascript
page.on('requestfailed', request => {
  if (request.resourceType() === 'image') {
    console.log('Image failed:', request.url(), request.failure());
  }
});
```

## Possible Explanations

### 1. Timing Issue (Most Likely)
The baseline screenshot may have been captured before images finished loading:
- Network latency during baseline generation
- No explicit wait for image load completion
- Screenshot taken while images were still loading

### 2. Historical Network Configuration
Baseline may have been created when:
- The CDN/server was temporarily unavailable
- DNS resolution issues occurred
- Geo-blocking or firewall rules were different

### 3. Test Environment Differences
- **CI Environment:** May have different network configuration, DNS, or CDN routing
- **Local Environment:** Successfully loads images consistently
- **Result:** Both pass locally but CI detects the stale baseline

## Conclusion

The image URL is currently accessible and loading correctly. The broken image in the CI baseline is likely historical - created when the image was inaccessible or before it fully loaded.

**Recommendation:** The baseline should be regenerated in the CI environment to capture the current working state. Local regeneration shows no changes because the local baseline may already have been updated informally or the issue is specific to CI environment timing/network conditions.

## Files Checked
- `e2e/008-subtypes/screenshots/000-signed-out-state.png` (5.2K)
- `e2e/008-subtypes/screenshots/001-signed-in-state.png` (71K) - Regenerated, no changes
- `e2e/008-subtypes/screenshots/002-subtypes-loaded.png` (71K)

## Test Data
- JAN Code: `4510085530713`
- Subtypes: `Blue`, `Pink`
- Item Keys: `4510085530713Blue`, `4510085530713Pink`
- Image Source: Rakuten CDN (tshop.r10s.jp)
