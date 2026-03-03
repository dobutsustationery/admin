import { test, expect, type Page } from "../fixtures/auth";
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
  await page.evaluate(
    ({ selector }) => {
      if (document.getElementById("e2e-photo-thumb-stable-style")) return;

      const styleEl = document.createElement("style");
      styleEl.id = "e2e-photo-thumb-stable-style";
      styleEl.textContent = `
      [data-testid="selected-queue"] ~ div button,
      [data-testid="selected-queue"] button,
      button,
      h1,
      h2,
      h3,
      p,
      span,
      div {
        transition: none !important;
        animation: none !important;
        box-shadow: none !important;
        filter: none !important;
        text-shadow: none !important;
        transform: none !important;
        outline: none !important;
        -webkit-font-smoothing: none !important;
        text-rendering: geometricPrecision !important;
      }
      [data-testid="selected-queue"],
      [data-testid="selected-queue"] * {
        border-radius: 0 !important;
      }
      button {
        border-radius: 0 !important;
        border-color: #9ca3af !important;
        background-image: none !important;
        font-family: sans-serif !important;
        font-size: 14px !important;
        line-height: 1.2 !important;
        letter-spacing: 0 !important;
      }
      ${selector} {
        transition: none !important;
        animation: none !important;
        box-shadow: none !important;
        filter: none !important;
        will-change: auto !important;
        border-radius: 0 !important;
      }
      ${selector} * {
        transition: none !important;
        animation: none !important;
        filter: none !important;
        box-shadow: none !important;
        border-radius: 0 !important;
      }
      ${selector}:hover {
        --tw-ring-shadow: 0 0 #0000 !important;
        --tw-ring-offset-shadow: 0 0 #0000 !important;
        box-shadow: none !important;
      }
    `;
      document.head.appendChild(styleEl);
    },
    { selector: THUMBNAIL_SELECTOR },
  );
}

