
import { expect, test } from "../fixtures/auth";
import { request } from "@playwright/test";

// ... existing imports ...
import { waitForAppReady } from "../helpers/loading-helper";
import { createScreenshotHelper } from "../helpers/screenshot-helper";
import { TestDocumentationHelper } from "../helpers/test-documentation-helper";
import { FlowHelper } from "../helpers/flow-helper";
import * as path from "path";
import { execSync } from "child_process";

/**
 * E2E test for the /order-import page with Google Drive integration
 */

test.describe("Inventory Receipt with Google Drive", () => {

    test.beforeAll(async () => {
        console.log("TEST SETUP: Seeding Test Data...");
        try {
            // 1. Standard Data Load (Clean Base) - MATCHING GLOBAL SETUP
            execSync("node e2e/helpers/load-test-data-with-local-images.js --match-jancodes=10", { stdio: 'inherit' });
            
            // 2. Inject Conflict: Create a duplicate item via Emulator REST API
            // JAN: 4510085530713 (Exists in export, we add a second variant)
            const apiContext = await request.newContext({ baseURL: 'http://localhost:8080' });
            
            // Create a second "update_item" event for the same JAN to simulate a conflict
            await apiContext.post('/emulator/v1/projects/demo-test-project/databases/(default)/documents/broadcast', {
                data: {
                    fields: {
                        type: { stringValue: "update_item" },
                        timestamp: { timestampValue: new Date().toISOString() },
                        creator: { stringValue: "test_conflict_injector" },
                        payload: {
                            mapValue: {
                                fields: {
                                    id: { stringValue: "4510085530713-duplicate" }, // Unique ID, same JAN
                                    item: {
                                        mapValue: {
                                            fields: {
                                                janCode: { stringValue: "4510085530713" },
                                                subtype: { stringValue: "VariantB" },
                                                description: { stringValue: "Conflict Variant Injected" },
                                                qty: { integerValue: "5" },
                                                pieces: { integerValue: "1" },
                                                shipped: { integerValue: "0" },
                                                creationDate: { stringValue: new Date().toISOString() },
                                                hsCode: { stringValue: "" },
                                                image: { stringValue: "" }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            });
            await apiContext.dispose();
            
            console.log("TEST SETUP: Data Seeded & Conflict Injected Successfully.");
        } catch (error) {
            console.error("TEST SETUP ERROR: Failed to seed data.", error);
            throw error;
        }
    });

    test.afterAll(() => {
        console.log("TEST TEARDOWN: Restoring Standard Test Data...");
        try {
            // Restore standard dataset (MATCHING GLOBAL SETUP)
            execSync("node e2e/helpers/load-test-data-with-local-images.js --match-jancodes=10", { stdio: 'inherit' });
            console.log("TEST TEARDOWN: Standard Data Restored Successfully.");
        } catch (error) {
            console.error("TEST TEARDOWN ERROR: Failed to restore data.", error);
            // Don't throw here to ensure test result is preserved
        }
    });

    test("complete Inventory Receipt workflow (Match, Conflict, New)", async ({ page, authenticatedPage }, testInfo) => {
        // --- Setup Helpers ---
        const outputDir = path.dirname(testInfo.file);
        const screenshots = createScreenshotHelper();
        const docHelper = new TestDocumentationHelper(outputDir);
        const flow = new FlowHelper(page, screenshots, docHelper);

        docHelper.setMetadata(
            "Inventory Receipt Verification",
            "**As an** admin user\n" +
            "**I want to** import inventory from CSV receipts\n" +
            "**So that** I can update stock quantities, create draft items, and resolve subtype allocations."
        );

        // --- Mock Data ---
        // Mock CSV Content using Standard JANs
        // 4542804044355: Existing Item (from export)
        // 4510085530713: Conflict Item (from export + injected duplicate)
        const MOCK_CSV = 
`JAN CODE,TOTAL PCS,DESCRIPTION,Carton Number
4542804044355,10,Design Paper Square Astronomy,1
1010101010101,5,New Mystery Item,2
4510085530713,30,Stickers Urusei and Yatsura,3`;

        // --- Mock Drive API ---
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
                                    id: 'mock-receipt-file-123',
                                    name: 'receipt-2025.csv',
                                    mimeType: 'text/csv',
                                    modifiedTime: '2025-12-10T12:00:00.000Z',
                                    size: '1024',
                                    webViewLink: 'https://drive.google.com/file/d/mock/view'
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
                        body: MOCK_CSV
                    });
                    return;
                }
            }
            await route.continue();
        });
        
        // Inject Drive Token
        await authenticatedPage.addInitScript(() => {
            (window as any).__MOCK_DRIVE_CONFIG__ = true;
            localStorage.setItem('google_drive_access_token', JSON.stringify({
                access_token: 'mock-access-token',
                expires_in: 3600,
                expires_at: Date.now() + 3600000,
                scope: 'https://www.googleapis.com/auth/drive.file',
                token_type: 'Bearer'
            }));
        });
        
        authenticatedPage.on('console', msg => console.log(`BROWSER LOG: ${msg.text()}`));
        
        // --- 2. View Files ---
        // Navigate to target page
        await page.goto("/order-import");
        
        // Wait for loading to finish (Auth state resolution)
        try {
            await expect(page.locator('.loading-overlay')).toBeHidden({ timeout: 15000 });
        } catch (e) {
            console.log("TEST DEBUG: Loading overlay did not disappear.");
            throw e;
        }

        // Verify we are on the correct page (Authenticated)
        await expect(page.locator('h1:has-text("Inventory Receipt (Drive)")')).toBeVisible({ timeout: 10000 });

        await flow.step("View File List", "view-files", [
            { 
                description: "App should be connected to Drive", 
                check: async () => await expect(page.locator('text=Connected to Drive')).toBeVisible() 
            },
            { 
                description: "CSV file should be listed", 
                check: async () => await expect(page.locator('text=receipt-2025.csv')).toBeVisible() 
            }
        ]);

        // --- 3. Analyze & Preview ---
        // Verify preview panel exists
        await expect(page.locator('.preview-panel')).toBeVisible();

        // New flow: Select file first
        await page.locator('.file-list button').first().click();
        
        // Verify button gets selected class
        await expect(page.locator('.file-list button').first()).toHaveClass(/selected/);
        
        // Verify placeholder disappears
        await expect(page.locator('.placeholder')).toBeHidden();
        
        // Then click Analyze File in the panel
        const analyzeBtn = page.locator('button:has-text("Analyze File")');
        await expect(analyzeBtn).toBeVisible();
        await analyzeBtn.click();

        // 3a. Verify Preview Content
        await flow.step("Verify Preview", "verify-preview", [
            {
                description: "Preview Header Visible",
                check: async () => await expect(page.locator('h2:has-text("Preview: receipt-2025.csv")')).toBeVisible()
            },
            {
                description: "Batch Actions Visible",
                check: async () => {
                   await expect(page.locator('button:has-text("Process Matches")')).toBeVisible();
                   await expect(page.locator('button:has-text("Create New")')).toBeVisible();
                }
            },
            {
                description: "Row 1: New Item (6666...)",
                check: async () => {
                    await expect(page.locator('tr:has-text("1010101010101")')).toBeVisible({ timeout: 10000 });
                    await expect(page.locator('tr:has-text("1010101010101")')).toContainText('NEW');
                }
            },
            {
                description: "Row 2: Existing or Conflict",
                check: async () => {
                    // Conflict item
                    await expect(page.locator('tr:has-text("4510085530713")')).toContainText('CONFLICT');
                }
            },
            {
                description: "Row 3: Existing Pen (490...)",
                check: async () => {
                     // Should be MATCH
                     await expect(page.locator('tr:has-text("4542804044355")')).toContainText('MATCH');
                }
            }
        ]);

        // Analysis Preview block (Legacy) removed.

        // --- 4. Interactive Resolution ---
        
        // 4.1 Process Matches
        await flow.step("Process Matches", "process-matches", [
            {
                description: "Click Match Button",
                check: async () => {
                    await page.click('button:has-text("Process Matches")');
                    await expect(page.locator('.success-message')).toBeVisible();
                    // Verify Match item (490...) is DONE
                    await expect(page.locator('tr:has-text("4542804044355")').locator('td:last-child')).toContainText("Done");
                }
            }
        ]);

        // 4.2 Process New
        await flow.step("Process New Items", "process-new", [
             {
                description: "Click Create New Button",
                check: async () => {
                    await page.click('button:has-text("Create New")');
                    await expect(page.locator('.success-message')).toBeVisible();
                    // Verify New item is Done
                    await expect(page.locator('tr:has-text("New Mystery Item")').locator('td:last-child')).toContainText("Done");
                }
            }
        ]);

        // 4.3 Open Conflict Modal
        await flow.step("Open Conflict Modal", "004-conflict-modal-v2", [
            {
                description: "Open Review Modal",
                check: async () => {
                    const row = page.locator('tr:has-text("4510085530713")');
                    await expect(row).toContainText('CONFLICT');
                    // Click Review IN THE ACTION COLUMN
                    await row.locator('button:has-text("Review")').click();
                    
                    // Modal should appear
                    await expect(page.locator('.modal')).toBeVisible();
                    await expect(page.locator('.modal h3')).toContainText('Resolve Conflict');
                    
                    // Verify Even Split Defaults (30 qty / 2 items = 15 each)
                    // We expect 2 inputs, both with value 15.
                    const inputs = page.locator('.modal input[type="number"]');
                    await expect(inputs).toHaveCount(2);
                    await expect(inputs.nth(0)).toHaveValue('15');
                    await expect(inputs.nth(1)).toHaveValue('15');
                }
            }
        ]);

        // 4.4 Confirm Resolution
        await flow.step("Confirm Conflict Resolution", "005-conflict-resolved", [
             {
                description: "Confirm Split",
                check: async () => {
                    // Click Confirm
                    await page.click('button:has-text("Confirm Split")');
                    
                    // Modal closed
                    await expect(page.locator('.modal')).not.toBeVisible();
                    
                    // Row status should be RESOLVED
                    await expect(page.locator('tr:has-text("4510085530713")')).toContainText('RESOLVED');
                     // And "Ready" in action column
                    await expect(page.locator('tr:has-text("4510085530713")').locator('td:last-child')).toContainText("Ready");
                }
             }
        ]);

        // 4.5 Process Resolved
        await flow.step("Process Resolved", "006-process-resolved", [
            {
                description: "Click Process Resolved button",
                check: async () => {
                    await page.click('button:has-text("Process Resolved")');
                    await expect(page.locator('.success-message')).toBeVisible();
                    await expect(page.locator('tr:has-text("4510085530713")').locator('td:last-child')).toContainText("Done");
                }
            },
            {
                description: "Success message displayed",
                check: async () => await expect(page.locator('.success-message')).toContainText("Successfully processed")
            }
        ]);
        
        docHelper.writeReadme();
    });
});

