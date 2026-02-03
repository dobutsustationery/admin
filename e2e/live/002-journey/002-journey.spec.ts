import { test, expect } from '../../live/fixtures';

test.describe('Live Journey', () => {

  test.beforeEach(async ({ page }) => {
    // Ensure Clean State (Clear IDB)
    await page.goto('/'); // Navigate to origin first
    await page.evaluate(async () => {
       await new Promise<void>((resolve) => {
           const req = indexedDB.deleteDatabase("dobutsu_actions_db");
           req.onsuccess = () => resolve();
           req.onerror = () => resolve(); // Ignore error
           req.onblocked = () => resolve();
       });
    });
    // Reload to re-initialize store with empty DB
    await page.reload();
    await expect(page.locator('.app-shell')).toBeVisible({ timeout: 15000 });
  });

  test('Select and categorize first 8 Google Photos', async ({ page }) => {
    // 1. Navigate to Photos Page FIRST
    await page.goto('/photos');
    await expect(page.getByTestId('selection-area')).toBeVisible();

    // 2. Fetch Real Photos via API (using stored token) to simulate Picker selection
    const photos = await page.evaluate(async () => {
      const tokenStr = localStorage.getItem('google_photos_access_token');
      if (!tokenStr) throw new Error('No Photos Token found in localStorage');
      const token = JSON.parse(tokenStr);
      const albumId = (window as any).__GOOGLE_PHOTOS_ALBUM_ID__;
      
      const url = albumId 
          ? 'https://photoslibrary.googleapis.com/v1/mediaItems:search'
          : 'https://photoslibrary.googleapis.com/v1/mediaItems?pageSize=10';
          
      const method = albumId ? 'POST' : 'GET';
      const body = albumId ? JSON.stringify({ albumId, pageSize: 10 }) : undefined;

      const res = await fetch(url, {
        method,
        headers: { 
            Authorization: `Bearer ${token.access_token}`,
            ...(albumId ? { 'Content-Type': 'application/json' } : {})
        },
        body
      });
      
      if (!res.ok) throw new Error(`Google Photos API Error: ${res.status} ${res.statusText}`);
      const data = await res.json();
      return data.mediaItems ? data.mediaItems.slice(0, 8) : [];
    });

    if (photos.length === 0) {
        console.warn("No photos found in test account. Skipping selection verification.");
        return;
    }
    
    console.log(`Fetched ${photos.length} photos from API`);

    // 3. Dispatch Selection (Simulating Picker Result)
    await page.evaluate((items) => {
      const store = (window as any).__store || (window as any).testHelpers?.store;
      if (!store) throw new Error("Redux Store not found on window");
      
      const mapped = items.map((p: any) => ({
        id: p.id,
        baseUrl: p.baseUrl,
        filename: p.filename,
        mimeType: p.mimeType,
        productUrl: p.productUrl,
        mediaMetadata: p.mediaMetadata
      }));
      
      store.dispatch({
        type: 'photos/select_photos',
        payload: { photos: mapped }
      });
    }, photos);

    // Wait for store to update and UI to react
    await page.waitForTimeout(1000);

    // 4. Verify Selection in UI
    const selectionArea = page.getByTestId('selection-area');
    const selectedThumbs = selectionArea.locator('[data-testid^="photo-thumbnail-"]');
    await expect(selectedThumbs).toHaveCount(photos.length);

    // 5. Mock Gemini API for Categorization
    const uniqueId = Date.now().toString().slice(-9); 
    const dummyJan = `4901${uniqueId}`;
    
    await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
        const mockResponseText = dummyJan;
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                candidates: [{
                    content: {
                        parts: [{ text: mockResponseText }]
                    }
                }]
            })
        });
    });

    // 6. Click Categorize
    await expect(page.locator('.loading-overlay')).toBeHidden({ timeout: 15000 });
    
    const categorizeBtn = page.locator('button', { hasText: "Categorize Photos" });
    await expect(categorizeBtn).toBeEnabled();
    await categorizeBtn.click();
    
    // 7. Verify Categorization
    
    // Verify JAN Input exists with specific ID
    const janInput = page.getByTestId(`jan-input-${dummyJan}`);
    await expect(janInput).toBeVisible({ timeout: 15000 });
    await expect(janInput).toHaveValue(dummyJan);
    
    // Verify Group Container
    const groupContainer = page.getByTestId(`group-${dummyJan}`);
    await expect(groupContainer).toBeVisible();

    // Verify photos inside the group
    await expect(groupContainer.locator(`[data-testid^="photo-thumbnail-"]`).first()).toBeVisible({ timeout: 10000 });
    await expect(groupContainer.locator(`[data-testid^="photo-thumbnail-"]`)).toHaveCount(photos.length);
    
    // Verify "Selected" area is empty
    await expect(page.locator('text=No photos queued')).toBeVisible();
    await expect(selectedThumbs).toHaveCount(0);
  });
});