import { test, expect } from './fixtures';
import fs from 'fs';
import path from 'path';

test.describe('Photo Processing Workflow', () => {
  const reportDir = 'e2e/live/reports/photo-processing';
  
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  test('should process photos with color correction, crop, and background removal', async ({ page }) => {
    test.setTimeout(120000);
    console.log("Starting Photo Processing Test...");
    console.log("DEBUG ENV: E2E_GOOGLE_PHOTOS_ALBUM_ID =", process.env.E2E_GOOGLE_PHOTOS_ALBUM_ID);
    
    await page.goto('/');
    await expect(page.locator('.app-shell')).toBeVisible({ timeout: 10000 });

    // Helper to fetch photos
    const fetchPhotos = async () => {
        return await page.evaluate(async () => {
          const tokenStr = localStorage.getItem('google_photos_access_token');
          if (!tokenStr) throw new Error('No Photos Token found in localStorage');
          const token = JSON.parse(tokenStr);
          const albumId = (window as any).__GOOGLE_PHOTOS_ALBUM_ID__;
          
          console.log("DEBUG: Using Album ID:", albumId);
          
          const url = albumId 
              ? 'https://photoslibrary.googleapis.com/v1/mediaItems:search'
              : 'https://photoslibrary.googleapis.com/v1/mediaItems?pageSize=2';
          const method = albumId ? 'POST' : 'GET';
          const body = albumId ? JSON.stringify({ albumId, pageSize: 10 }) : undefined;

          const res = await fetch(url, {
            method,
            headers: { Authorization: `Bearer ${token.access_token}`, ...(albumId ? { 'Content-Type': 'application/json' } : {}) },
            body
          });
          const data = await res.json();
          return data.mediaItems || [];
        });
    };

    let photos = await fetchPhotos();

    if (photos.length < 1) {
        throw new Error(`Test environment not configured: Not enough photos in album (found ${photos.length}). Expected at least 1.`);
    }

    // Use up to 2
    const count = Math.min(photos.length, 2);
    photos = photos.slice(0, count);

    // Dispatch Selection
    await page.waitForFunction(() => !!(window as any).__store);
    await page.evaluate((items) => {
      const store = (window as any).__store;
      const mapped = items.map((p: any) => ({
        id: p.id,
        baseUrl: p.baseUrl,
        filename: p.filename,
        mimeType: p.mimeType,
        productUrl: p.productUrl,
        mediaMetadata: p.mediaMetadata
      }));
      store.dispatch({ type: 'photos/select_photos', payload: { photos: mapped } });
    }, photos);

    // Verify Selection
    await page.goto('/photos');
    // Scope to the Selected Area container explicitly
    const selectionContainer = page.locator('.bg-white.shadow-md.min-h-\\[400px\\]');
    const thumbs = selectionContainer.locator('.bg-white.rounded-lg[role="button"]');
    
    // Wait for thumbnails to appear (at least count)
    await expect(async () => {
    // We expect at least the photos we selected, but hydration might bring back old ones.
    // As long as we have enough to test, we proceed.
    const actualCount = await thumbs.count();
    expect(actualCount).toBeGreaterThanOrEqual(count);
    }).toPass({ timeout: 15000 });

    // 3. Process First Photo
    console.log("Processing First Photo...");
    await thumbs.first().click();
    await expect(page).toHaveURL(/\/photo-history/);
    
    await expect(page.locator('img[alt="Current"]')).toBeVisible();

    // A. Color Correct
    console.log("Running Color Correction...");
    await page.waitForTimeout(1000);
    const colorBtn = page.locator('button:has-text("Color")').first();
    await colorBtn.click();
    await expect(page.locator('text=Previous Version').first()).toBeVisible({ timeout: 60000 });

    // B. Auto Crop
    console.log("Running Auto Crop...");
    const cropBtn = page.locator('button:has-text("Auto Crop")').first();
    await cropBtn.click();
    await expect(page.locator('text=Previous Version').nth(1)).toBeVisible({ timeout: 60000 });

    // C. Remove BG
    console.log("Running Remove Background...");
    const bgBtn = page.locator('button:has-text("Remove BG")').first();
    await bgBtn.click();
    await expect(page.locator('text=Previous Version').nth(2)).toBeVisible({ timeout: 90000 });

    // Screenshot Result
    await page.screenshot({ path: path.join(reportDir, 'photo-1-history.png'), fullPage: true });

    // Write README entry
    fs.writeFileSync(path.join(reportDir, 'README.md'), `# Photo Processing Test Results
    
## Run at ${new Date().toISOString()}

### Photo 1 (${photos[0].id})
- **Color Correction**: Success
- **Auto Crop**: Success
- **Background Removal**: Success
- [View Screenshot](photo-1-history.png)

`);

    // Go back
    await page.locator('button:has-text("Back to Photos")').click();
    await expect(page).toHaveURL('/photos');

    // 4. Process Second Photo (if available)
    if (count > 1) {
        console.log("Processing Second Photo...");
        await thumbs.nth(1).click();
        await expect(page).toHaveURL(/\/photo-history/);
        await expect(page.locator('img[alt="Current"]')).toBeVisible();

        // Just Crop
        await page.locator('button:has-text("Auto Crop")').first().click();
        await expect(page.locator('text=Previous Version').first()).toBeVisible({ timeout: 60000 });

        // Screenshot
        await page.screenshot({ path: path.join(reportDir, 'photo-2-history.png'), fullPage: true });

        // Append to README
        fs.appendFileSync(path.join(reportDir, 'README.md'), `
### Photo 2 (${photos[1].id})
- **Auto Crop**: Success
- [View Screenshot](photo-2-history.png)
`);
    } else {
        console.log("Skipping Second Photo (only 1 available)");
        fs.appendFileSync(path.join(reportDir, 'README.md'), `
### Photo 2
- Skipped (Only 1 photo available in test album)
`);
    }

    console.log("Test Complete.");
  });
});