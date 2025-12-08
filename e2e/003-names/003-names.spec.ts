import { expect, test } from "../fixtures/auth";
import { createScreenshotHelper } from "../helpers/screenshot-helper";

/**
 * E2E test for the /names page
 *
 * This test suite tells a user story through numbered screenshots:
 * - 000-xxx: Initial signed-out state
 * - 001-xxx: After successful sign-in
 * - 002-xxx: Names list loaded and displayed
 *
 * Each test is a complete user story with:
 * - Programmatic verification (expect() assertions)
 * - Visual verification (numbered screenshots)
 * - Documentation of what to verify in each screenshot
 */

test.describe("Names Page", () => {
  // Helper to check if error is the known transient auth initialization error
  const isTransientAuthError = (errorText: string): boolean => {
    return errorText.includes("Component auth has not been registered yet");
  };

  /**
   * User Story: Admin manages recently used names
   *
   * This test tells a complete story:
   * 1. User starts signed out
   * 2. User signs in
   * 3. User views the names management page
   *
   * Each step has both programmatic and visual verification.
   */
  test("complete names workflow", async ({ page, context }) => {
    // Set test timeout for complete workflow - actual runtime ~2.8s, allowing 5s variance
    test.setTimeout(80000); // 8 seconds

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
    console.log("\n📖 STEP 1: Navigate to names page (signed out)");

    await page.goto("/names", { waitUntil: "load" });

    // Wait for and verify sign-in button appears
    console.log("🔍 Waiting for sign-in button...");
    const signInButton = page.locator('button:has-text("Sign In")');
    await signInButton.waitFor({ state: "visible", timeout: 50000 });

    await screenshots.capture(page, "signed-out-state", {
      programmaticCheck: async () => {
        // Verify sign-in button is visible
        await expect(signInButton).toBeVisible();
        console.log("   ✓ Sign-in button is visible");

        // Verify the page heading
        const heading = page.locator("main h1").first();
        const headingVisible = await heading.isVisible().catch(() => false);
        if (headingVisible) {
          const headingText = await heading.textContent();
          console.log(`   ✓ Page heading: ${headingText}`);
          expect(headingText).toContain("Recently Used Names");
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
      .waitFor({ state: "hidden", timeout: 50000 })
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
    // STEP 3: Wait for names page to load
    // ====================================================================
    console.log("\n📖 STEP 3: Wait for names page to load");

    // Wait for form elements to appear
    console.log("🔍 Waiting for form elements...");
    // Use more specific selector to avoid matching ComboBox labels that might contain "ID"
    // We want the first label in the form, which has "ID:" text
    const idInput = page.locator('h1 + label').first();
    await idInput.waitFor({ state: "visible", timeout: 50000 });
    console.log("   ✓ ID input found");

    await screenshots.capture(page, "names-loaded", {
      programmaticCheck: async () => {
        // Verify heading
        await expect(page.locator("h1")).toContainText("Recently Used Names");
        console.log("   ✓ Page heading shows 'Recently Used Names'");

        // Verify ID input
        await expect(idInput).toBeVisible();
        console.log("   ✓ ID input is visible");

        // Verify Value input
        const valueInput = page.locator('label:has-text("Value")');
        await expect(valueInput).toBeVisible();
        console.log("   ✓ Value input is visible");

        // Verify Add button
        const addButton = page.locator('button:has-text("Add")');
        await expect(addButton).toBeVisible();
        console.log("   ✓ Add button is visible");

        // Verify Redux store has names state
        const namesState = await page.evaluate(() => {
          try {
            const store = (window as any).__REDUX_STORE__;
            if (store) {
              const state = store.getState();
              return {
                hasNames: !!state.names,
                nameCount: Object.keys(state.names?.nameIdToNames || {}).length,
              };
            }
            return null;
          } catch (e) {
            return null;
          }
        });

        if (namesState) {
          console.log(`   ✓ Redux names state:`, namesState);
          expect(namesState.hasNames).toBe(true);
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
        !error.includes("Failed to load resource"),
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

    console.log("\n✅ Complete names workflow test passed!");
    console.log(`   Total screenshots captured: ${screenshots.getCounter()}`);
  });
});
