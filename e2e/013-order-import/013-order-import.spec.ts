
import { expect, test } from "../fixtures/auth";
import { waitForAppReady } from "../helpers/loading-helper";
import { createScreenshotHelper } from "../helpers/screenshot-helper";
import { TestDocumentationHelper } from "../helpers/test-documentation-helper";
import { FlowHelper } from "../helpers/flow-helper";
import * as path from "path";

/**
 * E2E test for the /order-import page with Google Drive integration
 * 
 * Verifies:
 * 1. File Listing (Drive API)
 * 2. Analysis Logic (Match, Conflict, New)
 * 3. Import Execution (Redux actions)
 */

test.describe("Inventory Receipt with Google Drive", () => {

    test("complete Inventory Receipt workflow (Match, Conflict, New)", async ({ page, authenticatedPage }, testInfo) => {
        test.setTimeout(60000);
        
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
        // Mock CSV Content
        const MOCK_CSV = 
`JAN CODE,TOTAL PCS,DESCRIPTION,Carton Number
4902778123456,10,Existing Pen,1
7777777777777,5,New Mystery Item,2
4542804104370,20,Conflict Item,3`;

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

        // --- 1. Additional Setup ---
        // Inject Drive Token and Config (Auth is handled by authenticatedPage fixture)
        // We use addInitScript to ensure they are present on reload/nav
        await page.addInitScript(() => { 
            (window as any).__MOCK_DRIVE_CONFIG__ = true; 
             localStorage.setItem('google_drive_access_token', JSON.stringify({
                access_token: 'mock-access-token',
                expires_in: 3600,
                expires_at: Date.now() + 3600000,
                scope: 'https://www.googleapis.com/auth/drive.file',
                token_type: 'Bearer'
             }));
             localStorage.setItem('__TEST_DRIVE_CONFIGURED__', 'true');
        });
        
        // Seed Conflict Data step removed.
        
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
                description: "Row 1: New Item (7777...)",
                check: async () => await expect(page.locator('tr:has-text("7777777777777")')).toContainText('NEW') 
            },
            {
                description: "Row 2: Existing or Conflict",
                check: async () => {
                    // Conflict item
                    await expect(page.locator('tr:has-text("4542804104370")')).toContainText('CONFLICT');
                }
            },
            {
                description: "Row 3: Existing Pen (490...)",
                check: async () => {
                     // Should be MATCH
                     await expect(page.locator('tr:has-text("4902778123456")')).toContainText('MATCH');
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
                    await expect(page.locator('tr:has-text("4902778123456")').locator('td:last-child')).toContainText("Done");
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

        // 4.3 Resolve Conflict
        await flow.step("Resolve Conflict", "resolve-conflict", [
            {
                description: "Resolve Conflict",
                check: async () => {
                    const row = page.locator('tr:has-text("4542804104370")');
                    await expect(row).toContainText('CONFLICT');
                    // Click Review IN THE ACTION COLUMN
                    await row.locator('button:has-text("Review")').click();
                    
                    // Modal should appear
                    await expect(page.locator('.modal')).toBeVisible();
                    await expect(page.locator('.modal h3')).toContainText('Resolve Conflict');
                    
                    // Fill inputs
                    // We expect 2 variant rows.
                    // Total qty is 20 (from CSV) (Line 42 of mock CSV)
                    // We split 10 and 10? Or 20 and 0.
                    // Let's resolve to 20 on first variant.
                    await page.locator('.modal input[type="number"]').first().fill('20');
                    
                    // Click Confirm
                    await page.click('button:has-text("Confirm Split")');
                    
                    // Modal closed
                    await expect(page.locator('.modal')).not.toBeVisible();
                    
                    // Row status should be RESOLVED
                    await expect(page.locator('tr:has-text("4542804104370")')).toContainText('RESOLVED');
                     // And "Ready" in action column
                    await expect(page.locator('tr:has-text("4542804104370")').locator('td:last-child')).toContainText("Ready");
                }
            }
        ]);
        
        // 4.4 Process Resolved
        await flow.step("Process Resolved", "process-resolved", [
             {
                description: "Click Process Resolved button",
                check: async () => {
                    await page.click('button:has-text("Process Resolved")');
                    await expect(page.locator('.success-message')).toBeVisible();
                }
            },
            {
                description: "Verify Conflict item is Done",
                 check: async () => {
                    await expect(page.locator('tr:has-text("4542804104370")').locator('td:last-child')).toContainText("Done");
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

