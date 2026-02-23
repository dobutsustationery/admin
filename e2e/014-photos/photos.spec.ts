
import { test, expect, type Page } from '../fixtures/auth';
import { createScreenshotHelper } from "../helpers/screenshot-helper";
import { TestDocumentationHelper } from "../helpers/test-documentation-helper";
import { FlowHelper } from "../helpers/flow-helper";
import * as path from "path";

const MOCK_IMAGE_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
  <rect width="120" height="120" fill="#e5e7eb"/>
  <rect x="10" y="10" width="100" height="100" rx="8" fill="#cbd5e1"/>
  <circle cx="40" cy="44" r="12" fill="#94a3b8"/>
  <path d="M18 94 L48 62 L66 78 L83 58 L102 94 Z" fill="#64748b"/>
</svg>
`.trim();

const THUMBNAIL_SELECTOR = '[data-testid^="photo-thumbnail-"]';

async function ensureStableThumbnailCaptureStyles(page: Page) {
  await page.evaluate(() => {
    if (document.getElementById("e2e-photo-thumb-stable-style")) return;

    const styleEl = document.createElement("style");
    styleEl.id = "e2e-photo-thumb-stable-style";
    styleEl.textContent = `
      ${THUMBNAIL_SELECTOR} {
        transition: none !important;
      }
      ${THUMBNAIL_SELECTOR}:hover {
        --tw-ring-shadow: 0 0 #0000 !important;
        --tw-ring-offset-shadow: 0 0 #0000 !important;
      }
    `;
    document.head.appendChild(styleEl);
  });
}

async function waitForVisiblePhotoThumbnailsReady(page: Page, expectedCount: number) {
  const thumbnails = page.locator(THUMBNAIL_SELECTOR);
  await expect(thumbnails).toHaveCount(expectedCount);

  await page.waitForFunction(
    (count) => {
      const items = Array.from(
        document.querySelectorAll(THUMBNAIL_SELECTOR),
      ) as HTMLElement[];

      if (items.length !== count) return false;

      for (const item of items) {
        const uploadStatus = item.getAttribute("data-upload-status") || "none";
        const photoState = item.getAttribute("data-photo-state") || "";
        if (uploadStatus === "uploading" || uploadStatus === "failed") return false;
        if (photoState !== "ready") return false;

        const img = item.querySelector("img") as HTMLImageElement | null;
        if (!img) return false;
        if (!img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) return false;
      }

      return true;
    },
    expectedCount,
    { timeout: 10000 },
  );

  await page.evaluate(async () => {
    const visibleThumbImgs = Array.from(
      document.querySelectorAll(`${THUMBNAIL_SELECTOR} img`),
    ) as HTMLImageElement[];

    await Promise.all(
      visibleThumbImgs.map(async (img) => {
        if (!img.complete) {
          await new Promise<void>((resolve) => {
            const done = () => resolve();
            img.addEventListener("load", done, { once: true });
            img.addEventListener("error", done, { once: true });
          });
        }
        if (typeof img.decode === "function") {
          try {
            await img.decode();
          } catch {
            // decode() may reject even when the image is displayable; handled by DOM checks above.
          }
        }
      }),
    );

    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });

  await ensureStableThumbnailCaptureStyles(page);

  // Force a non-hover state and let the paint settle before capture.
  await page.mouse.move(8, 8);
  await page.evaluate(async () => {
    const active = document.activeElement as HTMLElement | null;
    if (active && typeof active.blur === "function") active.blur();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
  await page.waitForTimeout(250);
}

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
    
    page.on('console', msg => {
        if (msg.type() === 'error') console.log(`[Browser Error] ${msg.text()}`);
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
                mediaItemsSet: true
            })
        });
    });

    await page.route('https://mock.photos/**', async (route: any) => {
        if (route.request().method() === 'OPTIONS') {
            await route.fulfill({
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, OPTIONS',
                    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
                },
                body: ''
            });
            return;
        }

        await route.fulfill({
            status: 200,
            contentType: 'image/svg+xml',
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'public, max-age=3600',
            },
            body: MOCK_IMAGE_SVG
        });
    });

    await page.route('https://lh3.googleusercontent.com/**', async (route: any) => {
        await route.fulfill({
            status: 200,
            contentType: 'image/svg+xml',
            headers: { 'Cache-Control': 'public, max-age=3600' },
            body: MOCK_IMAGE_SVG
        });
    });

    // Mock Drive folder discovery/creation + upload path used by the upload manager after selection
    await page.route('https://www.googleapis.com/drive/v3/files**', async (route: any) => {
        const req = route.request();
        const url = req.url();
        const method = req.method();
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        };

        if (method === 'OPTIONS') {
            await route.fulfill({ status: 204, headers: corsHeaders, body: '' });
            return;
        }

        if (method === 'GET') {
            // findFolder() queries should return "not found" so app creates folders deterministically
            if (url.includes('/drive/v3/files?')) {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    headers: corsHeaders,
                    body: JSON.stringify({ files: [] })
                });
                return;
            }
            // file details fetch after upload
            const idMatch = url.match(/\/drive\/v3\/files\/([^?]+)/);
            const fileId = idMatch?.[1] || 'mock-file-id';
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                headers: corsHeaders,
                body: JSON.stringify({
                    id: fileId,
                    name: 'mock-upload.jpg',
                    webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
                    webContentLink: `https://drive.google.com/uc?id=${fileId}&export=download`,
                    thumbnailLink: `https://drive.google.com/thumbnail?id=${fileId}`
                })
            });
            return;
        }

        if (method === 'POST') {
            // createFolder() and any non-upload file creation
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                headers: corsHeaders,
                body: JSON.stringify({ id: `folder_${Date.now()}` })
            });
            return;
        }

        if (method === 'PATCH') {
            await route.fulfill({ status: 200, contentType: 'application/json', headers: corsHeaders, body: '{}' });
            return;
        }

        await route.continue();
    });

    await page.route('https://www.googleapis.com/drive/v3/files/**/permissions', async (route: any) => {
        if (route.request().method() === 'OPTIONS') {
            await route.fulfill({
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
                },
                body: ''
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: '{}'
        });
    });

    await page.route('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', async (route: any) => {
        if (route.request().method() === 'OPTIONS') {
            await route.fulfill({
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
                },
                body: ''
            });
            return;
        }
        await route.fulfill({
            status: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Expose-Headers': 'Location',
                'Location': 'https://mock.upload/session/1'
            },
            body: ''
        });
    });

    await page.route('https://mock.upload/session/**', async (route: any) => {
        if (route.request().method() === 'OPTIONS') {
            await route.fulfill({
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'PUT, OPTIONS',
                    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
                },
                body: ''
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ id: `uploaded_${Date.now()}` })
        });
    });

    await page.route('https://photospicker.googleapis.com/v1/mediaItems**', async (route: any) => {
        await route.fulfill({
            status: 200,
            json: {
                mediaItems: [
                    {
                        id: '1',
                        description: 'Photo 1',
                        productUrl: 'http://example.com/1',
                        mediaFile: {
                            baseUrl: 'https://mock.photos/photo1.jpg',
                            filename: 'photo1.jpg',
                            mimeType: 'image/jpeg',
                            mediaFileMetadata: { width: '100', height: '100' }
                        },
                        mediaMetadata: { creationTime: '2023-01-01T00:00:00Z', width: '100', height: '100' }
                    },
                    {
                        id: '2',
                        description: 'Photo 2',
                        productUrl: 'http://example.com/2',
                        mediaFile: {
                            baseUrl: 'https://mock.photos/photo2.jpg',
                            filename: 'photo2.jpg',
                            mimeType: 'image/jpeg',
                            mediaFileMetadata: { width: '100', height: '100' }
                        },
                        mediaMetadata: { creationTime: '2023-01-01T00:00:00Z', width: '100', height: '100' }
                    }
                ]
            }
        });
    });

    // 2. Connect Flow
    await flow.step("Connect Flow", "connect", [
        {
            description: "Navigate to Photos page",
            check: async () => {
                await page.goto('/photos');
                await expect(page.locator('h1')).toContainText('Google Photos Import');
            }
        },
        {
             description: "Verify Connect Button",
             check: async () => await expect(page.locator('button', { hasText: 'Connect Account' })).toBeVisible()
        },
        {
            description: "Simulate OAuth Callback",
            check: async () => {
                // Simulate return from Google with hash params
                await page.goto('about:blank');
                await page.goto('/photos#access_token=mock_token&expires_in=3600&scope=https://www.googleapis.com/auth/photospicker.mediaitems.readonly%20https://www.googleapis.com/auth/generative-language%20https://www.googleapis.com/auth/drive.readonly&token_type=Bearer&state=photos_auth');
            }
        },
        {
            description: "Verify Connected State",
            check: async () => {
                 await expect(page.getByRole('button', { name: 'Switch Account' })).toBeVisible();
                 // await expect(page.locator('button', { hasText: 'Photos Library' })).toBeVisible();
            }
        }
    ]);

    // 3. Picker Flow
    await flow.step("Picker Flow", "picker-selection", [
        {
            description: "Start Selection",
            check: async () => {
                const btn = page.getByRole('button', { name: 'Select Photos' });
                await btn.waitFor({ state: 'visible', timeout: 5000 });
                await btn.evaluate((node: any) => node.click());
            }
        },
        {
            description: "Wait for Polling (Mocked)",
            check: async () => {
                await expect(page.locator('text=Selection in progress...')).toBeVisible();
                // Check that 2 photos are rendered
                await expect(page.locator('[data-testid^="photo-thumbnail-"]')).toHaveCount(2);
            }
        },
        {
            description: "Verify Photos",
            check: async () => {
                await waitForVisiblePhotoThumbnailsReady(page, 2);
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