async function waitForVisiblePhotoThumbnailsReady(
  page: Page,
  expectedCount: number,
) {
  const thumbnails = page.locator(THUMBNAIL_SELECTOR);
  await expect(thumbnails).toHaveCount(expectedCount);

  await page.waitForFunction(
    ({ count, selector }) => {
      const items = Array.from(
        document.querySelectorAll(selector),
      ) as HTMLElement[];

      if (items.length !== count) return false;

      for (const item of items) {
        const uploadStatus = item.getAttribute("data-upload-status") || "none";
        if (uploadStatus === "failed") return false;

        const rect = item.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;

        const img = item.querySelector("img") as HTMLImageElement | null;
        if (!img) continue;
        if (!img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0)
          return false;
      }

      return true;
    },
    { count: expectedCount, selector: THUMBNAIL_SELECTOR },
    { timeout: 10000 },
  );

  await page.evaluate(
    async ({ selector }) => {
      const visibleThumbImgs = Array.from(
        document.querySelectorAll(`${selector} img`),
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

      await new Promise((resolve) =>
        requestAnimationFrame(() => resolve(null)),
      );
      await new Promise((resolve) =>
        requestAnimationFrame(() => resolve(null)),
      );
    },
    { selector: THUMBNAIL_SELECTOR },
  );

  await ensureStableThumbnailCaptureStyles(page);

  // Force a non-hover state and let the paint settle before capture.
  await page.mouse.move(8, 8);
  await page.evaluate(async () => {
    const active = document.activeElement as HTMLElement | null;
    if (active && typeof active.blur === "function") active.blur();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
  // Final small settle time to ensure UI is stable
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
}

test.describe("Google Photos Integration", () => {
  test("should allow connecting and selecting photos via Picker", async ({
    authenticatedPage: page,
  }, testInfo) => {
    test.setTimeout(30000);
    const outputDir = path.dirname(testInfo.file);
    const screenshots = createScreenshotHelper();
    const docHelper = new TestDocumentationHelper(outputDir);
    const flow = new FlowHelper(page, screenshots, docHelper);

    docHelper.setMetadata(
      "Google Photos Integration",
      "**As an** admin\n**I want to** connect Google Photos\n**So that** I can select photos via the Picker.",
    );

    // 1. Initial Config & Mocks
    await page.addInitScript(() => {
      window.__MOCK_PHOTOS_CONFIG__ = true;
      // Note: We do NOT seed localStorage here, we want to test the Connect flow first.
      window.open = () => null; // Mock window.open
    });

    page.on("console", (msg) => {
      if (msg.type() === "error") console.log(`[Browser Error] ${msg.text()}`);
    });

    // Unified Mock for ALL Google API calls to handle CORS correctly
    let pollCount = 0;
    await page.route("**/*googleapis.com/**", async (route) => {
      const url = route.request().url();
      const method = route.request().method();
      const corsHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Upload-Content-Type",
        "Access-Control-Expose-Headers": "Location",
      };

      if (method === "OPTIONS") {
        await route.fulfill({ status: 204, headers: corsHeaders });
        return;
      }

      // OAuth User Info
      if (url.includes("/oauth2/v2/userinfo")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: corsHeaders,
          body: JSON.stringify({ email: "test@example.com", name: "Test User" }),
        });
        return;
      }

      const requestUrl = new URL(url);

      // Picker Sessions
      if (requestUrl.pathname.includes("/v1/sessions")) {
        if (method === "POST") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            headers: corsHeaders,
            body: JSON.stringify({
              id: "sess_123",
              pickerUri: "http://example.com/picker",
            }),
          });
          return;
        }
        // Poll endpoint only: /v1/sessions/{id}
        // Do not match /v1/sessions/{id}/mediaItems
        if (
          method === "GET" &&
          requestUrl.pathname === "/v1/sessions/sess_123"
        ) {
          pollCount++;
          // Simulate user taking some time to select photos (3 polls)
          const isReady = pollCount > 2;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            headers: corsHeaders,
            body: JSON.stringify({
              id: "sess_123",
              pickerUri: "http://example.com/picker",
              mediaItemsSet: isReady,
            }),
          });
          return;
        }
      }

      // Album Media Items
      if (url.includes("/v1/albums/") && url.includes("/mediaItems")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: corsHeaders,
          body: JSON.stringify({
            mediaItems: [
              {
                id: "album_1",
                description: "Album Photo 1",
                productUrl: "http://example.com/a1",
                baseUrl: "https://mock.photos/album1.jpg",
                filename: "album1.jpg",
                mimeType: "image/jpeg",
                mediaMetadata: {
                  creationTime: "2023-01-01T00:00:00Z",
                  width: "100",
                  height: "100",
                },
              },
            ],
          }),
        });
        return;
      }

      // Media Items
      if (
        url.includes("/v1/mediaItems") ||
        requestUrl.pathname === "/v1/sessions/sess_123/mediaItems"
      ) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          headers: corsHeaders,
          body: JSON.stringify({
            mediaItems: [
              {
                id: "1",
                description: "Photo 1",
                productUrl: "http://example.com/1",
                baseUrl: "https://mock.photos/photo1.jpg",
                filename: "photo1.jpg",
                mimeType: "image/jpeg",
                mediaMetadata: {
                  creationTime: "2023-01-01T00:00:00Z",
                  width: "100",
                  height: "100",
                },
              },
              {
                id: "2",
                description: "Photo 2",
                productUrl: "http://example.com/2",
                baseUrl: "https://mock.photos/photo2.jpg",
                filename: "photo2.jpg",
                mimeType: "image/jpeg",
                mediaMetadata: {
                  creationTime: "2023-01-01T00:00:00Z",
                  width: "100",
                  height: "100",
                },
              },
            ],
          }),
        });
        return;
      }

      // Drive API
      if (url.includes("/drive/v3/files")) {
        if (method === "GET") {
          // findFolder() queries or details fetch
          if (url.includes("?q=")) {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              headers: corsHeaders,
              body: JSON.stringify({ files: [] }),
            });
            return;
          }
          const idMatch = url.match(/\/drive\/v3\/files\/([^?]+)/);
          const fileId = idMatch?.[1] || "mock-file-id";
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            headers: corsHeaders,
            body: JSON.stringify({
              id: fileId,
              name: "mock-upload.jpg",
              webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
              webContentLink: `https://drive.google.com/uc?id=${fileId}&export=download`,
              thumbnailLink: `https://drive.google.com/thumbnail?id=${fileId}`,
            }),
          });
          return;
        }
        if (method === "POST") {
          // Check if it's a permissions request
          if (url.includes("/permissions")) {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              headers: corsHeaders,
              body: JSON.stringify({ id: "mock-perm-123" }),
            });
            return;
          }
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            headers: corsHeaders,
            body: JSON.stringify({ id: `folder_${Date.now()}` }),
          });
          return;
        }
        if (method === "PATCH") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            headers: corsHeaders,
            body: "{}",
          });
          return;
        }
      }

      // Resumable Upload Initializer
      if (url.includes("/upload/drive/v3/files") && method === "POST") {
        await route.fulfill({
          status: 200,
          headers: {
            ...corsHeaders,
            "Access-Control-Expose-Headers": "Location",
            Location: "https://mock.upload/session/1",
          },
          body: JSON.stringify({ id: "mock-file-id" }),
        });
        return;
      }

      // Resumable Upload Data Transfer (PUT)
      if (url.startsWith("https://mock.upload/session/") && method === "PUT") {
        await route.fulfill({
          status: 200,
          headers: corsHeaders,
          body: JSON.stringify({ id: "mock-file-id" }),
        });
        return;
      }

      await route.continue();
    });

    await page.route("https://mock.photos/**", async (route: any) => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
          },
          body: "",
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=3600",
        },
        body: MOCK_IMAGE_SVG,
      });
    });

    await page.route(
      "https://lh3.googleusercontent.com/**",
      async (route: any) => {
        await route.fulfill({
          status: 200,
          contentType: "image/svg+xml",
          headers: { "Cache-Control": "public, max-age=3600" },
          body: MOCK_IMAGE_SVG,
        });
      },
    );

    await page.route("https://mock.upload/session/**", async (route: any) => {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "PUT, OPTIONS",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
          },
          body: "",
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ id: `uploaded_${Date.now()}` }),
      });
    });

    // 2. Connect Flow
    await flow.step("Connect Flow", "connect", [
      {
        description: "Navigate to Photos page",
        check: async () => {
          await page.goto("/photos");
          await expect(page.locator("h1")).toContainText(
            "Google Photos Import",
          );
        },
      },
      {
        description: "Verify Connect Button",
        check: async () =>
          await expect(
            page.locator("button", { hasText: "Connect Account" }),
          ).toBeVisible(),
      },
      {
        description: "Simulate OAuth Callback",
        check: async () => {
          // Simulate return from Google with hash params
          await page.goto("about:blank");
          await page.goto(
            "/photos#access_token=mock_token&expires_in=3600&scope=https://www.googleapis.com/auth/photospicker.mediaitems.readonly%20https://www.googleapis.com/auth/generative-language%20https://www.googleapis.com/auth/drive.readonly&token_type=Bearer&state=photos_auth",
          );
        },
      },
      {
        description: "Verify Connected State",
        check: async () => {
          await expect(
            page.getByRole("button", { name: "Switch Account" }),
          ).toBeVisible();
        },
      },
    ]);

    // 3. Picker Flow
    await flow.step(
      "Picker Flow",
      "picker-selection",
      [
        {
          description: "Start Selection",
          check: async () => {
            const btn = page.getByRole("button", { name: "Select Photos" });
            await btn.waitFor({ state: "visible", timeout: 5000 });
            await btn.click();
          },
        },
        {
          description: "Wait for Polling (Mocked)",
          check: async () => {
            await expect(
              page.locator("text=Selection in progress..."),
            ).toBeVisible();

            // Wait for it to disappear, indicating loadSelectedPhotos finished
            await expect(
              page.locator("text=Selection in progress..."),
            ).toBeHidden({ timeout: 15000 });

            // Check that 2 photos are rendered
            await expect(
              page.locator('[data-testid^="photo-thumbnail-"]'),
            ).toHaveCount(2, { timeout: 15000 });
          },
        },
        {
          description: "Verify Photos",
          check: async () => {
            await waitForVisiblePhotoThumbnailsReady(page, 2);
          },
        },
      ],
      { maxDiffPixelRatio: 0.05 },
    );

    docHelper.writeReadme();
  });
});

declare global {
  interface Window {
    __MOCK_PHOTOS_CONFIG__: boolean;
    originalLocation: string;
  }
}
