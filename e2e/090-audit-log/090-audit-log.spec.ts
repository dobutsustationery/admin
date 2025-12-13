import { test, expect } from '../fixtures/auth';
import { request } from '@playwright/test';
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

        // Create action via REST API (Bypass UI flakiness)
        const apiContext = await request.newContext({ baseURL: 'http://localhost:8080' });
        const uniqueId = `action-${Date.now()}`;
        console.log(`Injecting action with ID: ${uniqueId}`);
        
        // Use a fixed date to avoid timezone issues with "Today"
        const fixedDate = '2024-01-15T12:00:00.000Z';
        // Exact structure from 013-order-import.spec.ts for reference
        // Note: Removing /emulator prefix which seems to cause 404
        const response = await apiContext.post('/v1/projects/demo-test-project/databases/(default)/documents/broadcast', {
            data: {
                fields: {
                    type: { stringValue: "update_field" },
                    timestamp: { timestampValue: fixedDate },
                    creator: { stringValue: "test_audit_injector" },
                    payload: {
                        mapValue: {
                            fields: {
                                id: { stringValue: "4542804113693" },
                                field: { stringValue: "description" },
                                from: { stringValue: "Original" },
                                to: { stringValue: "Injected Update" },
                                // Add item map to be safe if helper expects it (though getAuditActionDescription handles missing item)
                                item: { 
                                    mapValue: {
                                        fields: {
                                            janCode: { stringValue: "4542804113693" },
                                            description: { stringValue: "Injected Update" }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });

        if (!response.ok()) {
            console.error('FAILED TO POST DATA:', await response.text());
        } else {
            const result = await response.json();
            console.log('Injection successful, created doc:', result.name);
        }

        await apiContext.dispose();

        // Wait for broadcast/update
        await page.waitForTimeout(2000); 

        // 3. Navigate to Audit Log
        console.log('Navigating to Audit Log...');
        await page.goto('/audit');
        await expect(page.getByRole('heading', { name: 'Audit Log' })).toBeVisible();

        // 4. Switch to Day view and Set Date to 2024-01-15
        console.log("Setting date to 2024-01-15...");
        await page.getByRole('button', { name: 'Day' }).click();
        
        // Wait for inputs to be interactive
        const startInput = page.getByLabel('Start Date');
        await expect(startInput).toBeVisible();
        await startInput.fill('2024-01-15');
        // Trigger change
        await startInput.dispatchEvent('change');
        
        // 5. Verify Actions Load
        console.log('Waiting for actions...');
        
        // Poll for actions
        await expect.poll(async () => {
             const count = await page.locator('.action-card').count();
             console.log(`Found ${count} action cards...`);
             return count;
        }, {
            timeout: 30000,
            message: 'Waiting for action cards to appear'
        }).toBeGreaterThan(0);

        // We look for the updated item text. Action type is 'update_field', so description contains "for item {jan}"
        const actionItem = page.locator('.action-card').filter({ hasText: '4542804113693' }).first();
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
                    await expect(actionItem).toContainText('Updated Description');
                    await expect(actionItem).toContainText('Injected Update');
                    await expect(actionItem).toContainText('4542804113693');
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

        // 6. Expand Action
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
                    expect(text).toContain('4542804113693');
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
