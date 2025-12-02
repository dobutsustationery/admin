import { expect, test } from "../fixtures/auth";
import { createScreenshotHelper } from "../helpers/screenshot-helper";

/**
 * E2E test for the /jancodes page
 *
 * This test suite tells a user story through numbered screenshots:
 * - 000-xxx: Initial signed-out state
 * - 001-xxx: After successful sign-in
 * - 002-xxx: JAN codes page loaded showing items with blank subtype
 *
 * Each test is a complete user story with:
 * - Programmatic verification (expect() assertions)
 * - Visual verification (numbered screenshots)
 * - Documentation of what to verify in each screenshot
 */

test.describe("JAN Codes Page", () => {
  // Helper to check if error is the known transient auth initialization error
  const isTransientAuthError = (errorText: string): boolean => {
    return errorText.includes("Component auth has not been registered yet");
  };

  /**
   * User Story: Admin views items with blank subtype by JAN code
   *
   * This test tells a complete story:
   * 1. User starts signed out
   * 2. User signs in
   * 3. User views the JAN codes page showing items with blank subtypes
   *
   * Each step has both programmatic and visual verification.
   */
  test("complete jancodes workflow", async ({ page, context }) => {
    // Set test timeout for complete workflow - actual runtime ~3s, allowing 5s variance
    test.setTimeout(8000); // 8 seconds

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
    console.log("\n📖 STEP 1: Navigate to jancodes page (signed out)");

    await page.goto("/jancodes", { waitUntil: "load" });

    // Wait for and verify sign-in button appears
    console.log("🔍 Waiting for sign-in button...");
    const signInButton = page.locator('button:has-text("Sign In")');
    await signInButton.waitFor({ state: "visible", timeout: 5000 });

    await screenshots.capture(page, "signed-out-state", {
      programmaticCheck: async () => {
        // Verify sign-in button is visible
        await expect(signInButton).toBeVisible();
        console.log("   ✓ Sign-in button is visible");

        // Verify the page heading
        const heading = page.locator("h1").first();
        const headingVisible = await heading.isVisible().catch(() => false);
        if (headingVisible) {
          const headingText = await heading.textContent();
          console.log(`   ✓ Page heading: ${headingText}`);
          expect(headingText).toContain("Items with a blank subtype");
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

    // Wait for authentication to be processed
    await signInButton
      .waitFor({ state: "hidden", timeout: 5000 })
      .catch(() => {
        console.log("   ⚠️  Sign-in button still visible, but continuing...");
      });

    await screenshots.capture(page, "signed-in-state", {
      programmaticCheck: async () => {
        // Verify we're no longer seeing the sign-in button
        const signInStillVisible = await signInButton
          .isVisible()
          .catch(() => false);
        expect(signInStillVisible).toBe(false);
        console.log("   ✓ Sign-in button no longer visible");

        // Check if Redux store has user state
        const hasAuthState = await page
          .evaluate(() => {
            try {
              const store = (window as any).__REDUX_STORE__;
              if (store) {
                const state = store.getState();
                return state.user?.uid;
              }
              return false;
            } catch (e) {
              return false;
            }
          })
          .catch(() => false);

        if (hasAuthState) {
          console.log("   ✓ Redux store contains authenticated user state");
        }
      },
    });

    // ====================================================================
    // STEP 3: Wait for JAN codes page to load
    // ====================================================================
    console.log("\n📖 STEP 3: Wait for JAN codes page to load");

    // Wait for page content to appear - the page heading
    console.log("🔍 Waiting for page heading...");
    const heading = page.locator("h1");
    await heading.waitFor({ state: "visible", timeout: 5000 });
    console.log("   ✓ Page heading found");

    await screenshots.capture(page, "jancodes-loaded", {
      programmaticCheck: async () => {
        // Verify heading
        await expect(heading).toContainText("Items with a blank subtype");
        console.log("   ✓ Page heading shows 'Items with a blank subtype'");

        // Check if there are any tables (there might not be any if no items have blank subtypes)
        const tables = page.locator("table");
        const tableCount = await tables.count();
        console.log(`   ✓ Found ${tableCount} table(s) on page`);

        // If there are tables, verify their structure
        if (tableCount > 0) {
          const firstTable = tables.first();
          await expect(firstTable).toBeVisible();
          console.log("   ✓ At least one table is visible");

          // Verify table headers
          const headers = await firstTable.locator("thead th").allTextContents();
          expect(headers).toContain("Image");
          expect(headers).toContain("Subtype");
          expect(headers).toContain("HS Code");
          expect(headers).toContain("Description");
          console.log("   ✓ Table headers are correct:", headers);
        } else {
          console.log("   ℹ️  No tables displayed (no items with blank subtypes)");
        }

        // Verify Redux store has inventory state
        const inventoryState = await page.evaluate(() => {
          try {
            const store = (window as any).__REDUX_STORE__;
            if (store) {
              const state = store.getState();
              return {
                hasInventory: !!state.inventory,
                itemCount: Object.keys(state.inventory?.idToItem || {}).length,
              };
            }
            return null;
          } catch (e) {
            return null;
          }
        });

        if (inventoryState) {
          console.log(`   ✓ Redux inventory state:`, inventoryState);
          expect(inventoryState.hasInventory).toBe(true);
        }

        // Verify no errors
        const errorMessage = page.locator('.error, [role="alert"]').first();
        const hasError = await errorMessage.isVisible().catch(() => false);
        expect(hasError).toBe(false);
        console.log("   ✓ No error messages displayed");
      },
    });

    // ====================================================================
    // Final verification: No significant console errors
    // ====================================================================
    console.log("\n📖 Final verification: Console errors");

    const significantErrors = consoleErrors.filter(
      (error) =>
        !isTransientAuthError(error) &&
        !error.includes("ERR_NAME_NOT_RESOLVED") &&
        !error.includes("Failed to load resource") &&
        !error.includes("CustomSearch API") &&
        !error.includes("Could not reach Cloud Firestore backend"),
    );

    if (consoleErrors.length > 0) {
      console.log(
        `   Found ${consoleErrors.length} console errors (${significantErrors.length} significant):`,
      );
      if (significantErrors.length > 0) {
        for (const error of significantErrors) {
          console.log(`      (SIGNIFICANT) - ${error.substring(0, 200)}`);
        }
      }
    } else {
      console.log("   ✓ No console errors detected");
    }

    expect(significantErrors.length).toBe(0);

    console.log("\n✅ Complete jancodes workflow test passed!");
    console.log(`   Total screenshots captured: ${screenshots.getCounter()}`);
  });
});
