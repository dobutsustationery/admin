import { test, expect } from './fixtures';
import fs from 'fs';
import path from 'path';

test.describe('Photo Processing Workflow', () => {
  const reportDir = 'e2e/live/reports/photo-processing';
  
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  test('should process photos with color correction, crop, and background removal', async ({ page }) => {
    console.log("Starting Photo Processing Test...");
    
    await page.goto('/');
    await expect(page.locator('.app-shell')).toBeVisible({ timeout: 10000 });

    // Helper to fetch photos
    const fetchPhotos = async () => {
        const fallbackAlbumId = process.env.E2E_GOOGLE_PHOTOS_ALBUM_ID;
        return await page.evaluate(async (fallbackId) => {
          const tokenStr = localStorage.getItem('google_photos_access_token');
          if (!tokenStr) throw new Error('No Photos Token found in localStorage');
          const token = JSON.parse(tokenStr);
          const albumId = (window as any).__GOOGLE_PHOTOS_ALBUM_ID__ || fallbackId;
          
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
        }, fallbackAlbumId);
    };

    let photos = await fetchPhotos();

    if (photos.length < 2) {
        console.log("Album empty or insufficient. Uploading test images...");
        
        const img1Path = path.resolve('e2e/test-images/006ccee443ad388aa0799f9d6d97290f.jpg');
        const img2Path = path.resolve('e2e/test-images/0134323f36be97f2f6b5619eeae32bcd.jpg');
        
        if (!fs.existsSync(img1Path) || !fs.existsSync(img2Path)) {
             test.skip(true, "Test images not found locally.");
             return;
        }
        
        const img1 = fs.readFileSync(img1Path).toString('base64');
        const img2 = fs.readFileSync(img2Path).toString('base64');
        const fallbackAlbumId = process.env.E2E_GOOGLE_PHOTOS_ALBUM_ID;
        
        await page.evaluate(async ({ img1, img2, fallbackId }) => {
             const tokenStr = localStorage.getItem('google_photos_access_token');
             const token = JSON.parse(tokenStr);
             const albumId = (window as any).__GOOGLE_PHOTOS_ALBUM_ID__ || fallbackId;
             if (!albumId) throw new Error("No Album ID available for upload");

             async function uploadPhoto(b64, filename) {
                 const binary = atob(b64);
                 const array = new Uint8Array(binary.length);
                 for(let i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i);
                 
                 const res1 = await fetch('https://photoslibrary.googleapis.com/v1/uploads', {
                     method: 'POST',
                     headers: {
                         'Authorization': `Bearer ${token.access_token}`,
                         'Content-Type': 'application/octet-stream',
                         'X-Goog-Upload-File-Name': filename,
                         'X-Goog-Upload-Protocol': 'raw'
                     },
                     body: array
                 });
                 if (!res1.ok) throw new Error("Upload failed: " + res1.statusText);
                 const uploadToken = await res1.text();
                 
                 const res2 = await fetch('https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate', {
                     method: 'POST',
                     headers: {
                         'Authorization': `Bearer ${token.access_token}`,
                         'Content-Type': 'application/json'
                     },
                     body: JSON.stringify({
                         albumId: albumId,
                         newMediaItems: [{
                             description: "E2E Test Image",
                             simpleMediaItem: { uploadToken }
                         }]
                     })
                 });
                 if (!res2.ok) throw new Error("BatchCreate failed: " + res2.statusText);
             }
             
             await uploadPhoto(img1, "test1.jpg");
             await uploadPhoto(img2, "test2.jpg");
        }, { img1, img2, fallbackId: fallbackAlbumId });
        
        console.log("Uploaded 2 images. Waiting for propagation...");
        await page.waitForTimeout(5000); // Wait for photos to appear
        photos = await fetchPhotos();
        console.log(`Refetched: ${photos.length} photos.`);
    }

    if (photos.length < 2) {
        test.skip(true, "Still not enough photos after upload attempt.");
        return;
    }

    // Use first 2
    photos = photos.slice(0, 2);

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
    
    await expect(page.locator('img[alt="Current"]')).toBeVisible();

    // A. Color Correct
    console.log("Running Color Correction...");
    // Force a wait to ensure UI is interactive
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

    // 4. Process Second Photo
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

    console.log("Test Complete.");
  });
});