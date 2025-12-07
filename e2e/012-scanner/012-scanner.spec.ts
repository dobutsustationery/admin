import { expect, test } from "../fixtures/auth";
import { createScreenshotHelper } from "../helpers/screenshot-helper";

/**
 * E2E test for the /scanner page (Identical to root page test)
 * This is an experiment to see if sub-routes render differently than root.
 */

test.describe("Scanner Page (Duplicate of Root)", () => {
  const isTransientAuthError = (errorText: string): boolean => {
    return errorText.includes("Component auth has not been registered yet");
  };

  test("complete scanner entry workflow", async ({ page, context }) => {
    test.setTimeout(80000);

    const screenshots = createScreenshotHelper();

    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    // ====================================================================
    // STEP 1: Signed out state - user needs to sign in
    // ====================================================================
    console.log("\n📖 STEP 1: Navigate to scanner page (signed out)");

    await page.goto("/scanner", { waitUntil: "load" });

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
        const heading = page.locator("h1").first();
        const headingVisible = await heading.isVisible().catch(() => false);
        if (headingVisible) {
          const headingText = await heading.textContent();
          console.log(`   ✓ Page heading: ${headingText}`);
          expect(headingText).toContain("Inventory");
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

    // Wait for authentication to be processed - wait for sign-in button to disappear
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
      },
    });

    // ====================================================================
    // STEP 3: Wait for inventory entry form to load
    // ====================================================================
    console.log("\n📖 STEP 3: Wait for inventory entry form to load");

    // Wait for form elements to appear
    console.log("🔍 Waiting for form elements...");
    const janCodeInput = page.locator('label:has-text("JAN Code")');
    await janCodeInput.waitFor({ state: "visible", timeout: 50000 });
    console.log("   ✓ JAN Code input found");

    await screenshots.capture(page, "form-loaded", {
      programmaticCheck: async () => {
        // Verify form elements are present
        await expect(page.locator("h1")).toContainText("Inventory");
        console.log("   ✓ Page heading shows 'Inventory'");
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

    expect(significantErrors.length).toBe(0);

    console.log("\n✅ Complete scanner workflow test passed!");
    console.log(`   Total screenshots captured: ${screenshots.getCounter()}`);
  });
});
