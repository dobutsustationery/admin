import { type Page, expect } from "@playwright/test";

/**
 * Waits for the application to be fully ready (loading screen removed)
 *
 * This should be called after sign-in and after any navigation that might triggering
 * a full data sync or loading state.
 */
export async function waitForAppReady(page: Page) {
  console.log("⏳ Waiting for application to be ready...");
  const loadingOverlay = page.locator(".loading-overlay");
  await loadingOverlay.waitFor({ state: "detached", timeout: 30000 });

  // Some CI runs can briefly re-attach the overlay after auth/store hydration.
  // Require stable absence before moving on to screenshot capture.
  for (let i = 0; i < 5; i += 1) {
    await loadingOverlay.waitFor({ state: "detached", timeout: 5000 });
    await page.waitForTimeout(100);
  }
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
