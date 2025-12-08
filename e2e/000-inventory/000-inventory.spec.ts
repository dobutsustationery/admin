import { expect, test } from "../fixtures/auth";
import { waitForAppReady } from "../helpers/loading-helper";
import { createScreenshotHelper } from "../helpers/screenshot-helper";
import { TestDocumentationHelper } from "../helpers/test-documentation-helper";
import * as path from "path";

/**
 * E2E test for the /inventory page
 */

test.describe("Inventory Page", () => {
    const isTransientAuthError = (errorText: string): boolean => {
      return errorText.includes("Component auth has not been registered yet");
    };
  
    test("complete inventory workflow", async ({ page, context }, testInfo) => {
      test.setTimeout(20000); 
  
      const screenshots = createScreenshotHelper();
      const outputDir = path.dirname(testInfo.file);
      const docHelper = new TestDocumentationHelper(outputDir);

      docHelper.setMetadata(
        "Inventory View Verification",
        "**As an** admin user\n" +
        "**I want to** view the inventory list\n" +
        "**So that** I can track stock levels"
      );
  
      const consoleErrors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") {
             consoleErrors.push(msg.text());
        }
      });
  
      // ====================================================================
      // STEP 1: Signed out state
      // ====================================================================
      await page.goto("/inventory", { waitUntil: "load" });
  
      console.log("🔍 Waiting for sign-in button...");
      const signInButton = page.locator('button:has-text("Sign In")');
      await signInButton.waitFor({ state: "visible", timeout: 15000 });

      const step1Verifications = [
        {
            description: 'Validated "Sign In" button is visible',
            check: async () => {
                 await expect(signInButton).toBeVisible();
            }
        },
        {
            description: 'Validated inventory table is NOT visible',
            check: async () => {
                const inventoryTable = page.locator("table");
                const tableVisible = await inventoryTable.isVisible().catch(() => false);
                expect(tableVisible).toBe(false);
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
      // STEP 2: Sign in
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
  
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForAppReady(page);
  
      console.log("🔍 Waiting for inventory table (proof of successful authentication)...");
      const inventoryTable = page.locator("table");
      await inventoryTable.waitFor({ state: "visible", timeout: 30000 });
  
      const step2Verifications = [
        {
            description: 'Validated "Sign In" button is no longer visible',
            check: async () => {
                const signInStillVisible = await signInButton.isVisible().catch(() => false);
                expect(signInStillVisible).toBe(false);
            }
        },
        {
            description: 'Validated inventory table is visible',
            check: async () => {
                 await expect(inventoryTable).toBeVisible();
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
      // STEP 3: Inventory Data Loaded
      // ====================================================================
      
      console.log("🔍 Waiting for inventory data rows...");
      await page.waitForFunction(
        () => {
          const allRows = document.querySelectorAll("table tr");
          const headerRows = document.querySelectorAll("table thead tr");
          return allRows.length > headerRows.length;
        },
        { timeout: 60000 },
      );
  
      const step3Verifications = [
        {
            description: 'Validated table headers include "JAN Code" and "Quantity"',
            check: async () => {
                const headers = await page.locator("table thead th").allTextContents();
                expect(headers.join(" ")).toContain("JAN Code");
                expect(headers.join(" ")).toContain("Quantity");
            }
        },
        {
            description: 'Validated inventory data rows are present',
            check: async () => {
                const allRows = await page.locator("table tr").count();
                const headerRows = await page.locator("table thead tr").count();
                const finalRowCount = allRows - headerRows;
                expect(finalRowCount).toBeGreaterThan(0);
            }
        },
        {
            description: 'Validated Redux store has inventory state',
            check: async () => {
                const inventoryState = await page.evaluate(() => {
                    try {
                      const store = (window as any).__REDUX_STORE__;
                      if (store) {
                        const state = store.getState();
                        return { hasInventory: !!state.inventory, itemCount: state.inventory?.items?.length || 0 };
                      }
                      return null;
                    } catch (e) { return null; }
                  });
                  if (inventoryState) expect(inventoryState.hasInventory).toBe(true);
            }
        }
      ];

      docHelper.addStep(
        "Inventory Data Loaded",
        "002-inventory-loaded.png",
        step3Verifications
      );

      await screenshots.capture(page, "inventory-loaded", {
        programmaticCheck: async () => {
            for (const v of step3Verifications) await v.check();
        },
      });
  
      // ====================================================================
      // Final verification
      // ====================================================================
      const significantErrors = consoleErrors.filter(
        (error) =>
          !isTransientAuthError(error) &&
          !error.includes("ERR_NAME_NOT_RESOLVED") &&
          !error.includes("Failed to load resource") &&
          !error.includes("Could not reach Cloud Firestore backend"),
      );
  
      expect(significantErrors.length).toBe(0);
      docHelper.writeReadme();
    });
  });
