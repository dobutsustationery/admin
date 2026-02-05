import { test, expect } from '../../live/fixtures';
import { createScreenshotHelper } from '../../helpers/screenshot-helper';
import { TestDocumentationHelper } from '../../helpers/test-documentation-helper';
import * as path from 'path';

const PREFERRED_MEDIA_ITEM_ID = 'AOcBCupFCSjHAeHtqTfYFXK9NJK2WXUn-vwL-FvVkqXCeiYAq0qeWwrzQaogCwZPKQx6wmfr04aoYBcN9QoEHHgypqP6rUmiKw';

test.describe('Live Journey', () => {
  test.beforeEach(async ({ page, sandboxId }) => {
    expect(sandboxId).toBeTruthy();
    await page.goto('/photos');
    await expect(page.getByTestId('selection-area')).toBeVisible({ timeout: 30000 });
  });

  test('Use real photos state and run categorization when queue exists', async ({ page, sandboxId }, testInfo) => {
    test.setTimeout(600000);
    expect(sandboxId).toBeTruthy();
    const screenshots = createScreenshotHelper();
    const docHelper = new TestDocumentationHelper(path.dirname(testInfo.file));

    docHelper.setMetadata(
      'Live Journey (Photos Categorization)',
      '**As a** catalog operator, **I want to** categorize incoming photos from real connected services **so that** listing creation starts from correctly grouped images.',
    );

    const selectedQueue = page.getByTestId('selected-queue');
    const selectedThumbs = selectedQueue.locator('[data-testid^="photo-thumbnail-"]');
    const categorizedGroups = page.locator('[data-testid^="group-"]');

    await page.waitForFunction(
      () => typeof (window as any).__E2E_IMPORT_PHOTOS_FROM_ALBUM__ === 'function',
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
        return {
          ok: true,
          importedCount: result?.importedItems?.length || 0,
          importedPhotoId: result?.importedItems?.[0]?.id || null,
          selectedCount: (state?.selected || []).length,
        };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    }, PREFERRED_MEDIA_ITEM_ID);

    expect(importResult.ok, importResult.error).toBeTruthy();
    expect(importResult.importedCount).toBeGreaterThan(0);
    expect(importResult.importedPhotoId, `Selected photos after import: ${importResult.selectedCount}`).toBeTruthy();

    await expect(async () => {
      expect(await selectedThumbs.count()).toBeGreaterThan(0);
    }).toPass({ timeout: 120000 });
    
    const chosenPhotoId = importResult.importedPhotoId as string;
    const chosenThumb = page.getByTestId(`photo-thumbnail-${chosenPhotoId}`);
    const chosenThumbImage = chosenThumb.locator('img').first();

    // Wait for the chosen imported image to be fully uploaded/rendered (not "Loading...")
    await page.waitForFunction(
      (photoId) => {
        const runtimeStore = (window as any).__store || (window as any).testHelpers?.store;
        const state = runtimeStore?.getState?.()?.photos;
        if (!state || !photoId) return false;
        const uploadStatus = state.uploads?.[photoId]?.status;
        const selected = (state.selected || []).find((item: any) => item.id === photoId);
        const baseUrl = selected?.baseUrl || '';
        return uploadStatus === 'completed' && typeof baseUrl === 'string' && !baseUrl.includes('googleusercontent.com');
      },
      chosenPhotoId,
      { timeout: 180000 },
    );
    await expect(chosenThumb).toBeVisible({ timeout: 60000 });
    await expect(chosenThumb).toHaveAttribute('data-photo-state', 'ready', { timeout: 180000 });
    await expect(chosenThumb.getByText('Loading...')).toHaveCount(0, { timeout: 60000 });
    await expect(chosenThumbImage).toBeVisible({ timeout: 60000 });

    const initialChecks = [
      {
        description: 'Photos page is visible and interactive',
        check: async () => await expect(page.getByTestId('selection-area')).toBeVisible(),
      },
      {
        description: 'Selection controls are visible',
        check: async () => {
          await expect(page.locator('button', { hasText: 'Select Photos' })).toBeVisible();
          await expect(page.locator('button', { hasText: 'Add Photos' })).toBeVisible();
        },
      },
    ];

    docHelper.addStep('Initial Photos State', '000-initial-photos-state.png', initialChecks);
    await screenshots.capture(page, 'initial-photos-state', {
      fullPage: true,
      programmaticCheck: async () => {
        for (const c of initialChecks) await c.check();
      },
    });

    const categorizeBtn = page.locator('button', { hasText: 'Categorize Photos' });
    await expect(async () => {
      await expect(categorizeBtn).toBeEnabled();
    }).toPass({ timeout: 240000 });
    await categorizeBtn.click();

    await expect(page.locator('text=Categorizing...')).toBeVisible({ timeout: 60000 });
    await expect(page.locator('text=Categorizing...')).toHaveCount(0, { timeout: 180000 });

    const finalChecks = [
      {
        description: 'Categorization run completed and controls are enabled again',
        check: async () => await expect(categorizeBtn).toBeEnabled(),
      },
      {
        description: 'Photos queue remains visible after live categorization activity',
        check: async () => {
          expect(await selectedThumbs.count()).toBeGreaterThan(0);
        },
      },
      {
        description: 'Chosen imported image remains fully loaded (not Loading...)',
        check: async () => {
          await expect(chosenThumb).toHaveAttribute('data-photo-state', 'ready');
          await expect(chosenThumb.getByText('Loading...')).toHaveCount(0);
          await expect(chosenThumbImage).toBeVisible();
        },
      },
    ];

    docHelper.addStep('Post Categorization State', '001-post-categorization-state.png', finalChecks);
    await screenshots.capture(page, 'post-categorization-state', {
      fullPage: true,
      programmaticCheck: async () => {
        for (const c of finalChecks) await c.check();
      },
    });

    docHelper.writeReadme();
  });
});
