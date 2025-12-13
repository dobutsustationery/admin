
import { test, expect } from '../fixtures/auth';
import { createScreenshotHelper } from "../helpers/screenshot-helper";
import { TestDocumentationHelper } from "../helpers/test-documentation-helper";
import { FlowHelper } from "../helpers/flow-helper";
import * as path from "path";

test.describe('Google Photos Integration', () => {
    
  test('should allow connecting and selecting photos via Picker', async ({ authenticatedPage: page }, testInfo) => {
    const outputDir = path.dirname(testInfo.file);
    const screenshots = createScreenshotHelper();
    const docHelper = new TestDocumentationHelper(outputDir);
    const flow = new FlowHelper(page, screenshots, docHelper);

    docHelper.setMetadata(
        "Google Photos Integration",
        "**As an** admin\n**I want to** connect Google Photos\n**So that** I can select photos via the Picker."
    );

    // 1. Initial Config & Mocks
    await page.addInitScript(() => {
      window.__MOCK_PHOTOS_CONFIG__ = true;
      // Note: We do NOT seed localStorage here, we want to test the Connect flow first.
      window.open = () => null; // Mock window.open
    });

    // Mock Picker API calls (will be used after connection)
    await page.route('https://photospicker.googleapis.com/v1/sessions', async (route: any) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ id: 'sess_123', pickerUri: 'http://example.com/picker' })
        });
    });

    let pollCount = 0;
    await page.route('https://photospicker.googleapis.com/v1/sessions/sess_123', async (route: any) => {
        pollCount++;
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                id: 'sess_123',
                pickerUri: 'http://example.com/picker',
                mediaItemsSet: pollCount >= 2
            })
        });
    });

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

    await page.route('http://via.placeholder.com/**', async (route: any) => {
        await route.fulfill({
            status: 200,
            contentType: 'image/jpeg',
            body: Buffer.from('dummy image content', 'base64')
        });
    });

    // 2. Connect Flow
    await flow.step("Connect Flow", "connect", [
        {
            description: "Navigate to Photos page",
            check: async () => {
                await page.goto('/photos');
                await expect(page.locator('h1')).toContainText('Google Photos Picker');
            }
        },
        {
             description: "Verify Connect Button",
             check: async () => await expect(page.locator('button', { hasText: 'Connect Google Photos' })).toBeVisible()
        },
        {
            description: "Simulate OAuth Callback",
            check: async () => {
                // Simulate return from Google with hash params
                await page.goto('about:blank');
                await page.goto('/photos#access_token=mock_token&expires_in=3600&scope=https://www.googleapis.com/auth/photospicker.mediaitems.readonly&token_type=Bearer&state=photos_auth');
            }
        },
        {
            description: "Verify Connected State",
            check: async () => {
                 await expect(page.locator('button', { hasText: 'Disconnect' })).toBeVisible();
                 await expect(page.locator('button', { hasText: 'Photos Library' })).toBeVisible();
            }
        }
    ]);

    // 3. Picker Flow
    await flow.step("Picker Flow", "picker-selection", [
        {
            description: "Start Selection",
            check: async () => {
                const btn = page.locator('button:has-text("Photos Library")');
                await btn.waitFor({ state: 'visible', timeout: 5000 });
                await btn.evaluate((node: any) => node.click());
            }
        },
        {
            description: "Wait for Polling (Mocked)",
            check: async () => {
                await expect(page.locator('text=Waiting for selection')).toBeVisible();
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
