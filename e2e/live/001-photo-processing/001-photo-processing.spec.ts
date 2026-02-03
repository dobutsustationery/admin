import { test, expect } from '../fixtures';
import { createScreenshotHelper } from '../../helpers/screenshot-helper';
import { TestDocumentationHelper } from '../../helpers/test-documentation-helper';
import * as path from 'path';

test.describe('Live Photo Processing', () => {
  test('Photo Processing Workflow', async ({ page }, testInfo) => {
    test.setTimeout(300000);
    const screenshots = createScreenshotHelper();
    const docHelper = new TestDocumentationHelper(path.dirname(testInfo.file));

    docHelper.setMetadata(
        "Photo Processing (Color, Crop, Remove BG)",
        "**As a** admin user, **I want to** process product photos (Crop, Color Correct, Remove Background) **so that** they are ready for listing."
    );

    // 1. Visit App
    await page.goto('/');
    
    // Dispatch Selection (Simulated Picker)
    // We reuse the logic from previous tests
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

    // Wait for store hook
    await page.waitForFunction(() => !!(window as any).__store);

    let photos = await fetchPhotos();
    if (photos.length < 1) throw new Error("Not enough photos in test album.");
    const count = Math.min(photos.length, 2);
    photos = photos.slice(0, count);

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

    // 2. Photos Page & Selection
    await page.goto('/photos');
    
    const selectionContainer = page.locator('div[class*="min-h-[400px]"]');
    const thumbs = selectionContainer.locator('.bg-white.rounded-lg[role="button"]');
    
    const verifications2 = [
        {
            description: 'At least 1 photo visible in selection area',
            check: async () => {
                await expect(async () => {
                    const c = await thumbs.count();
                    expect(c).toBeGreaterThanOrEqual(1);
                }).toPass();
            }
        }
    ];
    docHelper.addStep('Photos Selected', '000-photos-selected.png', verifications2);
    await screenshots.capture(page, 'photos-selected', {
        programmaticCheck: async () => { for (const v of verifications2) await v.check(); }
    });

    // 3. Process First Photo
    await thumbs.first().click();
    await expect(page).toHaveURL(/\/photo-history/);
    await expect(page.locator('img[alt="Current"]')).toBeVisible();

    // Perform Ops
    await page.locator('button:has-text("Color")').first().click();
    await expect(page.locator('text=Previous Version').first()).toBeVisible({ timeout: 60000 });
    
    await page.locator('button:has-text("Auto Crop")').first().click();
    await expect(page.locator('text=Previous Version').nth(1)).toBeVisible({ timeout: 60000 });

    const bgBtn = page.locator('button:has-text("Remove BG")').first();
    await bgBtn.click();
    await expect(page.locator('text=Previous Version').nth(2)).toBeVisible({ timeout: 180000 });

    const verifications3 = [
        {
            description: 'History contains 3 operations (4 items total including original)',
            check: async () => await expect(page.locator('.space-y-6 > div.relative.flex')).toHaveCount(4)
        }
    ];
    docHelper.addStep('Processed History', '001-processed-history.png', verifications3);
    await screenshots.capture(page, 'processed-history', {
        fullPage: true,
        programmaticCheck: async () => { for (const v of verifications3) await v.check(); }
    });

    docHelper.writeReadme();
  });
});
