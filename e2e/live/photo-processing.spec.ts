import { test, expect } from './fixtures';
import fs from 'fs';
import path from 'path';

test.describe('Photo Processing Workflow', () => {
  const reportDir = 'e2e/live/reports/photo-processing';
  
  // Ensure report directory exists
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  test('should process photos with color correction, crop, and background removal', async ({ page }) => {
    console.log("Starting Photo Processing Test...");
    
    // 1. Visit App
    await page.goto('/');
    await expect(page.locator('.app-shell')).toBeVisible({ timeout: 10000 });

    // 2. Select 2 Photos (Simulated)
    const photos = await page.evaluate(async () => {
      const tokenStr = localStorage.getItem('google_photos_access_token');
      if (!tokenStr) throw new Error('No Photos Token found in localStorage');
      const token = JSON.parse(tokenStr);
      const albumId = (window as any).__GOOGLE_PHOTOS_ALBUM_ID__;
      
      const url = albumId 
          ? 'https://photoslibrary.googleapis.com/v1/mediaItems:search'
          : 'https://photoslibrary.googleapis.com/v1/mediaItems?pageSize=2';
      const method = albumId ? 'POST' : 'GET';
      const body = albumId ? JSON.stringify({ albumId, pageSize: 2 }) : undefined;

      const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token.access_token}`, ...(albumId ? { 'Content-Type': 'application/json' } : {}) },
        body
      });
      const data = await res.json();
      return data.mediaItems ? data.mediaItems.slice(0, 2) : [];
    });

    if (photos.length < 2) {
        test.skip(true, "Not enough photos in test album to run processing test");
        return;
    }

    // Dispatch Selection
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
    const thumbs = page.locator('.bg-white.rounded-lg[role="button"]');
    await expect(thumbs).toHaveCount(photos.length);

    // 3. Process First Photo
    console.log("Processing First Photo...");
    await thumbs.first().click();
    await expect(page).toHaveURL(/\/photo-history/);
    
    // Wait for image
    await expect(page.locator('img[alt="Current"]')).toBeVisible();

    // A. Color Correct
    console.log("Running Color Correction...");
    const colorBtn = page.locator('button:has-text("Color")').first(); // Use first if multiple (history items might have buttons too? Yes.)
    // We want the button in the CURRENT version (first card).
    // The history loop puts Current Version at top.
    // The buttons are inside `.flex.flex-wrap.gap-2.mt-3`.
    // We should target the one in the FIRST history card.
    // Selector: `.space-y-6 > div.relative.flex:first-child button:has-text("Color")`
    // Or just click the first one found on page, which corresponds to Current.
    await colorBtn.click();
    await expect(page.locator('text=Previous Version').first()).toBeVisible({ timeout: 30000 });

    // B. Auto Crop
    console.log("Running Auto Crop...");
    const cropBtn = page.locator('button:has-text("Auto Crop")').first();
    await cropBtn.click();
    await expect(page.locator('text=Previous Version').nth(1)).toBeVisible({ timeout: 30000 });

    // C. Remove BG
    console.log("Running Remove Background...");
    const bgBtn = page.locator('button:has-text("Remove BG")').first();
    await bgBtn.click();
    await expect(page.locator('text=Previous Version').nth(2)).toBeVisible({ timeout: 60000 });

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

    // 4. Process Second Photo
    console.log("Processing Second Photo...");
    await thumbs.nth(1).click();
    await expect(page).toHaveURL(/\/photo-history/);
    await expect(page.locator('img[alt="Current"]')).toBeVisible();

    // Just Crop
    await page.locator('button:has-text("Auto Crop")').first().click();
    await expect(page.locator('text=Previous Version').first()).toBeVisible({ timeout: 30000 });

    // Screenshot
    await page.screenshot({ path: path.join(reportDir, 'photo-2-history.png'), fullPage: true });

    // Append to README
    fs.appendFileSync(path.join(reportDir, 'README.md'), `
### Photo 2 (${photos[1].id})
- **Auto Crop**: Success
- [View Screenshot](photo-2-history.png)
`);

    console.log("Test Complete.");
  });
});
