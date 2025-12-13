import { test, expect } from '../fixtures/auth';
import { createScreenshotHelper } from '../helpers/screenshot-helper';
import { TestDocumentationHelper } from '../helpers/test-documentation-helper';
import * as path from 'path';

test.describe('Audit Log', () => {
    test.use({ locale: 'en-GB' }); // Try GB to force slashes (dd/mm/yyyy) which matches CI visually for 2024-10-10
    
    test('audit log rich data verification', async ({ authenticatedPage: page }, testInfo) => {
        test.setTimeout(90000);

        const screenshots = createScreenshotHelper();
        const outputDir = path.dirname(testInfo.file);
        const docHelper = new TestDocumentationHelper(outputDir);

        docHelper.setMetadata(
            "Audit Log Rich Data",
            "Verify audit log displays correctly for a known date (2024-10-10) with multiple actions, featuring human-readable descriptions."
        );

        // 1. Navigate to Audit Log
        console.log('Navigating to Audit Log...');
        await page.goto('/audit');
        await expect(page.getByRole('heading', { name: 'Audit Log' })).toBeVisible();

        // 2. Switch to Day view
        await page.getByRole('button', { name: 'Day' }).click();
        await expect(page.getByRole('button', { name: 'Day' })).toHaveClass(/active/);

        // 3. Set date to 2024-10-10
        console.log('Setting date to 2024-10-10...');
        const startDateInput = page.getByLabel('Start Date');
        await expect(startDateInput).toBeVisible();
        await startDateInput.fill('2024-10-10');
        // Trigger change event if fill doesn't (Playwright fill usually does, but sometimes needs explicit dispatch if using on:change)
        // Actually fill triggers input/change.
        
        // 4. Verify Actions Load
        console.log('Waiting for actions...');
        // We look for the specific Action we know exists: "Updated item 4542804044355"
        // Based on my helper, it should output: "Updated item 4542804044355"
        const actionItem = page.locator('.action-card', { hasText: 'Updated item 4542804044355' }).first();
        await expect(actionItem).toBeVisible({ timeout: 10000 });

        const step1Verifications = [
            {
                description: 'Validated specific action is visible',
                check: async () => {
                    await expect(actionItem).toBeVisible();
                }
            },
            {
                description: 'Validated human-readable description matches',
                check: async () => {
                    await expect(actionItem).toContainText("Updated item 4542804044355");
                }
            }
        ];

        docHelper.addStep(
            "Rich Data View",
            "000-audit-rich-data.png",
            step1Verifications
        );

        await screenshots.capture(page, "audit-rich-data", {
            programmaticCheck: async () => {
                for (const v of step1Verifications) await v.check();
            },
            mask: [page.locator('input[type="date"]')] // Mask date inputs to avoid CI/Local locale rendering differences
        });

        // 5. Expand Action
        console.log('Expanding action...');
        await actionItem.locator('.action-header').click();
        const jsonPre = actionItem.locator('.action-body pre');
        await expect(jsonPre).toBeVisible();

        const step2Verifications = [
            {
                description: 'Validated expanded JSON details',
                check: async () => {
                    await expect(jsonPre).toBeVisible();
                    const text = await jsonPre.innerText();
                    expect(text).toContain("4542804044355");
                }
            }
        ];

        docHelper.addStep(
            "Action Details",
            "001-audit-action-details.png",
            step2Verifications
        );

        await screenshots.capture(page, "audit-action-details", {
            programmaticCheck: async () => {
                for (const v of step2Verifications) await v.check();
            }
        });

        docHelper.writeReadme();
    });
});
