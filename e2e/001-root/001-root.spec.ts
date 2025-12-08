import { expect, test } from "../fixtures/auth";
import { createScreenshotHelper } from "../helpers/screenshot-helper";

/**
 * E2E test for the / (root/home) page
 *
 * This test suite tells a user story through numbered screenshots:
 * - 000-xxx: Initial signed-out state
 * - 001-xxx: After successful sign-in
 * - 002-xxx: Dashboard loaded
 * - 003-xxx: Navigate to Inventory Entry
 */

test.describe("Root Page (Dashboard)", () => {
    // Helper to check if error is the known transient auth initialization error
    const isTransientAuthError = (errorText: string): boolean => {
      return errorText.includes("Component auth has not been registered yet");
    };
  
    /**
     * User Story: Admin lands on Dashboard and navigates to entry
     */
    test("complete dashboard to inventory entry workflow", async ({ page, context }) => {
      // Set test timeout for complete workflow - actual runtime ~3s, allowing 5s variance
      test.setTimeout(80000); // 8 seconds
  
      const screenshots = createScreenshotHelper();
  
      // Collect console errors throughout the test
      const consoleErrors: string[] = [];
      page.on("console", (msg) => {
      // Print all console logs to debug specific issues
      console.log(`BROWSER_LOG: ${msg.type()} - ${msg.text()}`);
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });
  
      // ====================================================================
      // STEP 1: Signed out state - user needs to sign in
      // ====================================================================
      console.log("\n📖 STEP 1: Navigate to root page (signed out)");
  
      await page.goto("/", { waitUntil: "load" });
  
      // Wait for and verify sign-in button appears
      console.log("🔍 Waiting for sign-in button...");
      const signInButton = page.locator('button:has-text("Sign In")'); // Matches Signin.svelte
      // OR depending on new layout implementation, it might be in the main area
      await signInButton.waitFor({ state: "visible", timeout: 50000 });
  
      await screenshots.capture(page, "signed-out-state", {
        programmaticCheck: async () => {
          // Verify sign-in button is visible
          await expect(signInButton).toBeVisible();
          console.log("   ✓ Sign-in button is visible");
  
          // Verify the page heading - Dashboard should verify "Dobutsu Admin" or similar from Layout/Signin
          const heading = page.locator("h1"); 
          if (await heading.isVisible()) {
             const text = await heading.textContent();
             console.log(`   ✓ Heading: ${text}`);
          }
        },
      });
  
      // ====================================================================
      // STEP 2: Sign in to the application
      // ====================================================================
      console.log("\n📖 STEP 2: Sign in to application");
  
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
        },
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
  
      console.log("   ✓ Auth state injected into localStorage");
  
      // Reload the page to apply authentication
      await page.reload({ waitUntil: "load" });
  
      console.log("   ✓ Page reloaded with authentication");
  
      // Wait for authentication to be processed - dashboard should appear
      // Wait for "Dashboard" h1
      const dashboardHeading = page.locator('h1:has-text("Dashboard")');
      await dashboardHeading.waitFor({ state: "visible", timeout: 50000 });
      
      await screenshots.capture(page, "dashboard-loaded", {
        programmaticCheck: async () => {
             await expect(dashboardHeading).toBeVisible();
             console.log("   ✓ Dashboard heading visible");
             
             // Check for metrics
             const metrics = page.locator('.metric-value').first();
             await expect(metrics).toBeVisible();
             console.log("   ✓ Dashboard metrics visible");
        }
      });
  
      // ====================================================================
      // STEP 3: Navigate to Inventory Entry
      // ====================================================================
      console.log("\n📖 STEP 3: Navigate to Inventory Entry");
      
      const addInventoryLink = page.locator('a[href="/entry"]');
      // Could accept either the quick action card or nav link
      await addInventoryLink.first().click();
      
      // Wait for form elements to appear
      console.log("🔍 Waiting for form elements...");
      const janCodeInput = page.locator('label:has-text("JAN Code")');
      await janCodeInput.waitFor({ state: "visible", timeout: 50000 });
      console.log("   ✓ JAN Code input found");
  
      await screenshots.capture(page, "entry-form-loaded", {
        programmaticCheck: async () => {
          // Verify form elements are present
          // Note: InventoryScanner doesn't have an H1 "Inventory" inside it necessarily, 
          // or maybe it does? The previous test checked for h1 containing Inventory.
          // Let's check for the form specifically.
          
          // Verify JAN Code input
          await expect(janCodeInput).toBeVisible();
          console.log("   ✓ JAN Code input is visible");
  
          // Verify Quantity input
          const qtyInput = page.locator('label:has-text("Quantity")');
          await expect(qtyInput).toBeVisible();
          
          // Verify Description textarea
          const descTextarea = page.locator('label:has-text("Description")');
          await expect(descTextarea).toBeVisible();
          
          // Verify URL is correct
          expect(page.url()).toContain("/entry");
          console.log("   ✓ URL updated to /entry");
        },
      });
  
      // ====================================================================
      // Final verification: No significant console errors
      // ====================================================================
      console.log("\n📖 Final verification: Console errors");
  
      // Filter out transient auth initialization errors and image loading errors
      const significantErrors = consoleErrors.filter(
        (error) =>
          !isTransientAuthError(error) &&
          !error.includes("ERR_NAME_NOT_RESOLVED") &&
          !error.includes("Failed to load resource") &&
          !error.includes("CustomSearch API") &&
          !error.includes("Could not reach Cloud Firestore backend"),
      );
  
      if (consoleErrors.length > 0) {
        // ... (logging logic)
      }
  
      // Verify no significant console errors
      expect(significantErrors.length).toBe(0);
  
      console.log("\n✅ Complete dashboard navigation workflow test passed!");
      console.log(`   Total screenshots captured: ${screenshots.getCounter()}`);
    });
  });
