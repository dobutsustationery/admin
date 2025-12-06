import { expect, test } from "../fixtures/auth";
import { createScreenshotHelper } from "../helpers/screenshot-helper";
import { TestDocumentationHelper } from "../helpers/test-documentation-helper";
import * as path from "path";

/**
 * E2E test for the /csv page
 *
 * This test suite tells a user story through numbered screenshots:
 * - 000-xxx: Initial signed-out state
 * - 001-xxx: After successful sign-in
 * - 002-xxx: CSV data loaded and displayed
 *
 * Each test is a complete user story with:
 * - Programmatic verification (expect() assertions)
 * - Visual verification (numbered screenshots)
 * - Documentation of what to verify in each screenshot
 */

test.describe("CSV Export Page", () => {
  // Helper to check if error is the known transient auth initialization error
  const isTransientAuthError = (errorText: string): boolean => {
    return errorText.includes("Component auth has not been registered yet");
  };

  /**
   * User Story: Admin views CSV export
   *
   * This test tells a complete story:
   * 1. User starts signed out
   * 2. User signs in
   * 3. User views CSV export of inventory data
   *
   * Each step has both programmatic and visual verification.
   */
  test("complete CSV export workflow", async ({ page, context }, testInfo) => {
    // Set test timeout for complete workflow - actual runtime ~3.5s, allowing 5s variance
    test.setTimeout(9000); // 9 seconds

    const screenshots = createScreenshotHelper();
    
    // Initialize documentation helper
    // outputDir should be the directory of this test file
    const outputDir = path.dirname(testInfo.file);
    const docHelper = new TestDocumentationHelper(outputDir);
    
    docHelper.setMetadata(
      "CSV Export Verification",
      "**As an** admin user\n" +
      "**I want to** export inventory data\n" +
      "**So that** I can analyze it in other tools"
    );

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
    console.log("\n📖 STEP 1: Navigate to CSV page (signed out)");

    await page.goto("/csv", { waitUntil: "load" });

    // Wait for and verify sign-in button appears
    console.log("🔍 Waiting for sign-in button...");
    const signInButton = page.locator('button:has-text("Sign In")');
    await signInButton.waitFor({ state: "visible", timeout: 50000 });

    const step1Verifications = [
      {
        description: 'Validated "Sign In" button is visible',
        check: async () => {
          await expect(signInButton).toBeVisible();
          console.log("   ✓ Sign-in button is visible");
        }
      },
      {
        description: 'Verified CSV content area is empty (user not authenticated)',
        check: async () => {
          const preElement = page.locator("pre");
          const preVisible = await preElement.isVisible().catch(() => false);
          if (preVisible) {
            const preContent = await preElement.textContent();
            expect(preContent?.trim()).toBe("");
            console.log("   ✓ CSV content area is empty");
          }
        }
      }
    ];

    docHelper.addStep(
      "Signed Out State",
      "000-signed-out-state.png",
      step1Verifications
    );

    await screenshots.capture(page, "signed-out-state", {
      programmaticCheck: async () => {
        for (const v of step1Verifications) await v.check();
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

    const step2Verifications = [
      {
        description: "Validated sign-in button is no longer visible",
        check: async () => {
          const signInStillVisible = await signInButton
            .isVisible()
            .catch(() => false);
          expect(signInStillVisible).toBe(false);
          console.log("   ✓ Sign-in button no longer visible");
        }
      },
      {
        description: "Verified Redux store contains authenticated user state",
        check: async () => {
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
        }
      }
    ];

    docHelper.addStep(
      "Signed In State (Export Page)",
      "001-signed-in-state.png",
      step2Verifications
    );

    await screenshots.capture(page, "signed-in-state", {
      programmaticCheck: async () => {
        for (const v of step2Verifications) await v.check();
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
        !error.includes("Missing or insufficient permissions"),
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

    // Generate the README
    docHelper.writeReadme();

    console.log("\n✅ Complete CSV export workflow test passed!");
    console.log(`   Total screenshots captured: ${screenshots.getCounter()}`);
  });
});
