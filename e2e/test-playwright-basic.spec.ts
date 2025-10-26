import { test } from "@playwright/test";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

/**
 * Basic test to verify Playwright screenshot functionality
 * 
 * This test loads a simple static HTML file with no JavaScript or CSS
 * to isolate whether screenshot issues are from Playwright itself or
 * from the application code.
 */
test.describe("Playwright Basic Screenshot Test", () => {
  test("should capture non-blank screenshot of static HTML", async ({ page }) => {
    // Get the path to the static HTML file
    const htmlPath = join(process.cwd(), "e2e/test-static/hello.html");
    const fileUrl = `file://${htmlPath}`;
    
    console.log(`Loading static HTML from: ${fileUrl}`);
    
    // Navigate to the static HTML file
    await page.goto(fileUrl);
    
    // Wait a moment for any rendering
    await page.waitForTimeout(1000);
    
    // Get the page content to verify it loaded
    const bodyText = await page.evaluate(() => document.body.innerText);
    console.log(`Page text content: "${bodyText.trim()}"`);
    console.log(`Text length: ${bodyText.length} characters`);
    
    // Take screenshot with page.screenshot()
    await page.screenshot({
      path: "e2e/screenshots/test-static-manual.png",
      fullPage: true,
    });
    console.log("✓ Screenshot saved to e2e/screenshots/test-static-manual.png");
    
    // Also try with toHaveScreenshot() for comparison
    await page.screenshot({
      path: "e2e/screenshots/test-static-expect.png",
      fullPage: true,
    });
    console.log("✓ Screenshot saved to e2e/screenshots/test-static-expect.png");
  });
});
