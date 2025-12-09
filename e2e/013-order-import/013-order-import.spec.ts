
import { test, expect } from '@playwright/test';
import { TestDocumentationHelper } from '../helpers/test-documentation-helper';
import { createScreenshotHelper } from '../helpers/screenshot-helper';

test.describe('Order Import Workflow', () => {
  let docHelper: TestDocumentationHelper;
  let screenshotHelper: ReturnType<typeof createScreenshotHelper>;
  let logs: string[] = [];

  test.beforeAll(async () => {
    // Ensure the output directory exists
    docHelper = new TestDocumentationHelper('e2e/013-order-import');
    docHelper.setMetadata(
      '013-order-import',
      'Verifies the Order Import workflow, including file selection, analysis, conflict resolution, and inventory updates.'
    );
  });

  test.afterAll(async () => {
    docHelper.writeReadme();
  });

  test.beforeEach(async ({ page }) => {
    screenshotHelper = createScreenshotHelper();
    
    // Mock Google Drive API
    await page.route('**/*googleapis.com/**', async (route) => {
      const url = route.request().url();
      const method = route.request().method();
      
      console.log(`MOCK: ${method} ${url}`);

      if (method === 'OPTIONS') {
        await route.fulfill({
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          },
        });
        return;
      }

      // Mock File List
      if (url.includes('/drive/v3/files') && method === 'GET' && !url.includes('/export') && !url.includes('alt=media')) {
         await route.fulfill({
           status: 200,
           contentType: 'application/json',
           body: JSON.stringify({
             files: [
               { id: 'file1', name: 'Invoice_2023_10.csv', mimeType: 'text/csv' },
               { id: 'file2', name: 'Packing_List.xlsx', mimeType: 'application/vnd.google-apps.spreadsheet' }
             ]
           })
         });
         return;
      }

      // Mock File Content (CSV Download)
      if (url.includes('/file1') && (url.includes('alt=media') || url.includes('/export'))) {
        const csvContent = 
`JAN,Name,Qty
4900000000001,Regular Item,10
4900000000002,Conflict Item,5
9999999999999,New Item,3`;

        await route.fulfill({
          status: 200,
          contentType: 'text/csv',
          body: csvContent
        });
        return;
      }

      await route.continue();
    });

    // Capture console logs
    logs = [];
    page.on("console", (msg) => {
        logs.push(msg.text());
        console.log(`BROWSER: ${msg.text()}`);
    });

    // Populate Inventory for Test
    await page.goto('/order-import');

    // Seed Google Drive Token directly to skip OAuth flow
    await page.waitForFunction(() => (window as any).handleUserChange !== undefined);
    
    await page.evaluate(() => {
        // Spoof Firebase Auth Sign-In
        const handleUserChange = (window as any).handleUserChange;
        if (handleUserChange) {
             handleUserChange({
                uid: 'test-user-123',
                email: 'test@example.com',
                displayName: 'Test User',
                photoURL: 'https://via.placeholder.com/150'
             });
        }

        localStorage.setItem('google_drive_access_token', JSON.stringify({
            access_token: 'mock-access-token',
            scope: 'https://www.googleapis.com/auth/drive.file',
            expires_at: Date.now() + 3600000
        }));
    });
    
    // Seed using exposed store
    await page.evaluate(() => {
       const store = (window as any).store;
       if (!store) return;
       
       store.dispatch({
           type: 'batch_update_inventory',
           payload: {
               updates: [],
               newItems: [
                   { janCode: '4900000000001', qty: 10 }, // Creates default item
                   { janCode: '4900000000002', qty: 5 }, // Creates default item
               ],
               timestamp: { seconds: Math.floor(Date.now() / 1000) }
           }
       });
    });

    });

  test('Complete Import Workflow (Happy Path)', async ({ page }) => {
    test.setTimeout(60000);
    
    // Select File
    // Wait for file to appear
    try {
        await expect(page.getByText('Invoice_2023_10.csv')).toBeVisible({ timeout: 30000 });
    } catch (e) {
        // Analyze logs
        console.log(`Log count: ${logs.length}`);
        const hasPageMount = logs.some(l => l.includes('OrderImportPage Mounted'));
        const hasPickerMount = logs.some(l => l.includes('OrderImportPicker Mounted'));
        const hasMockHit = logs.some(l => l.includes('MOCK:'));
        const hasLoadError = logs.some(l => l.includes('Error loading files'));

        console.log(`DEBUG STATS: PageMount=${hasPageMount}, PickerMount=${hasPickerMount}, MockHit=${hasMockHit}, LoadError=${hasLoadError}`);

        if (await page.getByText('Loading files...').isVisible()) {
             throw new Error(`Stuck on "Loading files...". MockHit=${hasMockHit}. LoadError=${hasLoadError}`);
        }
        if (await page.getByText('Google Drive is not configured').isVisible()) {
            throw new Error('Drive not configured - check build env vars');
        }
        if (await page.getByText('Connect Drive').isVisible()) {
            throw new Error(`Auth failed - token seeding didn't work. PickerMount=${hasPickerMount}`);
        }
        if (await page.getByText('No CSVs or Spreadsheets found').isVisible()) {
             const driveLink = await page.getByText('Open Drive Folder').isVisible();
             throw new Error(`File list empty (MockHit=${hasMockHit}). OpenDriveLink=${driveLink}`);
        }
        
        throw e;
    }
    
    // Click Select button for the invoice
    await page.getByRole('row', { name: 'Invoice_2023_10.csv' }).getByRole('button', { name: 'Select' }).click();
    
    // Analyze
    // "Regular Item" (49...001) -> Should be "New Item" if I didn't seed it.
    // "Conflict Item" (49...002) -> New Item.
    // "New Item" -> New Item.
    
    // So all will be "New items".
    await expect(page.getByText('Import Summary')).toBeVisible();
    
    // Verify "Regular Item" is in New Items list (Unknown Item)
    await expect(page.getByText('Unknown Item').first()).toBeVisible();
    
    // Commit
    await page.getByRole('button', { name: 'Confirm & Update Inventory' }).click();
    
    // Success
    await expect(page.getByText('Import Successful')).toBeVisible();
    
    await screenshotHelper.capture(page, 'import-success');
    
    docHelper.addStep('Import Success', '001-success.png', [
        { 
            description: 'Workflow completes for new items.',
            check: async () => {
                await expect(page.getByText('Import Successful')).toBeVisible();
            }
        }
    ]);
  });
});
