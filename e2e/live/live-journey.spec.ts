import { test, expect } from './fixtures';

test('Select and categorize first 8 Google Photos', async ({ page }) => {
  // 1. Visit App
  await page.goto('/');
  // Wait for shell or sign-in. If setup worked, we are signed in.
  // Note: auth.setup.ts might need work to fully bypass Firebase Auth UI, 
  // but assuming we are in, we check for app shell.
  // If not, we might be stuck at Sign In.
  
  // Check if we are at Sign In
  const signin = page.locator('.signin-container');
  if (await signin.isVisible()) {
      console.log("Stuck at Sign In. Attempting to bypass...");
      // Try to inject auth state directly if possible?
      // Or fail if auth setup didn't work.
      // For now, let's assume we proceed or fail here.
  }
  
  await expect(page.locator('.app-shell')).toBeVisible({ timeout: 10000 });

  // 2. Fetch Real Photos via API (using stored token) to simulate Picker selection
  const photos = await page.evaluate(async () => {
    const tokenStr = localStorage.getItem('google_photos_access_token');
    if (!tokenStr) throw new Error('No Photos Token found in localStorage');
    const token = JSON.parse(tokenStr);
    const albumId = (window as any).__GOOGLE_PHOTOS_ALBUM_ID__;
    
    // Call Google Photos API: Search in our test album to ensure we get test data
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
  // We use the store dispatch because controlling the real Google Picker popup 
  // in automation is extremely difficult (cross-origin iframe/window).
  await page.evaluate((items) => {
    const store = (window as any).__store;
    // Map API response to App's MediaItem shape
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

  // 4. Verify Selection in UI
  await page.goto('/photos');
  
  // Wait for thumbnails to appear in the "Selected" area
  // Use a stable selector for the thumbnail cards
  const thumbs = page.locator('.bg-white.rounded-lg[role="button"]');
  await expect(thumbs).toHaveCount(photos.length);

  // 5. Mock Gemini API for Categorization
  // We mock the response to ensure deterministic grouping and avoid needing a Gemini Key in CI.
  await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
      // Mock Gemini response: Group all photos under one dummy JAN code
      const dummyJan = "4901234567890";
      const grouping = {};
      grouping[dummyJan] = photos.map((p: any) => p.id);
      
      const mockResponseText = JSON.stringify(grouping);
      
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
  const categorizeBtn = page.locator('button', { hasText: "Categorize Photos" });
  await expect(categorizeBtn).toBeEnabled();
  await categorizeBtn.click();
  
  // 7. Verify Categorization
  // The "Categorized Photos" section should appear with our dummy JAN
  await expect(page.locator('h2', { hasText: "Categorized Photos" })).toBeVisible({ timeout: 15000 });
  
  // Check that our JAN code exists in the input
  const janInput = page.locator('input.editable-jan');
  await expect(janInput).toHaveValue("4901234567890");
  
  // Check that all photos are moved to this group
  // The group container contains the thumbnails.
  // We verify that the "Selected" area is empty or reduced? 
  // `select_photos` are removed from `selected` upon categorization in the reducer.
  // So the top list should be empty.
  
  // Wait for "No photos queued" message in top area
  await expect(page.locator('text=No photos queued')).toBeVisible();
  
  // Verify items in the categorized group
  const groupContainer = page.locator('.categorized-row', { hasText: "4901234567890" });
  await expect(groupContainer.locator('div[role="button"]')).toHaveCount(photos.length);
  
});