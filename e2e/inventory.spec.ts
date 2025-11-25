import { test, expect } from "./fixtures/auth";
import { createScreenshotHelper } from "./helpers/screenshot-helper";

/**
 * E2E test for the /inventory page
 *
 * This test suite tells a user story through numbered screenshots:
 * - 000-xxx: Initial signed-out state
 * - 001-xxx: After successful sign-in
 * - 002-xxx: Inventory data loaded and displayed
 * - etc.
 *
 * Each test is a complete user story with:
 * - Programmatic verification (expect() assertions)
 * - Visual verification (numbered screenshots)
 * - Documentation of what to verify in each screenshot
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

  /**
   * User Story: Admin views inventory after signing in
   * 
   * This test tells a complete story:
   * 1. User starts signed out
   * 2. User signs in
   * 3. User views inventory with data loaded
   * 
   * Each step has both programmatic and visual verification.
   */
  test("complete inventory workflow", async ({ page, context }) => {
    // Set test timeout for complete workflow
    test.setTimeout(120000); // 2 minutes
    
    const screenshots = createScreenshotHelper();
    
    // Collect console errors throughout the test
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    // ====================================================================
    // STEP 1: Signed out state - user needs to sign in
    // ====================================================================
    console.log('\n📖 STEP 1: Navigate to inventory page (signed out)');
    
    await page.goto("/inventory", { waitUntil: "load" });
    await page.waitForTimeout(2000); // Allow page to initialize
    
    // Wait for and verify sign-in button appears
    console.log('🔍 Waiting for sign-in button...');
    const signInButton = page.locator('button:has-text("Sign In")');
    await signInButton.waitFor({ state: 'visible', timeout: 15000 });
    
    await screenshots.capture(page, "signed-out-state", {
      programmaticCheck: async () => {
        // Verify sign-in button is visible
        await expect(signInButton).toBeVisible();
        console.log('   ✓ Sign-in button is visible');
      }
    });

    // ====================================================================
    // STEP 2: Sign in to the application
    // ====================================================================
    console.log('\n📖 STEP 2: Sign in to application');
    
    // Create authenticated user
    const authEmulatorUrl = "http://localhost:9099";
    const testEmail = `test-${Date.now()}@example.com`;
    const testPassword = "testpassword123";
    
    console.log(`   Creating test user: ${testEmail}`);
    const authResponse = await page.request.post(
      `${authEmulatorUrl}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key`,
      {
        data: {
          email: testEmail,
          password: testPassword,
          displayName: "Test User",
          returnSecureToken: true,
        },
      }
    );
    
    if (!authResponse.ok()) {
      throw new Error(`Failed to create test user: ${authResponse.status()}`);
    }
    
    const authData = await authResponse.json();
    console.log(`   ✓ Test user created with UID: ${authData.localId}`);
    
    // Inject auth state into localStorage
    await page.evaluate((authInfo) => {
      const authKey = "firebase:authUser:demo-api-key:[DEFAULT]";
      localStorage.setItem(
        authKey,
        JSON.stringify({
          uid: authInfo.localId,
          email: authInfo.email,
          emailVerified: false,
          displayName: "Test User",
          isAnonymous: false,
          photoURL: null,
          providerData: [
            {
              providerId: "password",
              uid: authInfo.localId,
              displayName: "Test User",
              email: authInfo.email,
              phoneNumber: null,
              photoURL: null,
            },
          ],
          stsTokenManager: {
            refreshToken: authInfo.refreshToken,
            accessToken: authInfo.idToken,
            expirationTime: Date.now() + 3600000,
          },
          createdAt: String(Date.now()),
          lastLoginAt: String(Date.now()),
          apiKey: "demo-api-key",
          appName: "[DEFAULT]",
        }),
      );
    }, authData);
    
    console.log('   ✓ Auth state injected into localStorage');
    
    // Reload the page to apply authentication
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(2000);
    
    console.log('   ✓ Page reloaded with authentication');
    
    await screenshots.capture(page, "signed-in-state", {
      programmaticCheck: async () => {
        // Verify we're no longer seeing the sign-in button
        const signInStillVisible = await signInButton.isVisible().catch(() => false);
        expect(signInStillVisible).toBe(false);
        console.log('   ✓ Sign-in button no longer visible');
      }
    });

    // ====================================================================
    // STEP 3: Wait for inventory data to load
    // ====================================================================
    console.log('\n📖 STEP 3: Wait for inventory data to load');
    
    // Wait for inventory table to appear
    console.log('🔍 Waiting for inventory table...');
    const inventoryTable = page.locator('table');
    await inventoryTable.waitFor({ state: 'visible', timeout: 15000 });
    console.log('   ✓ Inventory table found');
    
    // Poll for inventory data to load (Redux state processing takes time)
    // Processing 400 broadcast events through Redux can take significant time
    console.log('🔍 Waiting for inventory data rows...');
    const maxWaitMs = 60000; // 60 seconds - data loading can take time
    const pollIntervalMs = 1000;
    const startTime = Date.now();
    let rowCount = 0;
    
    // Note: table rows are direct children of <table>, not in <tbody>
    // We count all <tr> elements except the header row in <thead>
    while (Date.now() - startTime < maxWaitMs) {
      rowCount = await page.locator('table > tr').count();
      if (rowCount > 0) {
        console.log(`   ✓ Found ${rowCount} rows after ${Date.now() - startTime}ms`);
        break;
      }
      console.log(`   Still waiting... ${Math.floor((Date.now() - startTime) / 1000)}s elapsed`);
      await page.waitForTimeout(pollIntervalMs);
    }
    
    await screenshots.capture(page, "inventory-loaded", {
      programmaticCheck: async () => {
        // Verify table structure
        const headers = await page.locator('table thead th').allTextContents();
        console.log(`   ✓ Found ${headers.length} table headers:`, headers);
        
        // Verify expected headers are present
        expect(headers.join(' ')).toContain('JAN Code');
        expect(headers.join(' ')).toContain('Quantity');
        
        // Verify we have inventory rows (rows directly under table, not in thead)
        const finalRowCount = await page.locator('table > tr').count();
        console.log(`   ✓ Found ${finalRowCount} inventory items displayed`);
        expect(finalRowCount).toBeGreaterThan(0);
        
        // Verify sample data structure
        if (finalRowCount > 0) {
          const sampleRows = Math.min(3, finalRowCount);
          console.log(`   📊 Sample inventory data (first ${sampleRows} rows):`);
          for (let i = 0; i < sampleRows; i++) {
            const row = page.locator('table > tr').nth(i);
            const cells = await row.locator('td').allTextContents();
            
            // Verify row has cells with data
            expect(cells.length).toBeGreaterThan(0);
            
            // At least some cells should have non-empty content
            const nonEmptyCells = cells.filter(c => c.trim().length > 0);
            expect(nonEmptyCells.length).toBeGreaterThan(0);
            
            console.log(`      Row ${i + 1}: ${cells.slice(0, 3).join(' | ')}`);
          }
        }
      }
    });

    // ====================================================================
    // Final verification: No significant console errors
    // ====================================================================
    console.log('\n📖 Final verification: Console errors');
    
    // Filter out transient auth initialization errors and image loading errors
    const significantErrors = consoleErrors.filter(
      (error) => !isTransientAuthError(error) && 
                 !error.includes('ERR_NAME_NOT_RESOLVED') && 
                 !error.includes('Failed to load resource')
    );
    
    if (consoleErrors.length > 0) {
      console.log(`   Found ${consoleErrors.length} console errors (${significantErrors.length} significant):`);
      if (significantErrors.length > 0) {
        for (const error of significantErrors) {
          console.log(`      (SIGNIFICANT) - ${error.substring(0, 200)}`);
        }
      }
    } else {
      console.log("   ✓ No console errors detected");
    }
    
    // Verify no significant console errors
    expect(significantErrors.length).toBe(0);
    
    console.log('\n✅ Complete inventory workflow test passed!');
    console.log(`   Total screenshots captured: ${screenshots.getCounter()}`);
  });
});
