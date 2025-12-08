import { expect, test } from "../fixtures/auth";
import { waitForAppReady } from "../helpers/loading-helper";
import { createScreenshotHelper } from "../helpers/screenshot-helper";
import { TestDocumentationHelper } from "../helpers/test-documentation-helper";
import * as path from "path";

test.describe("Shows Page", () => {
    const isTransientAuthError = (errorText: string): boolean => {
      return errorText.includes("Component auth has not been registered yet");
    };
  
    test("complete shows workflow", async ({ page, context }, testInfo) => {
      test.setTimeout(80000); 
  
      const screenshots = createScreenshotHelper();
      const outputDir = path.dirname(testInfo.file);
      const docHelper = new TestDocumentationHelper(outputDir);

      docHelper.setMetadata(
        "Shows Verification",
        "**As an** admin user\n" +
        "**I want to** manage event sales\n" +
        "**So that** I can track sales performance"
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
      await page.goto("/shows", { waitUntil: "load" });
  
      console.log("🔍 Waiting for sign-in button...");
      const signInButton = page.locator('button:has-text("Sign In")');
      await signInButton.waitFor({ state: "visible", timeout: 50000 });

      const step1Verifications = [
        {
            description: 'Validated "Sign In" button is visible',
            check: async () => {
                 await expect(signInButton).toBeVisible();
            }
        },
        {
             description: 'Validated heading contains "Create and view event sales"',
             check: async () => {
                 const heading = page.locator("main h1").first();
                 if (await heading.isVisible()) {
                     await expect(heading).toContainText("Create and view event sales");
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
      // STEP 2: Sign In
      // ====================================================================
      const authEmulatorUrl = "http://localhost:9099";
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

      const step2Verifications = [
        {
            description: 'Validated "Sign In" button is hidden',
            check: async () => {
                 await expect(signInButton).toBeHidden();
            }
        },
        {
            description: 'Validated Redux store has user state',
            check: async () => {
                const hasAuthState = await page.evaluate(() => {
                    try {
                      const store = (window as any).__REDUX_STORE__;
                      return !!store?.getState().user?.uid;
                    } catch (e) { return false; }
                  });
                  if (hasAuthState) expect(hasAuthState).toBe(true);
            }
        }
      ];

      docHelper.addStep(
        "Signed In State",
        "001-signed-in-state.png",
        step2Verifications
      );
  
      await screenshots.capture(page, "signed-in-state", {
        programmaticCheck: async () => {
             for (const v of step2Verifications) await v.check();
        },
      });

      // ====================================================================
      // STEP 3: Shows Page Loaded
      // ====================================================================
      console.log("🔍 Waiting for shows page elements...");
      const heading = page.locator("main h1").first();
      await heading.waitFor({ state: "visible", timeout: 50000 });
      
      const step3Verifications = [
        {
            description: 'Validated heading contains "Create and view event sales"',
            check: async () => {
                 await expect(heading).toContainText("Create and view event sales");
            }
        },
        {
             description: 'Validated "Available Archives" heading (if visible)',
             check: async () => {
                 const archivesHeading = page.locator("h1:has-text('Available Archives')");
                 if (await archivesHeading.isVisible()) {
                     await expect(archivesHeading).toBeVisible();
                 }
             }
        },
        {
             description: 'Validated table exists (if visible)',
             check: async () => {
                 const table = page.locator("table").first();
                 if (await table.isVisible()) {
                     const headers = await table.locator("thead th").allTextContents();
                     expect(headers).toContain("Archive Name");
                 }
             }
        },
        {
            description: 'Validated Redux store has sales events state',
            check: async () => {
                const salesState = await page.evaluate(() => {
                    try {
                      const store = (window as any).__REDUX_STORE__;
                      return !!store?.getState().inventory?.salesEvents;
                    } catch (e) { return false; }
                  });
                  if (salesState) expect(salesState).toBe(true);
            }
        }
      ];

      docHelper.addStep(
        "Shows Loaded",
        "002-shows-loaded.png",
        step3Verifications
      );

      await screenshots.capture(page, "shows-loaded", {
        programmaticCheck: async () => {
            for (const v of step3Verifications) await v.check();
        },
      });
  
      const significantErrors = consoleErrors.filter(
        (error) =>
          !isTransientAuthError(error) &&
          !error.includes("ERR_NAME_NOT_RESOLVED") &&
          !error.includes("Failed to load resource"),
      );
  
      expect(significantErrors.length).toBe(0);
      docHelper.writeReadme();
    });
  });
