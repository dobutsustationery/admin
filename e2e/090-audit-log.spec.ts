
import { test, expect } from './fixtures/auth';

test.describe('Audit Log', () => {
  test('should navigate to audit log and display actions', async ({ authenticatedPage: page }) => {
    test.setTimeout(60000);
    console.log('Navigating to root...');
    await page.goto('/', { waitUntil: 'load' });
    
    console.log('Waiting for Dashboard...');
    const dashboardHeader = page.locator('h1:has-text("Dashboard")');
    await dashboardHeader.waitFor({ state: "visible", timeout: 30000 });
    console.log('Dashboard visible.');

    // Check navigation
    console.log('Clicking Audit Log link...');
    await page.getByRole('link', { name: 'Audit Log' }).click();
    await expect(page).toHaveURL(/.*\/audit/);
    await expect(page.getByRole('heading', { name: 'Audit Log' })).toBeVisible();

    // Check default view controls
    await expect(page.getByRole('button', { name: 'Day' })).toHaveClass(/active/);
    
    // Switch to Month view
    console.log('Switching to Month view...');
    await page.getByRole('button', { name: 'Month' }).click();
    await expect(page.getByRole('button', { name: 'Month' })).toHaveClass(/active/);

    // Verify date range text is present
    const dateRangeText = await page.locator('.date-nav span').innerText();
    expect(dateRangeText).toBeTruthy();

     // Check interaction with card if present (conditional)
    const cards = page.locator('.action-card');
    const count = await cards.count();
    console.log(`Found ${count} action cards.`);
    if (count > 0) {
        await cards.first().click();
        await expect(page.locator('.action-body pre')).toBeVisible();
    }
  });

  test('should date filtering controls work', async ({ authenticatedPage: page }) => {
    await page.goto('/audit');
    
    // Ensure we are on the page
    await expect(page.getByRole('heading', { name: 'Audit Log' })).toBeVisible();

    const dateNavSpan = page.locator('.date-nav span');
    await expect(dateNavSpan).toBeVisible();
    const initialText = await dateNavSpan.innerText();
    
    // Go back
    await page.locator('.date-nav button').first().click();
    await expect(dateNavSpan).not.toHaveText(initialText);
    
    // Go forward
    await page.locator('.date-nav button').last().click();
    await expect(dateNavSpan).toHaveText(initialText);
  });
});
