import { test, expect } from '@playwright/test';
import { waitForAppReady } from './helpers/loading-helper';

async function injectAuth(page: any, authInfo: any) {
    await page.evaluate((authInfo: any) => {
        const authKey = "firebase:authUser:demo-api-key:[DEFAULT]";
        localStorage.setItem(
          authKey,
          JSON.stringify({
            uid: authInfo.localId,
            email: authInfo.email,
            emailVerified: false,
            displayName: "Test User",
            isAnonymous: false,
            photoURL: null,
            providerData: [
              {
                providerId: "password",
                uid: authInfo.localId,
                displayName: "Test User",
                email: authInfo.email,
                phoneNumber: null,
                photoURL: null,
              },
            ],
            stsTokenManager: {
              refreshToken: authInfo.refreshToken,
              accessToken: authInfo.idToken,
              expirationTime: Date.now() + 3600000,
            },
            createdAt: String(Date.now()),
            lastLoginAt: String(Date.now()),
            apiKey: "demo-api-key",
            appName: "[DEFAULT]",
          }),
        );
      }, authInfo);
}

test.describe('SKU Review - Unlisted Items', () => {
    test.setTimeout(60000);

    test.beforeEach(async ({ page }) => {
        // Navigate first to set origin for localStorage access
        await page.goto('/');

        // Sign In logic directly adapted from 001-root.spec.ts
        const authEmulatorUrl = "http://localhost:9099";
        const testEmail = `test-${Date.now()}@example.com`;
        const testPassword = "testpassword123";

        const authResponse = await page.request.post(
            `${authEmulatorUrl}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key`,
            {
                data: {
                    email: testEmail,
                    password: testPassword,
                    displayName: "Test User",
                    returnSecureToken: true,
                },
            },
        );

        if (!authResponse.ok()) {
            // If sign-up fails, try sign-in (email might exist if seeded)
             const loginResponse = await page.request.post(
                `${authEmulatorUrl}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`,
                {
                    data: {
                        email: testEmail,
                        password: testPassword,
                        returnSecureToken: true,
                    },
                }
            );
            if (!loginResponse.ok()) throw new Error(`Failed to auth test user: ${authResponse.status()}`);
             const authData = await loginResponse.json();
             await injectAuth(page, authData);
        } else {
             const authData = await authResponse.json();
             await injectAuth(page, authData);
        }
    });

    test('should flag unlisted items with UNLISTED badge', async ({ page }) => {
        // Direct navigation to target page
        await page.goto('/sku-review/');
        await waitForAppReady(page);
        await expect(page.locator('h1')).toHaveText('SKU Review');

        // Inject Test Data
        await test.step('Inject Test Data', async () => {
             await page.evaluate(async () => {
                const helpers = (window as any).testHelpers;
                if (!helpers) throw new Error("testHelpers not found on window. Ensure VITE_FIREBASE_ENV=local");
                const { store, actions } = helpers;
                const { bulk_import_items, create_listing, delete_listing } = actions;
                
                // 1. Create an item that IS listed
                const listedItem = {
                    id: 'test-listed-sku',
                    janCode: '4500000000001',
                    subtype: '',
                    description: 'Test Listed Item',
                    price: 1000,
                    weight: 100,
                    image: 'http://example.com/listed.jpg',
                    hsCode: '1234.56',
                    countryOfOrigin: 'JP',
                    qty: 10,
                    shipped: 0,
                    creationDate: '2024-01-01',
                    timestamp: Date.now()
                };
                
                // 2. Create an item that is UNLISTED
                const unlistedItem = {
                    id: 'test-unlisted-sku',
                    janCode: '4500000000002',
                    subtype: '',
                    description: 'Test Unlisted Item',
                    price: 1000,
                    weight: 100,
                    image: 'http://example.com/unlisted.jpg',
                    hsCode: '1234.56',
                    countryOfOrigin: 'JP',
                    qty: 10,
                    shipped: 0,
                    creationDate: '2024-01-02', 
                    timestamp: Date.now()
                };

                // Dispatch inventory updates (handled by bulk_import_items below)
                
                // Create listing for the listed item (with bodyHtml)
                store.dispatch(create_listing({
                    listing: {
                        handle: 'test-listed-item',
                        title: 'Test Listed Item',
                        bodyHtml: '<p>Valid Description</p>',
                        productCategory: 'Test',
                        productType: 'Test',
                        vendor: 'Test',
                        tags: [],
                        status: 'active',
                        option1Name: 'Title',
                        images: [],
                        lastUpdated: Date.now()
                    }
                }));

                // Create listing for the UNLISTED item (empty bodyHtml)
                store.dispatch(create_listing({
                    listing: {
                        handle: 'test-unlisted-item',
                        title: 'Test Unlisted Item',
                        bodyHtml: '', // Empty bodyHtml triggers "Unlisted"
                        productCategory: 'Test',
                        productType: 'Test',
                        vendor: 'Test',
                        tags: [],
                        status: 'active',
                        option1Name: 'Title',
                        images: [],
                        lastUpdated: Date.now()
                    }
                }));
                
                store.dispatch(bulk_import_items({ items: [
                    // Explicitly link the listed item to the handle we created above
                    { type: 'new', id: listedItem.id, item: { ...listedItem, handle: 'test-listed-item' } },
                    { type: 'new', id: unlistedItem.id, item: { ...unlistedItem, handle: 'test-unlisted-item' } }
                ]}));

                // Wait for async handling if any
                await new Promise(r => setTimeout(r, 100));
            });
        });

        await test.step('Verify Unlisted Badge', async () => {
             // Wait for specific rows to render first to avoid race conditions
             const unlistedRow = page.locator('tr', { hasText: 'Test Unlisted Item' });
             const listedRow = page.locator('tr', { hasText: 'Test Listed Item' });
             
             await unlistedRow.waitFor({ state: 'visible', timeout: 10000 });
             await listedRow.waitFor({ state: 'visible', timeout: 10000 });

             // Verify the unlisted one HAS the badge
             await expect(unlistedRow.locator('.badge', { hasText: 'Unlisted' })).toBeVisible();
             
             // Verify the listed one does NOT have it
             await expect(listedRow.locator('.badge', { hasText: 'Unlisted' })).toBeHidden();
        });
    });
});
