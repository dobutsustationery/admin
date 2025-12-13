import { type Page, expect } from "@playwright/test";

/**
 * Helper for creating numbered screenshots in E2E tests
 *
 * This helper creates screenshots in the format: NNN-description.png
 * where NNN is a zero-padded number (000, 001, 002, etc.)
 *
 * Screenshots default to viewport-size (fullPage: false) to ensure
 * consistent dimensions across all screenshots. This is important for
 * visual regression testing with zero-pixel tolerance.
 *
 * Usage:
 * const screenshots = createScreenshotHelper();
 * await screenshots.capture(page, "signed-out-state");
 * await screenshots.capture(page, "after-sign-in");
 */

export interface ScreenshotHelper {
  /**
   * Capture a numbered screenshot with description
   * @param page - Playwright page object
   * @param description - Description of what this screenshot shows
   * @param options - Additional screenshot options
   */
  capture(
    page: Page,
    description: string,
    options?: {
      fullPage?: boolean;
      programmaticCheck?: () => Promise<void>;
      mask?: Array<any>; // Allow Playwright locators for masking
      [key: string]: any; // Allow other Playwright snapshot options
    },
  ): Promise<void>;

  /**
   * Reset the counter (useful for test setup)
   */
  reset(): void;

  /**
   * Get the current counter value
   */
  getCounter(): number;
}

/**
 * Create a new screenshot helper with independent counter
 */
export function createScreenshotHelper(startIndex = 0): ScreenshotHelper {
  let counter = startIndex;

  return {
    async capture(page, description, options = {}) {
      const { fullPage = false, programmaticCheck, ...rest } = options;

      // Format: 000-description.png
      const paddedNumber = String(counter).padStart(3, "0");
      const filename = `${paddedNumber}-${description}.png`;

      console.log(`📸 Capturing screenshot ${counter}: ${filename}`);

      // Execute programmatic check if provided
      if (programmaticCheck) {
        console.log(`   ✓ Running programmatic verification...`);
        await programmaticCheck();
      }

      // Take the screenshot
      await expect(page).toHaveScreenshot(filename, {
        fullPage,
        ...rest,
      });

      console.log(`   ✓ Screenshot saved: ${filename}`);

      // Increment counter for next screenshot
      counter++;
    },

    reset() {
      counter = 0;
    },

    getCounter() {
      return counter;
    },
  };
}
