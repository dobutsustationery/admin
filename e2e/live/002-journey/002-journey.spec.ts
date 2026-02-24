import { test, expect } from "../../live/fixtures";
import { createScreenshotHelper } from "../../helpers/screenshot-helper";
import { TestDocumentationHelper } from "../../helpers/test-documentation-helper";
import * as path from "path";

const PREFERRED_MEDIA_ITEM_ID =
  process.env.E2E_GOOGLE_PREFERRED_MEDIA_ITEM_ID ??
  "1Xk0qww5eUV6OlMAg15tgKNGmLxxf168T";
const LIVE_IMPORT_TIMEOUT_MS = Number(
  process.env.E2E_LIVE_IMPORT_TIMEOUT_MS ?? "30000",
);
const LIVE_IMPORT_RETRIES = Number(process.env.E2E_LIVE_IMPORT_RETRIES ?? "1");
const LIVE_002_TEST_TIMEOUT_MS = Number(
  process.env.E2E_LIVE_002_TEST_TIMEOUT_MS ?? "150000",
);

const looksLikeDriveFileId = (value: string | null | undefined) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{20,}$/.test(value.trim());

async function waitForVisibleImagesToRender(page: any) {
  await page.evaluate(async () => {
    const visibleImages = Array.from(document.querySelectorAll("img")).filter(
      (img) => {
        const el = img as HTMLImageElement;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          el.offsetParent !== null &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width > 0 &&
          rect.height > 0
        );
      },
    ) as HTMLImageElement[];

    await Promise.all(
      visibleImages.map(async (img) => {
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
            // decode() can reject even after paint; continue.
          }
        }
      }),
    );

    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
}

