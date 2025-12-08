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
  const loadingOverlay = page.locator('.loading-overlay');
  
  // First, check if it's even visible. If so, wait for it to detach.
  // If we just ask for detached and it was never there, it returns immediately (if hidden) or waits?
  // playright .waitFor({ state: 'detached' }) waits for it to NOT be present.
  // If it's already not present, it resolves immediately.
  console.log("⏳ Waiting for application to be ready...");
  await loadingOverlay.waitFor({ state: 'detached', timeout: 30000 });
  console.log("   ✓ Application ready (loading screen removed)");
}
