import { expect, test } from "../fixtures/auth";
import { waitForAppReady } from "../helpers/loading-helper";
import { createScreenshotHelper } from "../helpers/screenshot-helper";
import { TestDocumentationHelper } from "../helpers/test-documentation-helper";
import * as path from "path";

/**
 * E2E test for the / (root) page, which is now the Dashboard
 */

test.describe("Root Page (Dashboard)", () => {
  const isTransientAuthError = (errorText: string): boolean => {
    return errorText.includes("Component auth has not been registered yet");
  };

  test("complete dashboard loading workflow", async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(80000);

    const screenshots = createScreenshotHelper();
    const outputDir = path.dirname(testInfo.file);
    const docHelper = new TestDocumentationHelper(outputDir);

    docHelper.setMetadata(
      "Dashboard Verification",
      "**As an** admin user\n" +
        "**I want to** see an overview of key metrics and quick actions at the root\n" +
        "**So that** I can navigate to the right section efficiently",
    );

    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    // ====================================================================
    // STEP 1: Signed Out
    // ====================================================================
    await page.goto("/", { waitUntil: "load" });

    const signInButton = page.locator('button:has-text("Sign In")');
    await signInButton.waitFor({ state: "visible", timeout: 50000 });

    const step1Verifications = [
      {
        description: 'Validated "Sign In" button is visible',
        check: async () => {
          await expect(signInButton).toBeVisible();
        },
      },
      {
        description: 'Validated heading contains "Dobutsu Admin"',
        check: async () => {
          const heading = page.locator("h1");
          await expect(heading).toContainText("Dobutsu Admin");
        },
      },
    ];

    docHelper.addStep(
      "Signed Out State",
      "000-signed-out-state.png",
      step1Verifications,
    );

    await screenshots.capture(page, "signed-out-state", {
      programmaticCheck: async () => {
        for (const v of step1Verifications) await v.check();
      },
    });

    // ====================================================================
    // STEP 2: Sign In
    // ====================================================================
    const authEmulatorUrl =
      process.env.E2E_AUTH_EMULATOR_URL || "http://127.0.0.1:9099";
    const testEmail = `test-${Date.now()}@example.com`;
    const testPassword = "testpassword123";

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

    await page.reload({ waitUntil: "load" });
    await waitForAppReady(page);

    // Wait for authentication to be processed
    await signInButton
      .waitFor({ state: "hidden", timeout: 20000 })
      .catch(() =>
        console.log(
          "Sign-in button still visible, might be intentional if redirect failed",
        ),
      );

    // Wait for Dashboard specific elements
    const dashboardHeader = page.locator('h1:has-text("Dashboard")');
    await dashboardHeader.waitFor({ state: "visible", timeout: 50000 });

    const step2Verifications = [
      {
        description: 'Validated heading contains "Dashboard"',
        check: async () => {
          await expect(dashboardHeader).toBeVisible();
        },
      },
      {
        description: "Validated Quick Actions are visible",
        check: async () => {
          const quickActions = page.locator(".quick-actions");
          await expect(quickActions).toBeVisible();
        },
      },
      {
        description: "Validated Metrics Grid is visible",
        check: async () => {
          const metrics = page.locator(".metrics-grid");
          await expect(metrics).toBeVisible();
        },
      },
    ];

    docHelper.addStep(
      "Dashboard Loaded",
      "001-dashboard-loaded.png",
      step2Verifications,
    );

    await screenshots.capture(page, "dashboard-loaded", {
      programmaticCheck: async () => {
        for (const v of step2Verifications) await v.check();
      },
    });

    // Filter out transient auth errors
    const significantErrors = consoleErrors.filter(
      (error) =>
        !isTransientAuthError(error) &&
        !error.includes("ERR_NAME_NOT_RESOLVED") &&
        !error.includes("Failed to load resource") &&
        !error.includes("CustomSearch API") &&
        !error.includes("Could not reach Cloud Firestore backend"),
    );

    expect(significantErrors.length).toBe(0);
    docHelper.writeReadme();
  });
});
