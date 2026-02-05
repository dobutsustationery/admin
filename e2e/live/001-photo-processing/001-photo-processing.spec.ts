import { test, expect } from '../fixtures';
import { createScreenshotHelper } from '../../helpers/screenshot-helper';
import { TestDocumentationHelper } from '../../helpers/test-documentation-helper';
import * as path from 'path';

const PREFERRED_MEDIA_ITEM_ID = 'AOcBCupFCSjHAeHtqTfYFXK9NJK2WXUn-vwL-FvVkqXCeiYAq0qeWwrzQaogCwZPKQx6wmfr04aoYBcN9QoEHHgypqP6rUmiKw';

test.describe('Live Photo Processing', () => {
  test('Photo Processing Workflow', async ({ page, sandboxId }, testInfo) => {
    test.setTimeout(1200000);
    expect(sandboxId).toBeTruthy();
    const dialogMessages: string[] = [];
    page.on('dialog', async (dialog) => {
      dialogMessages.push(dialog.message());
      await dialog.dismiss();
    });
    const screenshots = createScreenshotHelper();
    const docHelper = new TestDocumentationHelper(path.dirname(testInfo.file));

    docHelper.setMetadata(
      'Photo Processing (Color, Crop, Remove BG)',
      '**As a** admin user, **I want to** process product photos (Crop, Color Correct, Remove Background) **so that** they are ready for listing.',
    );

    await page.goto('/photos');
    await expect(page.getByTestId('selection-area')).toBeVisible();

    const selectedQueue = page.getByTestId('selected-queue');
    const queueThumbs = selectedQueue.locator('[data-testid^="photo-thumbnail-"]');

    const getVisiblePhotoCount = async () => {
      const selectedCount = await queueThumbs.count();
      return selectedCount;
    };

    await page.waitForFunction(
      () => typeof (window as any).__E2E_IMPORT_PHOTOS_FROM_ALBUM__ === 'function',
      undefined,
      { timeout: 30000 },
    );
    await page.waitForFunction(
      () => !!((window as any).__store || (window as any).testHelpers?.store),
      undefined,
      { timeout: 30000 },
    );

    const importResult = await page.evaluate(async (preferredId) => {
      const readPhotosState = () => {
        const runtimeStore = (window as any).__store || (window as any).testHelpers?.store;
        return runtimeStore?.getState?.()?.photos || null;
      };
      const hook = (window as any).__E2E_IMPORT_PHOTOS_FROM_ALBUM__;
      if (typeof hook !== 'function') {
        return { ok: false, error: 'Missing __E2E_IMPORT_PHOTOS_FROM_ALBUM__ hook' };
      }
      try {
        const result = await hook('replace', 1, preferredId);
        const state = readPhotosState();
        const selectedCount = (state?.selected || []).length;
        return {
          ok: true,
          importedPhotoId: result?.importedItems?.[0]?.id || null,
          importedFilename: result?.importedItems?.[0]?.filename || null,
          importedMimeType: result?.importedItems?.[0]?.mimeType || null,
          selectedCount,
        };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    }, PREFERRED_MEDIA_ITEM_ID);

    expect(importResult.ok, importResult.error).toBeTruthy();
    expect(importResult.importedPhotoId, `Selected photos after import: ${importResult.selectedCount}`).toBeTruthy();

    try {
      await page.waitForFunction(
        (photoId) => {
          const runtimeStore = (window as any).__store || (window as any).testHelpers?.store;
          const state = runtimeStore?.getState?.()?.photos;
          return !!(state?.selected || []).find((item: any) => item.id === photoId);
        },
        importResult.importedPhotoId,
        { timeout: 60000 },
      );

      await page.waitForFunction(
        (photoId) => {
          const runtimeStore = (window as any).__store || (window as any).testHelpers?.store;
          const state = runtimeStore?.getState?.()?.photos;
          if (!state || !photoId) return false;
          const uploadStatus = state.uploads?.[photoId]?.status;
          const selected = (state.selected || []).find((item: any) => item.id === photoId);
          const baseUrl = selected?.baseUrl || "";
          return uploadStatus === 'completed' && typeof baseUrl === 'string' && !baseUrl.includes('googleusercontent.com');
        },
        importResult.importedPhotoId,
        { timeout: 180000 },
      );
    } catch {
      const uploadSnapshot = await page.evaluate((photoId) => {
        const runtimeStore = (window as any).__store || (window as any).testHelpers?.store;
        const state = runtimeStore?.getState?.()?.photos;
        const upload = state?.uploads?.[photoId];
        const selected = (state?.selected || []).find((item: any) => item.id === photoId);
        return {
          storeAvailable: !!runtimeStore,
          hasSelected: !!selected,
          uploadStatus: upload?.status || null,
          uploadError: upload?.error || null,
          baseUrl: selected?.baseUrl || null,
        };
      }, importResult.importedPhotoId);
      throw new Error(
        `Photo never reached Drive-backed state before processing. storeAvailable=${uploadSnapshot.storeAvailable} hasSelected=${uploadSnapshot.hasSelected} status=${uploadSnapshot.uploadStatus} error=${uploadSnapshot.uploadError} baseUrl=${uploadSnapshot.baseUrl}`,
      );
    }

    await expect(async () => {
      expect(await getVisiblePhotoCount()).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 120000 });

    await expect(async () => {
      const queueCount = await queueThumbs.count();
      expect(queueCount).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 180000 });

    const chosenPhotoId = importResult.importedPhotoId;
    expect(chosenPhotoId).toBeTruthy();
    const chosenThumb = page.getByTestId(`photo-thumbnail-${chosenPhotoId}`);
    const chosenThumbImage = chosenThumb.locator('img').first();

    const step1Checks = [
      {
        description: 'At least 1 real photo is visible in Photos view',
        check: async () => await expect(chosenThumb).toBeVisible(),
      },
      {
        description: 'Chosen photo is ready for processing',
        check: async () => await expect(chosenThumb).toHaveAttribute('data-photo-state', 'ready'),
      },
      {
        description: 'Chosen photo thumbnail has fully loaded',
        check: async () => {
          await expect(chosenThumb.getByText('Loading...')).toHaveCount(0);
          await expect(chosenThumbImage).toBeVisible();
        },
      },
    ];

    await expect(chosenThumb).toHaveAttribute('data-photo-state', 'ready', { timeout: 180000 });
    await expect(chosenThumb.getByText('Loading...')).toHaveCount(0, { timeout: 60000 });
    await expect(chosenThumbImage).toBeVisible({ timeout: 60000 });

    docHelper.addStep('Photos View Loaded', '000-photos-view.png', step1Checks);
    await screenshots.capture(page, 'photos-view', {
      fullPage: true,
      programmaticCheck: async () => {
        for (const c of step1Checks) await c.check();
      },
    });

    await chosenThumb.scrollIntoViewIfNeeded();
    await chosenThumb.click();
    await expect(page).toHaveURL(/\/photo-history/);
    await expect(page.locator('img[alt="Current"]').first()).toBeVisible({ timeout: 60000 });

    const historyRows = page.locator('.space-y-6 > div.relative.flex');
    const initialHistoryCount = await historyRows.count();

    const runOperation = async (
      label: 'Color' | 'Auto Crop' | 'Remove BG',
      progressScreenshot: string,
      completeScreenshot: string,
      expectedCount: number,
    ) => {
      const targetRow = historyRows.first();
      const opButton = targetRow.locator('button', { hasText: label }).first();

      await expect(opButton).toBeEnabled({ timeout: 30000 });
      await opButton.click();

      const inProgress = targetRow.locator('button', { hasText: '...' });
      await expect(inProgress.first()).toBeVisible({ timeout: 15000 });

      const progressChecks = [
        {
          description: `${label} operation entered in-progress state`,
          check: async () => await expect(inProgress.first()).toBeVisible(),
        },
      ];

      docHelper.addStep(`${label} In Progress`, progressScreenshot, progressChecks);
      await screenshots.capture(page, progressScreenshot.replace(/^\d{3}-/, '').replace(/\.png$/, ''), {
        fullPage: true,
        programmaticCheck: async () => {
          for (const c of progressChecks) await c.check();
        },
      });

      await expect(targetRow.locator('button', { hasText: '...' })).toHaveCount(0, { timeout: 600000 });
      expect(
        dialogMessages,
        `Operation "${label}" failed with dialog: ${dialogMessages.join(' | ')} (file: ${importResult.importedFilename}, mime: ${importResult.importedMimeType})`,
      ).toEqual([]);
      await expect(historyRows).toHaveCount(expectedCount, { timeout: 180000 });
      await expect(page.getByText('Failed to load image')).toHaveCount(0, { timeout: 120000 });
      await expect(page.getByText('Loading...')).toHaveCount(0, { timeout: 120000 });
      for (let i = 0; i < expectedCount; i++) {
        const row = historyRows.nth(i);
        await expect(row.locator('img').first()).toBeVisible({ timeout: 120000 });
      }

      const completeChecks = [
        {
          description: `${label} added one new history version`,
          check: async () => await expect(historyRows).toHaveCount(expectedCount),
        },
      ];

      docHelper.addStep(`${label} Completed`, completeScreenshot, completeChecks);
      await screenshots.capture(page, completeScreenshot.replace(/^\d{3}-/, '').replace(/\.png$/, ''), {
        fullPage: true,
        programmaticCheck: async () => {
          for (const c of completeChecks) await c.check();
        },
      });
    };

    await runOperation('Color', '001-color-in-progress.png', '002-color-completed.png', initialHistoryCount + 1);
    await runOperation('Auto Crop', '003-auto-crop-in-progress.png', '004-auto-crop-completed.png', initialHistoryCount + 2);
    await runOperation('Remove BG', '005-remove-bg-in-progress.png', '006-remove-bg-completed.png', initialHistoryCount + 3);

    const finalChecks = [
      {
        description: 'History contains exactly 3 new versions after processing',
        check: async () => await expect(historyRows).toHaveCount(initialHistoryCount + 3),
      },
      {
        description: 'Current image is visible after processing',
        check: async () => await expect(page.locator('img[alt="Current"]').first()).toBeVisible(),
      },
    ];

    docHelper.addStep('Processed Photo History', '007-processed-history.png', finalChecks);
    await screenshots.capture(page, 'processed-history', {
      fullPage: true,
      programmaticCheck: async () => {
        for (const c of finalChecks) await c.check();
      },
    });

    docHelper.writeReadme();
  });
});
