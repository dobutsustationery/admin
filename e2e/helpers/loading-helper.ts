import { type Page, expect } from "@playwright/test";

/**
 * Waits for the application to be fully ready (loading screen removed)
 *
 * This should be called after sign-in and after any navigation that might triggering
 * a full data sync or loading state.
 */
export async function waitForAppReady(page: Page) {
  // Wait for loading overlay to disappear
  // The overlay is removed from DOM when ready
  const loadingOverlay = page.locator(".loading-overlay");

  // First, check if it's even visible. If so, wait for it to detach.
  // If we just ask for detached and it was never there, it returns immediately (if hidden) or waits?
  // playright .waitFor({ state: 'detached' }) waits for it to NOT be present.
  // If it's already not present, it resolves immediately.
  console.log("⏳ Waiting for application to be ready...");
  await loadingOverlay.waitFor({ state: "detached", timeout: 30000 });
  console.log("   ✓ Application ready (loading screen removed)");
}

/**
 * Waits for all images on the page to be fully loaded, decoded, and ready for display.
 * This is crucial for stable visual snapshots, especially to avoid antialiasing issues.
 */
export async function waitForImages(page: Page) {
  console.log("⏳ Waiting for images to load and decode...");
  await page.evaluate(async () => {
    const loaders = Array.from(document.images).map(async (img) => {
      if (img.src) {
        try {
          if (!img.complete) {
            await new Promise((resolve) => {
              img.onload = resolve;
              img.onerror = resolve;
            });
          }
          // Ensure the image is decoded and ready for rendering
          await img.decode();
        } catch (e) {
          // Ignore decode errors for broken images
        }
      }
    });
    await Promise.all(loaders);
    // Extra frame to ensure layout/rendering has settled
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}
