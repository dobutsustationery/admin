import { test, expect } from '../fixtures/auth';
import { createScreenshotHelper } from '../helpers/screenshot-helper';
import { TestDocumentationHelper } from '../helpers/test-documentation-helper';
import * as path from 'path';

test.describe('Audit Log', () => {
  const isTransientAuthError = (errorText: string): boolean => {
    return errorText.includes('Component auth has not been registered yet');
  };

  test('complete audit log workflow', async ({ authenticatedPage: page }, testInfo) => {
    test.setTimeout(60000);
    
    const screenshots = createScreenshotHelper();
    const outputDir = path.dirname(testInfo.file);
    const docHelper = new TestDocumentationHelper(outputDir);

    docHelper.setMetadata(
      "Audit Log Verification",
      "**As an** admin user\n" +
      "**I want to** view and filter the history of actions\n" +
      "**So that** I can audit system usage and debug issues"
    );

    const consoleErrors: string[] = [];
    page.on('console', (msg: any) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // ====================================================================
    // STEP 1: Navigate to Audit Log
    // ====================================================================
    console.log('Navigating to root...');
    await page.goto('/', { waitUntil: 'load' });
    
    console.log('Waiting for Dashboard...');
    const dashboardHeader = page.locator('h1:has-text("Dashboard")');
    await dashboardHeader.waitFor({ state: 'visible', timeout: 30000 });
    
    console.log('Clicking Audit Log link...');
    await page.getByRole('link', { name: 'Audit Log' }).click();
    await expect(page).toHaveURL(/.*\/audit/);
    
    const auditHeader = page.getByRole('heading', { name: 'Audit Log' });
    await expect(auditHeader).toBeVisible();
    await expect(page.getByRole('button', { name: 'Day' })).toHaveClass(/active/);

    const step1Verifications = [
      {
        description: 'Validated Audit Log page loaded',
        check: async () => {
          await expect(auditHeader).toBeVisible();
        }
      },
      {
        description: 'Validated "Day" view is active by default',
        check: async () => {
          await expect(page.getByRole('button', { name: 'Day' })).toHaveClass(/active/);
        }
      }
    ];

    docHelper.addStep(
        "Initial Audit View",
        "001-audit-initial-view.png",
        step1Verifications
    );

    await screenshots.capture(page, "audit-initial-view", {
        programmaticCheck: async () => {
            for (const v of step1Verifications) await v.check();
        }
    });

    // ====================================================================
    // STEP 2: Switch View Mode and Filter
    // ====================================================================
    console.log('Switching to Month view...');
    await page.getByRole('button', { name: 'Month' }).click();
    await expect(page.getByRole('button', { name: 'Month' })).toHaveClass(/active/);
    
    const dateNavSpan = page.locator('.date-nav span');
    await expect(dateNavSpan).toBeVisible();
    const initialText = await dateNavSpan.innerText();
    expect(initialText).toBeTruthy();

    // Verify date navigation buttons work (visually we verify the text changes)
    await page.locator('.date-nav button').first().click(); // Back
    await expect(dateNavSpan).not.toHaveText(initialText);

    const step2Verifications = [
      {
        description: 'Validated "Month" view is active',
        check: async () => {
          await expect(page.getByRole('button', { name: 'Month' })).toHaveClass(/active/);
        }
      },
      {
        description: 'Validated Date Range text updated after navigation',
        check: async () => {
           await expect(dateNavSpan).not.toHaveText(initialText);
        }
      }
    ];

    docHelper.addStep(
        "Filtered View",
        "002-audit-filtered-view.png",
        step2Verifications
    );

    await screenshots.capture(page, "audit-filtered-view", {
        programmaticCheck: async () => {
            for (const v of step2Verifications) await v.check();
        }
    });

    // ====================================================================
    // STEP 3: Expand JSON (If actions exist)
    // ====================================================================
    const cards = page.locator('.action-card');
    const count = await cards.count();
    console.log(`Found ${count} action cards.`);
    
    if (count > 0) {
        await cards.first().click();
        const jsonPre = page.locator('.action-body pre');
        await expect(jsonPre).toBeVisible();
        
        const step3Verifications = [
            {
                description: 'Validated Action JSON is visible on expand',
                check: async () => {
                    await expect(jsonPre).toBeVisible();
                }
            }
        ];

        docHelper.addStep(
            "Action Details",
            "003-audit-action-details.png",
            step3Verifications
        );

        await screenshots.capture(page, "audit-action-details", {
            programmaticCheck: async () => {
                for (const v of step3Verifications) await v.check();
            }
        });
    } else {
        console.log("No actions found to expand, skipping Details step.");
        docHelper.addStep(
            "Empty State",
            "003-audit-empty-state.png",
            [{ description: "Verified empty state (no cards)", check: async () => { expect(count).toBe(0); } }]
        );
        await screenshots.capture(page, "audit-empty-state");
    }

    // ====================================================================
    // FINAL: Write Documentation
    // ====================================================================
    docHelper.writeReadme();
    
    // Filter console errors
    const significantErrors = consoleErrors.filter(
        (error) => !isTransientAuthError(error)
    );
    expect(significantErrors.length).toBe(0);
  });
});
