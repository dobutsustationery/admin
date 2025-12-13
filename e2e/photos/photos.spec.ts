

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
        "**As an** admin\n**I want to** connect Google Photos\n**So that** I can access shared albums."
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
                await expect(page.locator('h1')).toContainText('Google Photos Integration');
            }
        },
        {
             description: "Verify Connect Button",
             check: async () => await expect(page.locator('button', { hasText: 'Connect Google Photos' })).toBeVisible()
        },
        {
            description: "Simulate OAuth Callback",
            check: async () => {
                await page.goto('about:blank');
                await page.goto('/photos#access_token=mock_access_token&expires_in=3600&state=photos_auth');
            }
        },
        {
            description: "Verify Connected State",
            check: async () => {
                 await expect(page.locator('button', { hasText: 'Disconnect' })).toBeVisible();
                 await expect(page.locator('input[placeholder="Paste shared album URL"]')).toBeVisible();
            }
        }
    ]);
    
    docHelper.writeReadme();
  });

  test('should allow adding an album and viewing photos', async ({ authenticatedPage: page }, testInfo) => {
     const outputDir = path.dirname(testInfo.file);
     const screenshots = createScreenshotHelper();
     const docHelper = new TestDocumentationHelper(outputDir);
     const flow = new FlowHelper(page, screenshots, docHelper);

     docHelper.setMetadata(
        "Google Photos Album View",
        "**As an** admin\n**I want to** add an album\n**So that** I can view photos."
     );

     // Config
     await page.addInitScript(() => {
        window.__MOCK_PHOTOS_CONFIG__ = true;
        localStorage.setItem('google_photos_access_token', JSON.stringify({
            access_token: 'mock_token',
            expires_in: 3600,
            expires_at: Date.now() + 3600000,
            scope: 'scope',
            token_type: 'Bearer'
        }));
    });

    // Mock API calls
    await page.route('https://photoslibrary.googleapis.com/v1/sharedAlbums:join', async (route: any) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                album: { id: 'album_123', title: 'Test Album', productUrl: 'http://google.com', mediaItemsCount: '2' }
            })
        });
    });

    await page.route('https://photoslibrary.googleapis.com/v1/mediaItems:search', async (route: any) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                mediaItems: [
                    { id: 'photo1', baseUrl: 'http://via.placeholder.com/400', filename: 'photo1.jpg', mimeType: 'image/jpeg', mediaMetadata: { creationTime: '2023-01-01' } },
                    { id: 'photo2', baseUrl: 'http://via.placeholder.com/400', filename: 'photo2.jpg', mimeType: 'image/jpeg', mediaMetadata: { creationTime: '2023-01-02' } }
                ]
            })
        });
    });

    await flow.step("View Album", "001-view-album", [
        {
            description: "Navigate to Photos",
            check: async () => await page.goto('/photos')
        },
        {
            description: "Add Album",
            check: async () => {
                const shareUrl = 'https://photos.google.com/share/AF1QipP9mocktoken';
                await page.fill('input[placeholder="Paste shared album URL"]', shareUrl);
                await page.click('button:has-text("Add Album")');
            }
        },
        {
            description: "Verify Album List",
            check: async () => {
                await expect(page.locator('button', { hasText: 'Test Album' })).toBeVisible();
                await expect(page.locator('text=2 items')).toBeVisible();
            }
        },
        {
            description: "Verify Photo Grid",
            check: async () => {
                await expect(page.locator('h2', { hasText: 'Test Album' })).toBeVisible();
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


