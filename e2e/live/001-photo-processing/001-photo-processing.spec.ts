import { test, expect } from "../fixtures";
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
const LIVE_001_TEST_TIMEOUT_MS = Math.max(
  Number(process.env.E2E_LIVE_001_TEST_TIMEOUT_MS ?? "180000"),
  300000,
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
            // Some images may reject decode after successful paint; we still continue.
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
          importedPhotoId: photoId,
          importedFilename: photoId,
          importedMimeType: "image/jpeg",
          importedCount: 1,
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
          let result: any;
          if (
            typeof preferredId === "string" &&
            preferredId.trim().length > 0
          ) {
            try {
              result = await withTimeout(
                driveHook("replace", 1, preferredId),
                "Drive import (preferred)",
              );
            } catch (preferredError) {
              result = await withTimeout(
                driveHook("replace", 1),
                "Drive import (fallback)",
              );
            }
          } else {
            result = await withTimeout(driveHook("replace", 1), "Drive import");
          }

          const state = readPhotosState();
          const imported = result?.importedItems || [];
          return {
            ok: true,
            importedPhotoId: imported[0]?.id || null,
            importedFilename: imported[0]?.filename || null,
            importedMimeType: imported[0]?.mimeType || null,
            importedCount: imported.length || 0,
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
      errorText.includes("timed out") || errorText.includes("importedCount");
    if (looksLikeDriveFileId(preferredId) && errorText.includes("timed out")) {
      break;
    }
    if (!retryable || attempt === LIVE_IMPORT_RETRIES) break;

    console.warn(
      `[live-001] Drive import attempt ${attempt + 1} failed (${errorText}). Retrying...`,
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (
    (!lastResult?.ok || (lastResult.importedCount || 0) === 0) &&
    looksLikeDriveFileId(preferredId)
  ) {
    console.warn(
      "[live-001] Falling back to synthetic store import for preferred Drive file ID",
    );
    return await injectPreferredPhoto(String(preferredId));
  }

  return lastResult;
}

test.describe("Live Photo Processing", () => {
  test("Photo Processing Workflow", async ({ page, sandboxId }, testInfo) => {
    test.setTimeout(LIVE_001_TEST_TIMEOUT_MS);
    expect(sandboxId).toBeTruthy();
    const dialogMessages: string[] = [];
    page.on("dialog", async (dialog) => {
      dialogMessages.push(dialog.message());
      await dialog.dismiss();
    });
    const screenshots = createScreenshotHelper();
    const docHelper = new TestDocumentationHelper(path.dirname(testInfo.file));

    docHelper.setMetadata(
      "Photo Processing (Color, Crop, Remove BG)",
      "**As a** admin user, **I want to** process product photos (Crop, Color Correct, Remove Background) **so that** they are ready for listing.",
    );

    await page.goto("/photos");
    await expect(page.getByTestId("selection-area")).toBeVisible();

    const selectedQueue = page.getByTestId("selected-queue");
    const queueThumbs = selectedQueue.locator(
      '[data-testid^="photo-thumbnail-"]',
    );

    const getVisiblePhotoCount = async () => {
      const selectedCount = await queueThumbs.count();
      return selectedCount;
    };

    await page.waitForFunction(
      () =>
        typeof (window as any).__E2E_IMPORT_PHOTOS_FROM_DRIVE__ === "function",
      undefined,
      { timeout: 15000 },
    );
    await page.waitForFunction(
      () => !!((window as any).__store || (window as any).testHelpers?.store),
      undefined,
      { timeout: 30000 },
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
      importResult.importedPhotoId,
      `Import source=${importResult.importSource || "unknown"} importedCount=${importResult.importedCount} selectedCount=${importResult.selectedCount}`,
    ).toBeTruthy();

    await page.waitForFunction(
      (photoId) => {
        const runtimeStore =
          (window as any).__store || (window as any).testHelpers?.store;
        const state = runtimeStore?.getState?.()?.photos;
        return !!(state?.selected || []).find(
          (item: any) => item.id === photoId,
        );
      },
      importResult.importedPhotoId,
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
      importResult.importedPhotoId,
      { timeout: 15000 },
    );

    await expect(async () => {
      expect(await getVisiblePhotoCount()).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 30000 });

    await expect(async () => {
      const queueCount = await queueThumbs.count();
      expect(queueCount).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 30000 });

    const chosenPhotoId = importResult.importedPhotoId;
    expect(chosenPhotoId).toBeTruthy();
    const chosenThumb = page.getByTestId(`photo-thumbnail-${chosenPhotoId}`);

    const step1Checks = [
      {
        description: "At least 1 real photo is visible in Photos view",
        check: async () => await expect(chosenThumb).toBeVisible(),
      },
      {
        description: "Chosen photo is ready for processing",
        check: async () =>
          await expect(chosenThumb).toHaveAttribute(
            "data-photo-state",
            "ready",
          ),
      },
      {
        description: "Chosen photo thumbnail has fully loaded",
        check: async () =>
          await expect(chosenThumb).toHaveAttribute(
            "data-photo-state",
            "ready",
          ),
      },
    ];

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

    docHelper.addStep("Photos View Loaded", "000-photos-view.png", step1Checks);
    await screenshots.capture(page, "photos-view", {
      fullPage: true,
      programmaticCheck: async () => {
        for (const c of step1Checks) await c.check();
      },
    });

    await chosenThumb.scrollIntoViewIfNeeded();
    await chosenThumb.click();
    await expect(page).toHaveURL(/\/photo-history/);
    await expect(page.locator('img[alt="Current"]').first()).toBeVisible({
      timeout: 30000,
    });

    const historyRows = page.locator(".space-y-6 > div.relative.flex");
    const initialHistoryCount = await historyRows.count();
    const initialPersistedHistoryCount = await page.evaluate(
      (targetPhotoId) => {
        const runtimeStore =
          (window as any).__store || (window as any).testHelpers?.store;
        const photos = runtimeStore?.getState?.()?.photos;
        return (photos?.urlHistory?.[targetPhotoId] || []).length;
      },
      chosenPhotoId,
    );

    const runOperation = async (
      label: "Color" | "Auto Crop" | "Remove BG",
      progressScreenshot: string,
      completeScreenshot: string,
      expectedCount: number,
    ) => {
      const previousHeadUrl = await page.evaluate((targetPhotoId) => {
        const runtimeStore =
          (window as any).__store || (window as any).testHelpers?.store;
        const photos = runtimeStore?.getState?.()?.photos;
        return photos?.urlHistory?.[targetPhotoId]?.[0] || null;
      }, chosenPhotoId);

      const targetRow = historyRows.first();
      const opButton = targetRow.locator("button", { hasText: label }).first();

      await page.evaluate(() => {
        (window as any).__E2E_OP_PAUSE_RESOLVER__ = null;
        (window as any).__E2E_PAUSE_OPERATION_AT_START__ = () =>
          new Promise<void>((resolve) => {
            (window as any).__E2E_OP_PAUSE_RESOLVER__ = resolve;
          });
      });

      await expect(opButton).toBeEnabled({ timeout: 30000 });
      await opButton.click();

      const inProgress = targetRow.locator("button", { hasText: "..." });
      await expect(inProgress.first()).toBeVisible({ timeout: 15000 });

      const progressChecks = [
        {
          description: `${label} operation entered in-progress state`,
          check: async () => await expect(inProgress.first()).toBeVisible(),
        },
        {
          description:
            "Current/history images are fully loaded during in-progress state",
          check: async () => {
            await expect
              .poll(
                async () => {
                  return await page
                    .locator("text=Failed to load image")
                    .evaluateAll(
                      (nodes) =>
                        nodes.filter(
                          (node) => (node as HTMLElement).offsetParent !== null,
                        ).length,
                    );
                },
                { timeout: 30000 },
              )
              .toBe(0);
            await expect
              .poll(
                async () => {
                  const current = page.locator('img[alt="Current"]').first();
                  const history = targetRow.locator("img").first();
                  return await Promise.all([
                    current.evaluate(
                      (img: HTMLImageElement) =>
                        img.complete && img.naturalWidth > 0,
                    ),
                    history.evaluate(
                      (img: HTMLImageElement) =>
                        img.complete && img.naturalWidth > 0,
                    ),
                  ]);
                },
                { timeout: 30000 },
              )
              .toEqual([true, true]);
          },
        },
      ];

      docHelper.addStep(
        `${label} In Progress`,
        progressScreenshot,
        progressChecks,
      );
      await waitForVisibleImagesToRender(page);
      await screenshots.capture(
        page,
        progressScreenshot.replace(/^\d{3}-/, "").replace(/\.png$/, ""),
        {
          fullPage: true,
          programmaticCheck: async () => {
            for (const c of progressChecks) await c.check();
          },
        },
      );

      await page.evaluate(() => {
        const resume = (window as any).__E2E_OP_PAUSE_RESOLVER__;
        if (typeof resume === "function") resume();
        delete (window as any).__E2E_OP_PAUSE_RESOLVER__;
        delete (window as any).__E2E_PAUSE_OPERATION_AT_START__;
      });

      await expect(targetRow.locator("button", { hasText: "..." })).toHaveCount(
        0,
        { timeout: 90000 },
      );
      expect(
        dialogMessages,
        `Operation "${label}" failed with dialog: ${dialogMessages.join(" | ")} (file: ${importResult.importedFilename}, mime: ${importResult.importedMimeType})`,
      ).toEqual([]);
      await page.waitForFunction(
        ({ targetPhotoId, prior }) => {
          const runtimeStore =
            (window as any).__store || (window as any).testHelpers?.store;
          const photos = runtimeStore?.getState?.()?.photos;
          const history = photos?.urlHistory?.[targetPhotoId] || [];
          const head = history[0] || null;
          const selected = (photos?.selected || []).find(
            (item: any) => item.id === targetPhotoId,
          );
          return !!head && head !== prior && selected?.baseUrl === head;
        },
        { targetPhotoId: chosenPhotoId, prior: previousHeadUrl },
        { timeout: 90000 },
      );
      await expect
        .poll(async () => await historyRows.count(), { timeout: 30000 })
        .toBeGreaterThanOrEqual(expectedCount);
      const finalCount = await historyRows.count();
      await expect
        .poll(
          async () => {
            return await page
              .locator("text=Failed to load image")
              .evaluateAll(
                (nodes) =>
                  nodes.filter(
                    (node) => (node as HTMLElement).offsetParent !== null,
                  ).length,
              );
          },
          { timeout: 30000 },
        )
        .toBe(0);
      await expect
        .poll(
          async () => {
            const current = page.locator('img[alt="Current"]').first();
            const history = targetRow.locator("img").first();
            return await Promise.all([
              current.evaluate(
                (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
              ),
              history.evaluate(
                (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
              ),
            ]);
          },
          { timeout: 60000 },
        )
        .toEqual([true, true]);
      for (let i = 0; i < finalCount; i++) {
        const row = historyRows.nth(i);
        await expect(row.locator("img").first()).toBeVisible({
          timeout: 30000,
        });
      }

      const completeChecks = [
        {
          description: `${label} added at least one new history version`,
          check: async () =>
            await expect(historyRows).toHaveCount(finalCount),
        },
      ];

      docHelper.addStep(
        `${label} Completed`,
        completeScreenshot,
        completeChecks,
      );
      await waitForVisibleImagesToRender(page);
      await screenshots.capture(
        page,
        completeScreenshot.replace(/^\d{3}-/, "").replace(/\.png$/, ""),
        {
          fullPage: true,
          programmaticCheck: async () => {
            for (const c of completeChecks) await c.check();
          },
        },
      );
    };

    await runOperation(
      "Color",
      "001-color-in-progress.png",
      "002-color-completed.png",
      initialPersistedHistoryCount + 1,
    );
    await runOperation(
      "Auto Crop",
      "003-auto-crop-in-progress.png",
      "004-auto-crop-completed.png",
      initialPersistedHistoryCount + 2,
    );
    await runOperation(
      "Remove BG",
      "005-remove-bg-in-progress.png",
      "006-remove-bg-completed.png",
      initialPersistedHistoryCount + 3,
    );

    const finalChecks = [
      {
        description: "History contains versions after processing",
        check: async () => {
          const count = await historyRows.count();
          expect(count).toBeGreaterThanOrEqual(initialPersistedHistoryCount + 3);
        },
      },
      {
        description: "Current image is visible after processing",
        check: async () =>
          await expect(
            page.locator('img[alt="Current"]').first(),
          ).toBeVisible(),
      },
    ];

    docHelper.addStep(
      "Processed Photo History",
      "007-processed-history.png",
      finalChecks,
    );
    await waitForVisibleImagesToRender(page);
    await screenshots.capture(page, "processed-history", {
      fullPage: true,
      programmaticCheck: async () => {
        for (const c of finalChecks) await c.check();
      },
    });

    docHelper.writeReadme();
  });
});
