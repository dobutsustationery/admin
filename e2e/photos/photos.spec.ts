
import { test, expect } from '../fixtures/auth';
import { createScreenshotHelper } from "../helpers/screenshot-helper";
import { TestDocumentationHelper } from "../helpers/test-documentation-helper";
import { FlowHelper } from "../helpers/flow-helper";
import * as path from "path";

test.describe('Google Photos Integration', () => {
    
  test('should allow connecting to Google Photos (mocked)', async ({ authenticatedPage: page }, testInfo) => {
    const outputDir = path.dirname(testInfo.file);
    const screenshots = createScreenshotHelper();
    const docHelper = new TestDocumentationHelper(outputDir);
    const flow = new FlowHelper(page, screenshots, docHelper);

    docHelper.setMetadata(
        "Google Photos Connection",
        "**As an** admin\n**I want to** connect Google Photos\n**So that** I can select photos via the Picker."
    );

    // Inject mock config to bypass env var checks
    await page.addInitScript(() => {
      window.__MOCK_PHOTOS_CONFIG__ = true;
    });

    await flow.step("Connect Flow", "001-connect", [
        {
            description: "Navigate to Photos page",
            check: async () => {
                await page.goto('/photos');
                await expect(page.locator('h1')).toContainText('Google Photos Picker');
                // Wait for any disconnected state to resolve
            }
        },
        {
             description: "Verify Connect Button",
             check: async () => await expect(page.locator('button', { hasText: 'Connect Google Photos' })).toBeVisible()
        },
        {
            description: "Simulate OAuth Callback",
            check: async () => {
                // Navigate away and back with token
                await page.goto('about:blank');
                await page.goto('/photos#access_token=mock_access_token&expires_in=3600&state=photos_auth');
            }
        },
        {
            description: "Verify Connected State",
            check: async () => {
                 await expect(page.locator('button', { hasText: 'Disconnect' })).toBeVisible();
                 // New UI elements
                 await expect(page.locator('button', { hasText: 'Photos Library' })).toBeVisible();
            }
        }
    ]);
    
    docHelper.writeReadme();
  });

  test('should allow selecting photos via Picker flow', async ({ authenticatedPage: page }, testInfo) => {
     const outputDir = path.dirname(testInfo.file);
     const screenshots = createScreenshotHelper();
     const docHelper = new TestDocumentationHelper(outputDir);
     const flow = new FlowHelper(page, screenshots, docHelper);

     docHelper.setMetadata(
        "Google Photos Picker Flow",
        "**As an** admin\n**I want to** select photos from the Picker\n**So that** I can import them."
     );

     // Config: Start Authenticated
     await page.addInitScript(() => {
        window.__MOCK_PHOTOS_CONFIG__ = true;
        localStorage.setItem('google_photos_access_token', JSON.stringify({
            access_token: 'mock_token',
            expires_in: 3600,
            expires_at: Date.now() + 3600000,
            scope: 'scope',
            token_type: 'Bearer'
        }));
        window.open = () => null; // Mock window.open    
    });

    // Mock API calls
    
    // 1. Create Session
    await page.route('https://photospicker.googleapis.com/v1/sessions', async (route: any) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                id: 'sess_123',
                pickerUri: 'http://example.com/picker'
            })
        });
    });

    // 2. Poll Session (First call: waiting, Second call: done)
    let pollCount = 0;
    await page.route('https://photospicker.googleapis.com/v1/sessions/sess_123', async (route: any) => {
        pollCount++;
        const mediaItemsSet = pollCount >= 2;
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                id: 'sess_123',
                pickerUri: 'http://example.com/picker',
                mediaItemsSet: mediaItemsSet
            })
        });
    });

    // 3. List Media Items
    await page.route('https://photospicker.googleapis.com/v1/mediaItems?sessionId=sess_123&pageSize=100', async (route: any) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                mediaItems: [
                    {
                        id: '1',
                        mediaFile: {
                            baseUrl: 'http://via.placeholder.com/150',
                            filename: 'photo1.jpg',
                            mimeType: 'image/jpeg'
                        }
                    },
                    {
                        id: '2',
                        mediaFile: {
                            baseUrl: 'http://via.placeholder.com/150',
                            filename: 'photo2.jpg',
                            mimeType: 'image/jpeg'
                        }
                    }
                ]
            })
        });
    });

    // 4. Mock Image Requests for SecureImage
    await page.route('http://via.placeholder.com/**', async (route: any) => {
        await route.fulfill({
            status: 200,
            contentType: 'image/jpeg',
            body: Buffer.from('failed to load', 'base64') // Just dummy content, SecureImage checks response.ok
        });
    });

    await flow.step("Open Picker", "001-open-picker", [
        {
            description: "Navigate to Photos",
            check: async () => await page.goto('/photos')
        },
        {
            description: "Start Selection",
            check: async () => {
                // We mock the popup behavior by just verifying polling starts.
                await page.click('button:has-text("Photos Library")', { force: true });
                // We mock the popup content or just let it close/ignore since test is fast
                // Actually, in test environment window.open might be blocked or handled differently.
                // But let's proceed. The button click triggers polling.
            }
        },
        {
            description: "Wait for Polling (Mocked)",
            check: async () => {
                // The polling is mocked to succeed on 2nd try (approx 2-4 seconds)
                // We verify the spinning state then done state
                await expect(page.locator('text=Waiting for selection')).toBeVisible();
                
                // Eventually items should appear
                await expect(page.locator('h3', { hasText: 'Selected Photos (2)' })).toBeVisible({ timeout: 10000 });
            }
        },
        {
            description: "Verify Photos",
            check: async () => {
                const photos = page.locator('img[alt="Thumbnail"]');
                await expect(photos).toHaveCount(2);
            }
        }
    ]);

    docHelper.writeReadme();
  });
});

declare global {
  interface Window {
    __MOCK_PHOTOS_CONFIG__: boolean;
    originalLocation: string;
  }
}
