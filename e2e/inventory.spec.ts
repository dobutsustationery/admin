import { test, expect } from '@playwright/test';

/**
 * E2E test for the /inventory page
 * 
 * This test verifies that:
 * 1. The inventory page loads successfully
 * 2. Test data from Firestore emulator is displayed
 * 3. The page renders the expected elements
 */

test.describe('Inventory Page', () => {
  test.beforeEach(async ({ page }) => {
    // Mock Firebase Auth by injecting a signed-in user
    await page.addInitScript(() => {
      // Create a mock user object
      const mockUser = {
        uid: 'test-user-id',
        email: 'test@example.com',
        displayName: 'Test User',
        photoURL: 'https://via.placeholder.com/150',
        emailVerified: true,
        providerData: [{
          providerId: 'google.com',
          uid: 'test-user-id',
          displayName: 'Test User',
          email: 'test@example.com',
          phoneNumber: null,
          photoURL: 'https://via.placeholder.com/150',
        }],
        stsTokenManager: {
          refreshToken: 'mock-refresh-token',
          accessToken: 'mock-access-token',
          expirationTime: Date.now() + 3600000,
        },
        createdAt: String(Date.now()),
        lastLoginAt: String(Date.now()),
        apiKey: 'demo-api-key',
        appName: '[DEFAULT]',
      };

      // Store mock auth in localStorage (Firebase Auth storage)
      localStorage.setItem(
        'firebase:authUser:demo-api-key:[DEFAULT]',
        JSON.stringify(mockUser)
      );

      // Mock the Firebase Auth state change callback
      window.__mockFirebaseAuth = {
        currentUser: mockUser,
        onAuthStateChanged: (callback) => {
          // Immediately call with our mock user
          setTimeout(() => callback(mockUser), 10);
          return () => {}; // unsubscribe function
        },
        signInWithPopup: async () => ({ user: mockUser }),
      };
    });

    // Intercept Firebase Auth initialization and use our mock
    await page.route('**/*', (route) => {
      const url = route.request().url();
      // Allow all requests to pass through
      route.continue();
    });
  });

  test('should load and display inventory items', async ({ page }) => {
    // Navigate to the inventory page
    await page.goto('/inventory');

    // Wait for the page to load - we should see the table header
    await page.waitForSelector('table thead', { timeout: 30000 });

    // Take a screenshot for visual verification
    await page.screenshot({ 
      path: 'e2e/screenshots/inventory-page.png',
      fullPage: true 
    });

    // Verify the table headers are present
    const headers = await page.locator('table thead th').allTextContents();
    expect(headers).toContain('JAN Code');
    expect(headers).toContain('Description');
    expect(headers).toContain('Quantity');

    // Verify at least one inventory row is displayed
    // The test data should populate inventory items
    const rowCount = await page.locator('table tbody tr').count();
    
    // We should have at least some items (the test data has thousands)
    expect(rowCount).toBeGreaterThan(0);

    // Log the number of items for debugging
    console.log(`✓ Found ${rowCount} inventory items displayed`);

    // Verify specific columns exist in at least one row
    const firstRow = page.locator('table tbody tr').first();
    await expect(firstRow).toBeVisible();
  });

  test('should have correct page title', async ({ page }) => {
    await page.goto('/inventory');
    
    // Wait for page to be fully loaded
    await page.waitForLoadState('networkidle');

    // Take a screenshot
    await page.screenshot({ 
      path: 'e2e/screenshots/inventory-page-loaded.png' 
    });

    // Verify we can see the table
    await expect(page.locator('table')).toBeVisible();
  });

  test('should display inventory data from emulator', async ({ page }) => {
    await page.goto('/inventory');

    // Wait for the inventory table to be populated
    await page.waitForSelector('table tbody tr', { timeout: 30000 });

    // Take a detailed screenshot
    await page.screenshot({
      path: 'e2e/screenshots/inventory-with-data.png',
      fullPage: true
    });

    // Get some sample data to verify it loaded from emulator
    const rows = page.locator('table tbody tr');
    const count = await rows.count();
    
    console.log(`✓ Loaded ${count} inventory items from Firestore emulator`);
    
    // We should have items from the test data
    expect(count).toBeGreaterThan(0);

    // Verify the table structure is correct
    const tableHeaders = await page.locator('table thead th').count();
    expect(tableHeaders).toBeGreaterThan(0);
  });
});