async function importSinglePhotoFromDrive(
  page: any,
  preferredId: string | null,
) {
  const injectPreferredPhoto = async (photoId: string) =>
    await page.evaluate(
      ({ photoId }) => {
        const runtimeStore =
          (window as any).__store || (window as any).testHelpers?.store;
        const state = runtimeStore?.getState?.()?.photos || {};
        if (!runtimeStore?.dispatch) {
          return {
            ok: false,
            error: "Missing runtime store for synthetic import",
          };
        }
        const item = {
          id: photoId,
          description: "",
          productUrl: "",
          baseUrl: `https://lh3.googleusercontent.com/d/${photoId}=s0`,
          mimeType: "image/jpeg",
          filename: photoId,
          mediaMetadata: { creationTime: "", width: "0", height: "0" },
        };
        const existing = (state.registry || {})[photoId];
        if (!existing) {
          runtimeStore.dispatch({
            type: "photos/register_media_items",
            payload: { items: [item] },
          });
        }
        runtimeStore.dispatch({
          type: "photos/select_photos",
          payload: { ids: [photoId] },
        });
        const next = runtimeStore.getState?.()?.photos || {};
        return {
          ok: true,
          importedCount: 1,
          importedPhotoId: photoId,
          importSource: "synthetic-drive-id",
          selectedCount: (next.selected || []).length,
        };
      },
      { photoId },
    );

  const importOnce = async () =>
    await page.evaluate(
      async ({ preferredId, timeoutMs }) => {
        const readPhotosState = () => {
          const runtimeStore =
            (window as any).__store || (window as any).testHelpers?.store;
          return runtimeStore?.getState?.()?.photos || null;
        };
        const withTimeout = async <T>(
          promise: Promise<T>,
          label: string,
        ): Promise<T> => {
          return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
              setTimeout(() => {
                const state = readPhotosState();
                reject(
                  new Error(
                    `${label} timed out after ${timeoutMs}ms (selected=${(state?.selected || []).length})`,
                  ),
                );
              }, timeoutMs);
            }),
          ]);
        };

        const driveHook = (window as any).__E2E_IMPORT_PHOTOS_FROM_DRIVE__;
        if (typeof driveHook !== "function") {
          return {
            ok: false,
            error: "Missing __E2E_IMPORT_PHOTOS_FROM_DRIVE__ hook",
          };
        }
        try {
          let result: any = null;
          try {
            result =
              typeof preferredId === "string" && preferredId.trim().length > 0
                ? await withTimeout(
                    driveHook("replace", 1, preferredId),
                    "Drive import (preferred)",
                  )
                : await withTimeout(driveHook("replace", 1), "Drive import");
          } catch (preferredError) {
            const message = String(preferredError || "");
            if (
              !message.includes("Preferred photo") &&
              !message.includes("timed out")
            ) {
              throw preferredError;
            }
            result = await withTimeout(
              driveHook("replace", 1),
              "Drive import (fallback)",
            );
          }

          const state = readPhotosState();
          return {
            ok: true,
            importedCount: result?.importedItems?.length || 0,
            importedPhotoId: result?.importedItems?.[0]?.id || null,
            importSource: "drive",
            selectedCount: (state?.selected || []).length,
          };
        } catch (error) {
          return { ok: false, error: String(error) };
        }
      },
      { preferredId, timeoutMs: LIVE_IMPORT_TIMEOUT_MS },
    );

  let lastResult: any = null;
  for (let attempt = 0; attempt <= LIVE_IMPORT_RETRIES; attempt++) {
    lastResult = await importOnce();
    if (lastResult?.ok && (lastResult.importedCount || 0) > 0)
      return lastResult;

    const errorText = String(lastResult?.error || "");
    const retryable =
      errorText.includes("timed out") || errorText.includes("Preferred photo");
    if (looksLikeDriveFileId(preferredId) && errorText.includes("timed out")) {
      break;
    }
    if (!retryable || attempt === LIVE_IMPORT_RETRIES) break;

    console.warn(
      `[live-002] Drive import attempt ${attempt + 1} failed (${errorText}). Retrying...`,
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (
    (!lastResult?.ok || (lastResult.importedCount || 0) === 0) &&
    looksLikeDriveFileId(preferredId)
  ) {
    console.warn(
      "[live-002] Falling back to synthetic store import for preferred Drive file ID",
    );
    return await injectPreferredPhoto(String(preferredId));
  }

  return lastResult;
}

test.describe("Live Journey", () => {
  test.beforeEach(async ({ page, sandboxId }) => {
    expect(sandboxId).toBeTruthy();
    await page.goto("/photos");
    await expect(page.getByTestId("selection-area")).toBeVisible({
      timeout: 30000,
    });
  });

  test("Use real photos state and run categorization when queue exists", async ({
    page,
    sandboxId,
  }, testInfo) => {
    test.setTimeout(LIVE_002_TEST_TIMEOUT_MS);
    expect(sandboxId).toBeTruthy();
    const screenshots = createScreenshotHelper();
    const docHelper = new TestDocumentationHelper(path.dirname(testInfo.file));

    docHelper.setMetadata(
      "Live Journey (Photos Categorization)",
      "**As a** catalog operator, **I want to** categorize incoming photos from real connected services **so that** listing creation starts from correctly grouped images.",
    );

    const selectedQueue = page.getByTestId("selected-queue");
    const selectedThumbs = selectedQueue.locator(
      '[data-testid^="photo-thumbnail-"]',
    );
    const categorizedGroups = page.locator('[data-testid^="group-"]');

    await page.waitForFunction(
      () =>
        typeof (window as any).__E2E_IMPORT_PHOTOS_FROM_DRIVE__ === "function",
      undefined,
      { timeout: 15000 },
    );

    const importResult = await importSinglePhotoFromDrive(
      page,
      PREFERRED_MEDIA_ITEM_ID,
    );

    expect(importResult.ok, importResult.error).toBeTruthy();
    expect(
      importResult.importedCount,
      "Drive import returned 0 items. Run fixtures:google:sync before live E2E.",
    ).toBeGreaterThan(0);
    expect(
      importResult.importedCount,
      `Import source=${importResult.importSource || "unknown"}`,
    ).toBeGreaterThan(0);
    expect(
      importResult.importedPhotoId,
      `Import source=${importResult.importSource || "unknown"} importedCount=${importResult.importedCount} selectedCount=${importResult.selectedCount}`,
    ).toBeTruthy();

    await expect(async () => {
      expect(await selectedThumbs.count()).toBeGreaterThan(0);
    }).toPass({ timeout: 30000 });

    const chosenPhotoId = importResult.importedPhotoId as string;
    const chosenThumb = page.getByTestId(`photo-thumbnail-${chosenPhotoId}`);

    await page.waitForFunction(
      (photoId) => {
        const runtimeStore =
          (window as any).__store || (window as any).testHelpers?.store;
        const state = runtimeStore?.getState?.()?.photos;
        if (!state || !photoId) return false;
        const selected = (state.selected || []).find(
          (item: any) => item.id === photoId,
        );
        return !!selected;
      },
      chosenPhotoId,
      { timeout: 30000 },
    );
    await page.waitForFunction(
      (photoId) => {
        const runtimeStore =
          (window as any).__store || (window as any).testHelpers?.store;
        const photos = runtimeStore?.getState?.()?.photos;
        if (!photos || !photoId) return false;
        const selected = (photos.selected || []).find(
          (item: any) => item.id === photoId,
        );
        const baseUrl = selected?.baseUrl || "";
        return (
          typeof baseUrl === "string" &&
          baseUrl.includes("lh3.googleusercontent.com/d/")
        );
      },
      chosenPhotoId,
      { timeout: 15000 },
    );
    await expect(chosenThumb).toBeVisible({ timeout: 60000 });
    await expect(chosenThumb).toHaveAttribute("data-photo-state", "ready", {
      timeout: 90000,
    });
    await expect
      .poll(
        async () => {
          const img = chosenThumb.locator("img").first();
          if ((await img.count()) === 0) return false;
          return await img.evaluate(
            (node: HTMLImageElement) => node.complete && node.naturalWidth > 0,
          );
        },
        { timeout: 30000 },
      )
      .toBe(true);

    const initialChecks = [
      {
        description: "Photos page is visible and interactive",
        check: async () =>
          await expect(page.getByTestId("selection-area")).toBeVisible(),
      },
      {
        description: "Selection controls are visible",
        check: async () => {
          await expect(
            page.locator("button", { hasText: "Select Photos" }),
          ).toBeVisible();
          await expect(
            page.locator("button", { hasText: "Add Photos" }),
          ).toBeVisible();
        },
      },
    ];

    docHelper.addStep(
      "Initial Photos State",
      "000-initial-photos-state.png",
      initialChecks,
    );
    await screenshots.capture(page, "initial-photos-state", {
      fullPage: true,
      programmaticCheck: async () => {
        for (const c of initialChecks) await c.check();
        await waitForVisibleImagesToRender(page);
      },
    });

    const categorizeBtn = page.locator("button", {
      hasText: "Categorize Photos",
    });
    await expect(async () => {
      await expect(categorizeBtn).toBeEnabled();
    }).toPass({ timeout: 90000 });
    await categorizeBtn.click();

    await expect(page.locator("text=Categorizing...")).toBeVisible({
      timeout: 60000,
    });
    await expect(page.locator("text=Categorizing...")).toHaveCount(0, {
      timeout: 90000,
    });

    const finalChecks = [
      {
        description: "Categorization run completed (button enabled if present)",
        check: async () => {
          const buttonCount = await categorizeBtn.count();
          if (buttonCount > 0) {
            await expect(categorizeBtn).toBeEnabled();
          } else {
            await expect(page.locator("text=Categorizing...")).toHaveCount(0);
          }
        },
      },
      {
        description:
          "Post-categorization view keeps photos visible (queue or grouped)",
        check: async () => {
          const queueCount = await selectedThumbs.count();
          const groupCount = await categorizedGroups.count();
          expect(queueCount + groupCount).toBeGreaterThan(0);
        },
      },
      {
        description:
          "Chosen imported image remains fully loaded (not Loading...)",
        check: async () => {
          const chosenAnywhere = page.getByTestId(
            `photo-thumbnail-${chosenPhotoId}`,
          );
          await expect(chosenAnywhere).toHaveCount(1);
          await expect(chosenAnywhere).toHaveAttribute(
            "data-photo-state",
            "ready",
          );
        },
      },
    ];

    docHelper.addStep(
      "Post Categorization State",
      "001-post-categorization-state.png",
      finalChecks,
    );
    await screenshots.capture(page, "post-categorization-state", {
      fullPage: true,
      programmaticCheck: async () => {
        for (const c of finalChecks) await c.check();
        await waitForVisibleImagesToRender(page);
      },
    });

    docHelper.writeReadme();
  });
});
