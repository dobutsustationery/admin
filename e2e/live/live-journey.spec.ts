import { test, expect } from './fixtures';

test('Drive Processing Pipeline Journey', async ({ page, sandboxId }) => {
  // 1. Visit App
  // Auth setup should have already logged us in via storageState
  await page.goto('/');

  // Verify Sign In
  // Check for some authenticated UI element
  await expect(page.locator('.app-shell')).toBeVisible({ timeout: 10000 });
  
  // Verify Store Access
  const storeExists = await page.evaluate(() => typeof (window as any).__store !== 'undefined');
  expect(storeExists).toBe(true);
  
  // 2. Simulate Photo Selection (Bypassing Picker)
  // We dispatch "photos/selected" action?
  // Check redux-firestore.ts or store.ts for action structure.
  // Actually the slice is `photos-slice.ts`.
  
  // Let's create a dummy MediaItem pointing to a public image (or one in Seed?)
  // Ideally use a stable image URL that Fetch can handle.
  // Google Drive public URL from Seed?
  // Or just a placeholder if we assume `fetch` mock?
  // NO MOCKS. "Real Google Drive...".
  // So we need a real URL reachable by browser fetch.
  // If we used `test-client-id`, browser fetch to Google APIs fails?
  // We injected REAL tokens. So authenticated fetch works!
  
  // We need a URL. Let's use a known public image or one from Seed if we knew the ID.
  // We can't easily discover Seed ID here without API call.
  // We can maybe use a data URL for simplicity?
  // `PhotoUploadManager` fetches the URL.
  // If we use Data URL, `fetch(data:...)` works in browser!
  // Perfect.
  
  const testId = `test_live_${Date.now()}`;
  const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="; // Red pixel
  
  const mediaItem = {
      id: testId,
      baseUrl: dataUrl,
      filename: 'live_test_pixel.png',
      mimeType: 'image/png',
      productUrl: 'http://example.com',
      mediaMetadata: { creationTime: new Date().toISOString() }
  };
  
  // Dispatch Selection
  await page.evaluate((item) => {
      const { store } = (window as any);
      // We need the action creator.
      // If action is NOT exposed on window, we can construct the object manually if we know the type.
      // `photos/addPhotos` or similar.
      // `photos-slice.ts` likely exports `addPhotos`.
      // We didn't expose slice actions.
      // But we can `store.dispatch({ type: 'photos/setSelected', payload: [item] })` if we know the string type.
      // It's Redux Toolkit. Type is usually "photos/setSelected".
      // Let's assume standard RTK naming.
      
      store.dispatch({ 
          type: 'photos/setSelected', 
          payload: [item] 
      });
      
  }, mediaItem);
  
  // 3. Wait for Upload
  // PhotoUploadManager runs every 2s.
  // It checks `uploads` state.
  // Actually `photos/setSelected` sets `selected`.
  // `getUploadCandidates` checks `selected` vs `uploads`.
  // If `uploads[id]` is missing, it candidates it.
  // `uploadItem` calls `broadcast`.
  // `broadcast` emits `photos/initiate_upload` -> Firestore -> Sync -> Redux `uploads` slice update.
  // This loop depends on Firestore Emulator being running and connected!
  // And `+layout.svelte` receiving the broadcast.
  
  // Wait for `uploads[testId]` to become 'completed'.
  
  await expect(async () => {
      const status = await page.evaluate((id) => {
          const s = (window as any).__store.getState();
          return s.photos.uploads[id]?.status;
      }, testId);
      console.log(`Current status for ${testId}:`, status);
      expect(status).toBe('completed');
  }).toPass({ timeout: 15000 });
  
  // 4. Verify Result
  const result = await page.evaluate((id) => {
      const s = (window as any).__store.getState();
      return s.photos.uploads[id];
  }, testId);
  
  expect(result.permanentUrl).toContain('drive.google.com');
  console.log('✅ Upload verification passed:', result.permanentUrl);

});
