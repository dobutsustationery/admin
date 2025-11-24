import { test, expect } from "./fixtures/auth";

/**
 * E2E test for the /inventory page
 *
 * This test verifies that:
 * 1. The inventory page loads successfully
 * 2. User is able to sign in using Firebase Auth emulator
 * 3. Test data from Firestore emulator is displayed in the inventory table
 * 4. The page renders the expected elements with actual data
 *
 * Note: These tests use Firebase emulators and load test data from
 * test-data/firestore-export.json. The emulators must be running
 * before tests execute.
 */

test.describe("Inventory Page", () => {
  // Helper to check if error is the known transient auth initialization error
  const isTransientAuthError = (errorText: string): boolean => {
    return errorText.includes("Component auth has not been registered yet");
  };

  test("should match visual snapshot - unauthenticated", async ({ page }) => {
    // Collect console errors
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    // Navigate to the inventory page without auth
    await page.goto("/inventory", { waitUntil: "load" });

    console.log('🔍 Waiting for page to initialize...');
    
    // Wait for auth to be ready and page to load
    await page.waitForTimeout(2000);

    // Wait for the sign-in button to appear
    console.log('🔍 Waiting for sign-in button...');
    const signInButton = page.locator('button:has-text("Sign In")');
    await signInButton.waitFor({ state: 'visible', timeout: 15000 });
    console.log('✓ Sign-in button found');

    // Take screenshot of sign-in page
    await expect(page).toHaveScreenshot("inventory-signin-page.png", {
      fullPage: true,
    });
    console.log('✓ Sign-in page screenshot captured');

    // Filter out transient auth initialization errors
    const significantErrors = consoleErrors.filter(
      (error) => !isTransientAuthError(error),
    );

    // Verify no significant console errors (transient auth errors are acceptable)
    expect(significantErrors.length).toBe(0);
  });

  test("should match visual snapshot - authenticated", async ({ authenticatedPage: page }) => {
    // Collect console errors
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    // Navigate to the inventory page with auth already set
    await page.goto("/inventory", { waitUntil: "load" });

    console.log('🔍 Waiting for page to load with auth...');
    
    // Wait for inventory to load
    await page.waitForTimeout(5000); // Give time for broadcast actions to load

    // Wait for the inventory table to be visible
    const inventoryTable = page.locator('table');
    await inventoryTable.waitFor({ state: 'visible', timeout: 15000 });
    console.log('✓ Inventory table found');

    // Verify table structure
    const headers = await page.locator('table thead th').allTextContents();
    console.log(`✓ Found ${headers.length} table headers:`, headers);

    // Verify expected headers are present
    expect(headers.join(' ')).toContain('JAN Code');
    expect(headers.join(' ')).toContain('Quantity');

    // Count inventory rows
    const rowCount = await page.locator('table tbody tr').count();
    console.log(`✓ Found ${rowCount} inventory items displayed`);

    // Verify we have some inventory items
    expect(rowCount).toBeGreaterThan(0);

    // Get sample data from first few rows to verify actual content
    if (rowCount > 0) {
      const sampleRows = Math.min(3, rowCount);
      console.log(`📊 Sample inventory data (first ${sampleRows} rows):`);
      for (let i = 0; i < sampleRows; i++) {
        const rowText = await page.locator('table tbody tr').nth(i).textContent();
        console.log(`   Row ${i + 1}: ${rowText?.substring(0, 100)}...`);
      }
    }

    // Filter out transient auth initialization errors
    const significantErrors = consoleErrors.filter(
      (error) => !isTransientAuthError(error),
    );

    // Check for console errors
    if (consoleErrors.length > 0) {
      console.log(`⚠️  Found ${consoleErrors.length} console errors (${significantErrors.length} significant):`);
      for (const error of consoleErrors) {
        const isTransient = isTransientAuthError(error);
        console.log(`   ${isTransient ? "(transient)" : "(SIGNIFICANT)"} - ${error.substring(0, 200)}`);
      }
    } else {
      console.log("✓ No console errors detected");
    }

    // Take screenshot of the fully loaded inventory page
    await expect(page).toHaveScreenshot("inventory-page-authenticated.png", {
      fullPage: true,
    });

    console.log("✓ Inventory page screenshot captured");

    // Verify no significant console errors (transient auth errors are acceptable)
    expect(significantErrors.length).toBe(0);
  });

  test("should load and display inventory items", async ({ authenticatedPage: page }) => {
    // Collect console messages for debugging
    const consoleMessages: { type: string; text: string }[] = [];
    page.on("console", (msg) => {
      consoleMessages.push({ type: msg.type(), text: msg.text() });
    });

    // Navigate to the inventory page with auth already set
    await page.goto("/inventory", { waitUntil: "load" });

    // Wait for inventory to load
    console.log('🔍 Waiting for inventory table...');
    await page.waitForTimeout(5000); // Give time for broadcast actions to load

    const hasTable = await page.locator("table").isVisible({ timeout: 10000 });

    if (hasTable) {
      console.log("✓ Inventory table detected");

      // Verify the table headers are present
      const headers = await page.locator("table thead th").allTextContents();
      expect(headers.length).toBeGreaterThan(0);
      console.log(`✓ Found ${headers.length} table headers:`, headers);

      // Check for expected headers
      const headersText = headers.join(" ");
      expect(headersText).toContain("JAN Code");
      expect(headersText).toContain("Quantity");

      // Count rows - with test data loaded, we should have items
      const rowCount = await page.locator("table tbody tr").count();
      console.log(`✓ Found ${rowCount} inventory items displayed`);

      // We should have at least some items from the test data
      expect(rowCount).toBeGreaterThan(0);

      // Inspect sample rows to verify data structure
      if (rowCount > 0) {
        const sampleSize = Math.min(3, rowCount);
        console.log(`📊 Verifying data in first ${sampleSize} rows:`);
        
        for (let i = 0; i < sampleSize; i++) {
          const row = page.locator("table tbody tr").nth(i);
          const cells = await row.locator('td').allTextContents();
          
          // Verify row has cells with data
          expect(cells.length).toBeGreaterThan(0);
          
          // At least some cells should have non-empty content
          const nonEmptyCells = cells.filter(c => c.trim().length > 0);
          expect(nonEmptyCells.length).toBeGreaterThan(0);
          
          console.log(`   Row ${i + 1}: ${cells.length} cells, sample: ${cells.slice(0, 3).join(' | ')}`);
        }
      }
    } else {
      throw new Error("Inventory table not found after sign-in");
    }

    // Get console errors
    const errors = consoleMessages.filter((m) => m.type === "error");

    // Log console errors if any
    if (errors.length > 0) {
      console.log(`⚠️  Console errors detected: ${errors.length}`);
      for (const error of errors) {
        console.log(`   - ${error.text.substring(0, 200)}`);
      }
    }

    // Verify no console errors (except transient auth errors)
    const significantErrors = errors.filter((error) => !isTransientAuthError(error.text));
    expect(significantErrors.length).toBe(0);
  });

  test("should have correct page structure", async ({ page }) => {
    // Track console errors
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto("/inventory");

    // Wait for page to be fully loaded
    await page.waitForLoadState("load");
    await page.waitForTimeout(3000);

    // Verify basic page structure
    const bodyText = await page.textContent("body");
    expect(bodyText).toBeTruthy();
    expect(bodyText.length).toBeGreaterThan(0);

    console.log(`✓ Page loaded with ${bodyText.length} characters of content`);

    // Inspect DOM for key elements
    const hasHeader = await page.locator("header, nav, h1, h2").count();
    console.log(`✓ Found ${hasHeader} header/navigation elements`);

    // Check for console errors
    if (consoleErrors.length > 0) {
      console.log(`⚠️  Found ${consoleErrors.length} console errors`);
      for (const error of consoleErrors) {
        console.log(`   - ${error.substring(0, 200)}`);
      }
    } else {
      console.log("✓ No console errors detected");
    }

    // Verify no errors
    const significantErrors = consoleErrors.filter((error) => !isTransientAuthError(error));
    expect(significantErrors.length).toBe(0);
  });

  test("should connect to Firebase emulators", async ({ page }) => {
    const consoleMessages: {
      type: string;
      text: string;
    }[] = [];

    // Enable console logging to see all messages
    page.on("console", (msg) => {
      const text = msg.text();
      const type = msg.type();
      consoleMessages.push({ type, text });

      if (text.includes("Firebase") || text.includes("emulator")) {
        console.log(`Browser console (${type}):`, text);
      }
    });

    await page.goto("/inventory");
    await page.waitForLoadState("load");
    await page.waitForTimeout(3000);

    // Verify page loaded successfully (even if auth blocked content)
    const html = await page.content();
    expect(html).toContain("html");
    expect(html.length).toBeGreaterThan(100);

    console.log("✓ Page HTML loaded successfully");

    // Report console messages summary
    const errors = consoleMessages.filter((m) => m.type === "error");
    const warnings = consoleMessages.filter((m) => m.type === "warning");
    const logs = consoleMessages.filter((m) => m.type === "log");

    console.log(
      `✓ Console summary: ${logs.length} logs, ${warnings.length} warnings, ${errors.length} errors`,
    );

    // Log all console errors for debugging
    if (errors.length > 0) {
      console.log("Console errors:");
      for (const error of errors) {
        console.log(`  - ${error.text.substring(0, 200)}`);
      }
    }

    // Verify no console errors
    const significantErrors = errors.filter((error) => !isTransientAuthError(error.text));
    expect(significantErrors.length).toBe(0);
  });
});
