
import { expect, test } from "../fixtures/auth";
import { waitForAppReady } from "../helpers/loading-helper";
import { createScreenshotHelper } from "../helpers/screenshot-helper";
import { TestDocumentationHelper } from "../helpers/test-documentation-helper";
import * as path from "path";

/**
 * E2E test for the /order-import page with Google Drive integration
 */

test.describe("Order Import Page with Google Drive", () => {
    const isTransientAuthError = (errorText: string): boolean => {
        return errorText.includes("Component auth has not been registered yet");
    };

    const isExpectedTestEnvironmentError = (errorText: string): boolean => {
        return (
            errorText.includes("ERR_NAME_NOT_RESOLVED") ||
            errorText.includes("Failed to load resource") ||
            (errorText.includes("googleapis.com") && errorText.includes("Failed to load")) ||
            errorText.includes("Could not reach Cloud Firestore backend")
        );
    };

    test("complete Order Import workflow", async ({ page }, testInfo) => {
        test.setTimeout(60000);
        const screenshots = createScreenshotHelper();
        const outputDir = path.dirname(testInfo.file);
        const docHelper = new TestDocumentationHelper(outputDir);

        docHelper.setMetadata(
            "Order Import Verification",
            "**As an** admin user\n" +
            "**I want to** import orders from Google Drive CSV\n" +
            "**So that** I can fulfill them"
        );

        const consoleErrors: string[] = [];
        page.on("console", (msg) => {
            if (msg.type() === "error") {
                consoleErrors.push(msg.text());
            }
        });

        // MOCK DRIVE API
        await page.route('**/*googleapis.com/**', async (route) => {
            const url = route.request().url();
            const method = route.request().method();

             if (method === 'OPTIONS') {
                await route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } });
                return;
            }

            if (url.includes('/drive/v3/files')) {
                // List files
                if (method === 'GET' && !url.includes('alt=media')) {
                    await route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        headers: { 'Access-Control-Allow-Origin': '*' },
                        body: JSON.stringify({
                            files: [
                                {
                                    id: 'mock-order-file-123',
                                    name: 'orders-2025.csv',
                                    mimeType: 'text/csv',
                                    modifiedTime: '2025-12-01T12:00:00.000Z',
                                    size: '1024',
                                    webViewLink: 'https://drive.google.com/file/d/mock-order-file-123/view'
                                }
                            ]
                        })
                    });
                    return;
                }
                // Download file
                if (method === 'GET' && url.includes('alt=media')) {
                     await route.fulfill({
                        status: 200,
                        contentType: 'text/csv',
                        headers: { 'Access-Control-Allow-Origin': '*' },
                        body: "JAN CODE,TOTAL PCS,DESCRIPTION,Carton Number\n4902778123456,10,Test Item,1"
                    });
                    return;
                }
            }
            await route.continue();
        });

        // 1. Authenticate
        const authEmulatorUrl = "http://localhost:9099";
        const testEmail = `test-${Date.now()}@example.com`;
        const testPassword = "testpassword123";

        // 2. Go to page (to establish origin for localStorage)
        await page.goto("/order-import", { waitUntil: "load" });

        const authResponse = await page.request.post(
            `${authEmulatorUrl}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key`,
            { data: { email: testEmail, password: testPassword, displayName: "Test User", returnSecureToken: true } }
        );
        
        if (!authResponse.ok()) {
            console.log("TEST FAILURE: Failed to create user", await authResponse.text());
            throw new Error(`Failed to create user: ${authResponse.status()}`);
        }

        const authData = await authResponse.json();
        console.log("TEST DEBUG: Created user with localId:", authData.localId);

        // Listen for console logs
        page.on('console', msg => console.log(`BROWSER CONSOLE: ${msg.type()}: ${msg.text()}`));
        page.on('pageerror', err => console.log(`BROWSER ERROR: ${err.message}`));

        // Mock Drive Config persistence
        await page.addInitScript(() => {
            (window as any).__MOCK_DRIVE_CONFIG__ = true;
        });
        
        // Go to home first to get a context
        await page.goto("/");

         await page.evaluate((authInfo) => {
            const authKey = "firebase:authUser:demo-api-key:[DEFAULT]";
            localStorage.setItem(authKey, JSON.stringify({
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
                        photoURL: null
                    }
                ],
                stsTokenManager: { 
                    refreshToken: authInfo.refreshToken,
                    accessToken: authInfo.idToken, 
                    expirationTime: Date.now() + 3600000 
                },
                createdAt: String(Date.now()),
                lastLoginAt: String(Date.now()),
                apiKey: "demo-api-key",
                appName: "[DEFAULT]"
            }));
             // Mock Drive Token
             localStorage.setItem('google_drive_access_token', JSON.stringify({
                access_token: 'mock-access-token',
                expires_in: 3600,
                expires_at: Date.now() + 3600000,
                scope: 'https://www.googleapis.com/auth/drive.file',
                token_type: 'Bearer'
             }));
              localStorage.setItem('__TEST_DRIVE_CONFIGURED__', 'true');
        }, authData);

        // Verify injection
        const injected = await page.evaluate(() => localStorage.getItem("firebase:authUser:demo-api-key:[DEFAULT]"));
        console.log("TEST DEBUG: Injected auth token length:", injected?.length);

        // Navigate to target page which triggers clean load with localStorage already set
        await page.goto("/order-import");
        
        // Wait for loading to finish
        // We expect .loading-overlay (from LoadingScreen.svelte) to disappear
        try {
            await expect(page.locator('.loading-overlay')).toBeHidden({ timeout: 15000 });
        } catch (e) {
            console.log("TEST DEBUG: Loading overlay did not disappear.");
            const bodyHtml = await page.content();
            console.log("TEST DEBUG: Full Body HTML:", bodyHtml);
            throw e;
        }
        
        // Debugging logs
        console.log(`TEST DEBUG: Current URL: ${page.url()}`);

        // 1. Check if we passed Layout Auth
        try {
            await expect(page.locator('h1:has-text("Inventory Receipt (Drive)")')).toBeVisible({ timeout: 5000 });
        } catch (e) {
            console.log("TEST FAILURE: Header not found.");
             const bodyHtml = await page.content();
             console.log("TEST DEBUG: Full Body HTML on failure:", bodyHtml);
             throw e;
        }

        // 2. Check configuration state
        const notConfigured = await page.locator('text=Drive not configured').isVisible();
        if (notConfigured) {
             console.log("TEST FAILURE: Drive is reported as not configured");
             // Force check window prop
             const windowConfig = await page.evaluate(() => (window as any).__MOCK_DRIVE_CONFIG__);
             console.log("TEST DEBUG: window.__MOCK_DRIVE_CONFIG__ is", windowConfig);
        }

        // 3. Check auth state
        const connectBtn = await page.locator('button:has-text("Connect to Google Drive")').isVisible();
        if (connectBtn) {
            console.log("TEST FAILURE: App thinks we are not authenticated with Drive");
             const storedToken = await page.evaluate(() => localStorage.getItem('google_drive_access_token'));
             console.log("TEST DEBUG: localStorage token is", storedToken);
        }

        // 3a. Check for Signin
        const signinHeader = await page.locator('h1:has-text("Dobutsu Admin")').isVisible();
        if (signinHeader) console.log("TEST DEBUG: Found 'Dobutsu Admin' header (Signin page)");

        const loadingMsg = await page.locator('text=Initializing authentication').isVisible();
        if (loadingMsg) console.log("TEST DEBUG: Found 'Initializing authentication' message");

        const loadingScreen = await page.locator('.loading-screen').isVisible();
        if (loadingScreen) console.log("TEST DEBUG: Found .loading-screen");

        // 3. Verify Page Loaded and Connected (Fail here if not found)
        await expect(page.locator('text=Connected to Drive')).toBeVisible({ timeout: 5000 });
        await expect(page.locator('text=orders-2025.csv')).toBeVisible();

        const step1 = [{ description: "Page loaded with files", check: async () => await expect(page.locator('text=orders-2025.csv')).toBeVisible() }];
        docHelper.addStep("View Files", "001-view-files.png", step1);
        await screenshots.capture(page, "view-files", { programmaticCheck: async () => { for(const v of step1) await v.check(); } });

        // 4. Analyze
        const analyzeBtn = page.locator('button:has-text("Analyze")');
        await expect(analyzeBtn).toBeVisible();
        await expect(analyzeBtn).toBeEnabled();
        await analyzeBtn.click();

        // 5. Preview
        await expect(page.locator('h3:has-text("Preview: orders-2025.csv")')).toBeVisible();
        await expect(page.locator('text=4902778123456')).toBeVisible(); // JAN Code check
        await expect(page.locator('text=Test Item')).toBeVisible(); // Description check
        
        const step2 = [{ description: "Preview loaded", check: async () => await expect(page.locator('h3:has-text("Preview: orders-2025.csv")')).toBeVisible() }];
        docHelper.addStep("Preview Loaded", "002-preview.png", step2);
        await screenshots.capture(page, "preview", { programmaticCheck: async () => { for(const v of step2) await v.check(); } });

        // 6. Confirm Import
        // Handle confirm dialog
        page.on('dialog', dialog => dialog.accept());
        
        const confirmBtn = page.locator('button:has-text("Confirm Receipt")');
        await expect(confirmBtn).toBeVisible();
        await expect(confirmBtn).toBeEnabled();
        await confirmBtn.click();

        // 7. Verify Success Message (or Error)
        await page.waitForTimeout(2000); // Wait for processing

        const successEl = page.locator('.success-message');
        const errorEl = page.locator('.error-message');
        
        try {
            // Check if either success or error is visible without throwing immediately
            await expect(successEl.or(errorEl).first()).toBeVisible({ timeout: 10000 });
            
            if (await successEl.isVisible()) {
                const text = await successEl.innerText();
                console.log(`TEST DEBUG: Found success message: "${text}"`);
                expect(text).toContain("Successfully processed");
            } else if (await errorEl.isVisible()) {
                const text = await errorEl.innerText();
                console.log(`TEST FAILURE: Found error message: "${text}"`);
                throw new Error(`Import failed with message: ${text}`);
            }
        } catch (e) {
            console.log("TEST FAILURE: Neither success nor error message found.");
             const bodyHtml = await page.content();
             console.log("TEST DEBUG: Full Body HTML on failure:", bodyHtml);
             throw e;
        }

        const step3 = [{ description: "Import succesful", check: async () => await expect(page.locator('.success-message')).toContainText("Successfully processed") }];
        docHelper.addStep("Import Complete", "003-import-complete.png", step3);
        await screenshots.capture(page, "import-complete", { programmaticCheck: async () => { for(const v of step3) await v.check(); } });
        
        docHelper.writeReadme();
    });
});
