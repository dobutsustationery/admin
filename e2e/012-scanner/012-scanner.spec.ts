import { expect, test } from "../fixtures/auth";
import { waitForAppReady } from "../helpers/loading-helper";
import { createScreenshotHelper } from "../helpers/screenshot-helper";
import { TestDocumentationHelper } from "../helpers/test-documentation-helper";
import * as path from "path";

/**
 * E2E test for the /scanner page
 */

test.describe("Scanner Page", () => {
    const isTransientAuthError = (errorText: string): boolean => {
      return errorText.includes("Component auth has not been registered yet");
    };
  
    test("complete scanner verification", async ({ page, context }, testInfo) => {
      test.setTimeout(80000); 
  
      const screenshots = createScreenshotHelper();
      const outputDir = path.dirname(testInfo.file);
      const docHelper = new TestDocumentationHelper(outputDir);
  
      docHelper.setMetadata(
        "Scanner Verification",
        "**As an** admin user\n" +
        "**I want to** Access the inventory scanner\n" +
        "**So that** I can add items using my barcode scanner"
      );
  
      const consoleErrors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") {
             consoleErrors.push(msg.text());
        }
      });
  
      // ====================================================================
      // STEP 1: Sign In & Navigate
      // ====================================================================
      // We can use the generic navigate-after-login pattern or just go direct
      await page.goto("/scanner", { waitUntil: "load" });
  
      const signInButton = page.locator('button:has-text("Sign In")'); 
      await signInButton.waitFor({ state: "visible", timeout: 50000 });
  
      const authEmulatorUrl = "http://localhost:9099";
      const testEmail = `test-${Date.now()}@example.com`;
      const testPassword = "testpassword123";
  
      const authResponse = await page.request.post(
        `${authEmulatorUrl}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key`,
        {
          data: {
            email: testEmail,
            password: testPassword,
            displayName: "Scanner User",
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
            displayName: "Scanner User",
            isAnonymous: false,
            photoURL: null,
            providerData: [
              {
                providerId: "password",
                uid: authInfo.localId,
                displayName: "Scanner User",
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
  
      // Reload on scanner page
      await page.reload({ waitUntil: "load" });
      await waitForAppReady(page);
  
      // Wait for authentication to be processed
      await signInButton
        .waitFor({ state: "hidden", timeout: 20000 })
        .catch(() => console.log("Sign-in button check timeout - proceeding"));

      // Wait for Scanner specific element
      const janLabel = page.locator('label:has-text("JAN Code:")');
      await janLabel.waitFor({ state: "visible", timeout: 50000 });
      
      const verifications = [
        {
            description: 'Validated heading contains "Inventory"',
            check: async () => {
                const heading = page.locator("h1");
                await expect(heading).toContainText("Inventory");
            }
        },
        {
            description: 'Validated JAN Code input is visible',
            check: async () => {
                 await expect(janLabel).toBeVisible();
            }
        }
      ];
  
      docHelper.addStep(
        "Scanner Loaded",
        "012-scanner-loaded.png",
        verifications
      );
  
      await screenshots.capture(page, "scanner-loaded", {
        programmaticCheck: async () => {
             for (const v of verifications) await v.check();
        }
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
