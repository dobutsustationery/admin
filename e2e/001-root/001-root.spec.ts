import { expect, test } from "../fixtures/auth";
import { waitForAppReady } from "../helpers/loading-helper";
import { createScreenshotHelper } from "../helpers/screenshot-helper";
import { TestDocumentationHelper } from "../helpers/test-documentation-helper";
import * as path from "path";

/**
 * E2E test for the / (root/home) page
 */

test.describe("Root Page (Dashboard)", () => {
    // Helper to check if error is the known transient auth initialization error
    const isTransientAuthError = (errorText: string): boolean => {
      return errorText.includes("Component auth has not been registered yet");
    };
  
    test("complete dashboard to inventory entry workflow", async ({ page, context }, testInfo) => {
      // Set test timeout for complete workflow
      test.setTimeout(80000); 
  
      const screenshots = createScreenshotHelper();
      const outputDir = path.dirname(testInfo.file);
      const docHelper = new TestDocumentationHelper(outputDir);

      docHelper.setMetadata(
        "Dashboard Verification",
        "**As an** admin user\n" +
        "**I want to** See key metrics and navigate to tasks\n" +
        "**So that** I can efficiently manage inventory"
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
      await page.goto("/", { waitUntil: "load" });
  
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
            description: 'Validated heading is "Dobutsu Admin"',
            check: async () => {
                const heading = page.locator("h1");
                const text = await heading.textContent();
                expect(text).toContain("Dobutsu Admin");
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
  
      // Create authenticated user
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
  
      // Reload the page to apply authentication
      await page.reload({ waitUntil: "load" });
      await waitForAppReady(page);
  
      // Wait for "Dashboard" h1
      const dashboardHeading = page.locator('main h1:has-text("Dashboard")');
      await dashboardHeading.waitFor({ state: "visible", timeout: 50000 });
      
      const step2Verifications = [
        {
            description: 'Validated Dashboard heading is visible',
            check: async () => {
                 await expect(dashboardHeading).toBeVisible();
            }
        },
        {
            description: 'Validated metrics are displayed',
            check: async () => {
                 const metrics = page.locator('.metric-value').first();
                 await expect(metrics).toBeVisible();
            }
        }
      ];

      docHelper.addStep(
        "Dashboard Loaded",
        "001-dashboard-loaded.png",
        step2Verifications
      );

      await screenshots.capture(page, "dashboard-loaded", {
        programmaticCheck: async () => {
             for (const v of step2Verifications) await v.check();
        }
      });
  
      // ====================================================================
      // STEP 3: Navigate to Inventory Entry
      // ====================================================================
      
      const addInventoryLink = page.locator('a[href="/entry"]');
      await addInventoryLink.first().click();
      
      // Wait for form elements to appear
      const janCodeInput = page.locator('label:has-text("JAN Code")');
      await janCodeInput.waitFor({ state: "visible", timeout: 50000 });
  
      const step3Verifications = [
        {
            description: 'Validated JAN Code input is visible',
            check: async () => {
                 await expect(janCodeInput).toBeVisible();
            }
        },
        {
            description: 'Validated URL is /entry',
            check: async () => {
                 expect(page.url()).toContain("/entry");
            }
        }
      ];

      docHelper.addStep(
        "Inventory Entry Form",
        "002-entry-form-loaded.png",
        step3Verifications
      );

      await screenshots.capture(page, "entry-form-loaded", {
        programmaticCheck: async () => {
            for (const v of step3Verifications) await v.check();
        },
      });
  
      // ====================================================================
      // Final verification: No significant console errors
      // ====================================================================
  
      // Filter out transient auth initialization errors and image loading errors
      const significantErrors = consoleErrors.filter(
        (error) =>
          !isTransientAuthError(error) &&
          !error.includes("ERR_NAME_NOT_RESOLVED") &&
          !error.includes("Failed to load resource") &&
          !error.includes("CustomSearch API") &&
          !error.includes("Could not reach Cloud Firestore backend"),
      );
  
      // Verify no significant console errors
      expect(significantErrors.length).toBe(0);
  
      console.log("\n✅ Complete dashboard navigation workflow test passed!");
      console.log(`   Total screenshots captured: ${screenshots.getCounter()}`);

      docHelper.writeReadme();
    });
  });
