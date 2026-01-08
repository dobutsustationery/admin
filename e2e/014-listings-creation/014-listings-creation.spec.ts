import { test, expect } from '../fixtures/auth';
import { createScreenshotHelper } from "../helpers/screenshot-helper";
import { TestDocumentationHelper } from "../helpers/test-documentation-helper";
import * as path from "path";

test.describe('Listings Creation Flow', () => {
    test('User can propose and approve a listing', async ({ authenticatedPage: page }, testInfo) => {
        test.setTimeout(60000);
        const screenshots = createScreenshotHelper();
        const docHelper = new TestDocumentationHelper(path.dirname(testInfo.file));

        docHelper.setMetadata(
            "Listings Creation Verification",
            "**As a** merchant\n**I want to** semi-automatically create listings from inventory photos\n**So that** I can list products faster and reduce manual data entry."
        );

        // 1. Setup: Inject Mock Data
        await page.goto('/'); 
        
        // Wait for store to be ready
        await page.waitForFunction(() => (window as any).testHelpers);
        
        // 2. Navigate to Listings Creation
        page.on('console', (msg) => console.log(`BROWSER LOG: ${msg.text()}`));
        await page.goto('/listings/create');
        
        // 3. Scan/Generate
        await expect(page.locator('h1')).toContainText('Create Listings', { timeout: 10000 });
        
        const initialVerifications = [{
             description: 'Validated header is visible',
             check: async () => {
                await expect(page.locator('h1')).toContainText('Create Listings');
             }
        }];

        docHelper.addStep("Initial State", "000-initial-state.png", initialVerifications);
         await screenshots.capture(page, "initial-state", {
            programmaticCheck: async () => {
                for (const v of initialVerifications) await v.check();
            }
        });

        // Move injection here to ensure hydration is done
        await page.evaluate(() => {
            const { store, actions } = (window as any).testHelpers;
            const janCode = "TEST999999";
            
            // Inject Item
            store.dispatch(actions.bulk_import_items({
                items: [{
                    id: "item1",
                    item: {
                        janCode,
                        description: "Test Product For Listing",
                        qty: 10,
                        shipped: 0,
                        handle: "",
                        subtype: ""
                    },
                    type: 'new'
                }]
            }));
            
            // Inject Photo
            store.dispatch({
                type: 'photos/categorize_photo', 
                payload: {
                    janCode,
                    photo: {
                        id: "photo1",
                        baseUrl: "https://via.placeholder.com/150",
                        filename: "test.jpg"
                    }
                }
            });
        });

        await page.click('button:has-text("Scan for new items")');
        
        // 4. Start Batch
        const draftsReadyVerifications = [{
            description: 'Validated drafts are ready',
            check: async () => {
                 await expect(page.locator('h2')).toContainText('1 Drafts Ready');
            }
       }];
       docHelper.addStep("Drafts Ready", "001-drafts-ready.png", draftsReadyVerifications);
       await screenshots.capture(page, "drafts-ready", {
           programmaticCheck: async () => {
            for (const v of draftsReadyVerifications) await v.check();
           }
       });

        await page.click('button:has-text("Start Batch")');
        
        // 5. Review Proposal (Now on Listing Detail)
        // Verify Rewrite to Detail Page - Check for UI element instead of strict URL
        await expect(page.getByText("Back to Batch")).toBeVisible({ timeout: 10000 });
        
        const reviewVerifications = [{
            description: 'Validated redirected to listing detail with draft title',
            check: async () => {
                 // ListingEditor uses h1 checking text content
                 await expect(page.locator('h1')).toContainText('[DRAFT] Test Product For Listing');
            }
       }];
       docHelper.addStep("Review Proposal", "002-review-proposal.png", reviewVerifications);
       await screenshots.capture(page, "review-proposal", {
           programmaticCheck: async () => {
             for (const v of reviewVerifications) await v.check();
           }
       });

        // Edit title - ContentEditable
        // Playwright .fill() works on contenteditable
        await page.locator('h1').fill('Final Product Title');
        await page.keyboard.press('Tab'); // Trigger blur to ensure event handlers fire
        
        const editVerifications = [{
            description: 'Validated edited title',
            check: async () => {
                 await expect(page.locator('h1')).toHaveText('Final Product Title');
            }
       }];
       docHelper.addStep("Edited Proposal", "003-edited-proposal.png", editVerifications);
       await screenshots.capture(page, "edited-proposal", {
           programmaticCheck: async () => {
             for (const v of editVerifications) await v.check();
           }
       });

        // 6. Approve
        await page.getByRole('button', { name: "Approve & Publish" }).click({ force: true });
        
        // 7. Verify Completion
        // Should redirect back to /listings/create
        await expect(page).toHaveURL(/listings\/create/);
        
        // When batch is complete and no more drafts, UI shows empty state
        const completionVerifications = [{
            description: 'Validated batch complete and empty state',
            check: async () => {
                 await expect(page.locator('h2')).toContainText('No proposals found'); 
            }
       }];
       docHelper.addStep("Batch Complete", "004-batch-complete.png", completionVerifications);
       await screenshots.capture(page, "batch-complete", {
           programmaticCheck: async () => {
              for (const v of completionVerifications) await v.check();
           }
       });

       docHelper.writeReadme();
    });
});
