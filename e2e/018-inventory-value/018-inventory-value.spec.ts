import { expect, test } from "../fixtures/auth";
import { waitForAppReady } from "../helpers/loading-helper";
import { createScreenshotHelper } from "../helpers/screenshot-helper";
import { TestDocumentationHelper } from "../helpers/test-documentation-helper";
import * as path from "path";

test.describe("Inventory Value Page", () => {
  const isTransientAuthError = (errorText: string): boolean =>
    errorText.includes("Component auth has not been registered yet");

  // Pre-existing reducer replay noise from legacy/test data appended to
  // the shared broadcast log by EARLIER suites (publish-subtype repro,
  // live-event-import, ...). 018 runs last so it replays the most state;
  // these console.errors come from the inventory reducer replaying that
  // data, NOT from the inventory-value page (standalone 018 is clean).
  // See docs/investigations/REPLAY_CONSOLE_ERRORS.md.
  const isReplayValidationNoise = (errorText: string): boolean =>
    errorText.includes("[InventoryValidation] Item update ID mismatch!") ||
    errorText.includes("Cannot split missing item:");

  test("inventory value report workflow", async ({ page }, testInfo) => {
    test.setTimeout(15000);

    const screenshots = createScreenshotHelper();
    const outputDir = path.dirname(testInfo.file);
    const docHelper = new TestDocumentationHelper(outputDir);

    docHelper.setMetadata(
      "Inventory Value Report",
      "**As an** admin/accountant\n" +
        "**I want to** see inventory value at each period end and stock order\n" +
        "**So that** I can report inventory value over time",
    );

    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    // ================================================================
    // STEP 1: Signed Out
    // ================================================================
    await page.goto("/inventory-value", { waitUntil: "load" });

    const signInButton = page.locator('button:has-text("Sign In")');
    await signInButton.waitFor({ state: "visible", timeout: 50000 });

    const step1 = [
      {
        description: 'Validated "Sign In" button is visible',
        check: async () => {
          await expect(signInButton).toBeVisible();
        },
      },
    ];
    docHelper.addStep("Signed Out State", "000-signed-out-state.png", step1);
    await screenshots.capture(page, "signed-out-state", {
      programmaticCheck: async () => {
        for (const v of step1) await v.check();
      },
    });

    // ================================================================
    // STEP 2: Sign In
    // ================================================================
    const authEmulatorUrl =
      process.env.E2E_AUTH_EMULATOR_URL || "http://localhost:9099";
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
    await signInButton.waitFor({ state: "hidden", timeout: 50000 });

    const step2 = [
      {
        description: 'Validated "Sign In" button is hidden',
        check: async () => {
          await expect(signInButton).toBeHidden();
        },
      },
    ];
    docHelper.addStep("Signed In State", "001-signed-in-state.png", step2);
    await screenshots.capture(page, "signed-in-state", {
      programmaticCheck: async () => {
        for (const v of step2) await v.check();
      },
    });

    // ================================================================
    // STEP 3: Report Loaded
    // ================================================================
    const heading = page.locator("main h1").first();
    await heading.waitFor({ state: "visible", timeout: 50000 });

    const step3 = [
      {
        description: 'Validated heading is "Inventory Value"',
        check: async () => {
          await expect(heading).toContainText("Inventory Value");
        },
      },
      {
        description: "Validated report table or empty state is shown",
        check: async () => {
          const table = page.locator("main table");
          const empty = page.locator("main .empty");
          const hasTable = await table.isVisible().catch(() => false);
          const hasEmpty = await empty.isVisible().catch(() => false);
          expect(hasTable || hasEmpty).toBe(true);
          if (hasTable) {
            const headers = await table
              .locator("thead th")
              .allTextContents();
            expect(headers).toContain("Date");
            expect(headers).toContain("Value (EUR)");
          }
        },
      },
      {
        description: 'Validated "Copy as TSV" export control exists',
        check: async () => {
          await expect(
            page.locator('button:has-text("Copy as TSV")'),
          ).toBeVisible();
        },
      },
    ];
    docHelper.addStep("Report Loaded", "002-report-loaded.png", step3);
    await screenshots.capture(page, "report-loaded", {
      programmaticCheck: async () => {
        for (const v of step3) await v.check();
      },
    });

    const significantErrors = consoleErrors.filter(
      (error) =>
        !isTransientAuthError(error) &&
        !isReplayValidationNoise(error) &&
        !error.includes("ERR_NAME_NOT_RESOLVED") &&
        !error.includes("Failed to load resource"),
    );
    expect(significantErrors, significantErrors.join("\n---\n")).toEqual([]);
    docHelper.writeReadme();
  });
});
