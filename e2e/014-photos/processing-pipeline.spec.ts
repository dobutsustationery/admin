import { test, expect } from "../fixtures/auth";
import { waitForAppReady } from "../helpers/loading-helper";

test.describe("Photo Processing Pipeline Configuration", () => {
  test("User can enable/disable and reorder processing steps", async ({
    authenticatedPage: page,
  }) => {
    // 1. Navigate to Photos page
    await page.goto("/photos");
    await waitForAppReady(page);

    // Wait for test helpers to be available
    await page.waitForFunction(() => (window as any).testHelpers);

    // Inject mock data
    await page.evaluate(() => {
      const { store, actions } = (window as any).testHelpers;
      const mockPhoto = {
        id: "test-photo-1",
        baseUrl: "https://example.com/photo.jpg",
        filename: "test.jpg",
        mimeType: "image/jpeg",
        mediaMetadata: { width: "100", height: "100", creationTime: "" },
      };

      store.dispatch(actions.register_media_items({ items: [mockPhoto] }));
      store.dispatch(
        actions.categorize_photo({ janCode: "TEST-JAN", photo: mockPhoto }),
      );
    });

    // 2. Open Configuration Modal
    const configBtn = page.locator(
      'button[title="Configure processing steps and order"]',
    );
    await expect(configBtn).toBeVisible({ timeout: 10000 });
    await configBtn.click();

    // 3. Verify Modal is open
    const modalTitle = page.locator(
      'h3:has-text("Configure Image Processing")',
    );
    await expect(modalTitle).toBeVisible();

    // 4. Check initial order and enabled states
    // Default: 1. Auto-Crop (disabled), 2. Color Correction, 3. Background Removal
    const stepsList = page.locator(".steps-list");
    const stepRows = stepsList.locator(".step-row");
    await expect(stepRows).toHaveCount(3);

    // Check Auto-Crop (Initial: 1st, Disabled)
    const cropRow = stepRows.nth(0);
    await expect(cropRow).toContainText("Auto-Crop");
    await expect(cropRow).toHaveClass(/disabled/);
    const cropSwitch = cropRow.locator('input[type="checkbox"]');
    const cropSlider = cropRow.locator('.slider');
    await expect(cropSwitch).not.toBeChecked();

    // Check Color Correction (Initial: 2nd, Enabled)
    const colorRow = stepRows.nth(1);
    await expect(colorRow).toContainText("Color Correction");
    await expect(colorRow).not.toHaveClass(/disabled/);
    const colorSwitch = colorRow.locator('input[type="checkbox"]');
    await expect(colorSwitch).toBeChecked();

    // Check Background Removal (Initial: 3rd, Enabled)
    const bgRow = stepRows.filter({ hasText: "Background Removal" });
    await expect(bgRow).toContainText("Background Removal");
    await expect(bgRow).not.toHaveClass(/disabled/);
    const bgSwitch = bgRow.locator('input[type="checkbox"]');
    await expect(bgSwitch).toBeChecked();

    // 5. Modify: Enable Auto-Crop, Move BG Removal to top
    // Enable Auto-Crop
    await cropSlider.click();
    await expect(cropRow).not.toHaveClass(/disabled/);
    await expect(cropSwitch).toBeChecked();

    // Move BG Removal Up twice to reach the top
    const moveUpBg = bgRow.locator('button[title="Move Up"]');
    await moveUpBg.click(); // Now 2nd
    await moveUpBg.click(); // Now 1st

    // Verify new order
    await expect(stepRows.nth(0)).toContainText("Background Removal");
    await expect(stepRows.nth(1)).toContainText("Auto-Crop");
    await expect(stepRows.nth(2)).toContainText("Color Correction");

    // 6. Save Configuration
    const saveBtn = page.locator('button:has-text("Save Configuration")');
    await saveBtn.click();

    // 7. Verify Modal is closed
    await expect(modalTitle).not.toBeVisible();

    // 8. Open again and verify order and states persisted
    await configBtn.click();
    await expect(stepRows.nth(0)).toContainText("Background Removal");
    await expect(stepRows.nth(1)).toContainText("Auto-Crop");
    await expect(stepRows.nth(2)).toContainText("Color Correction");
    await expect(stepRows.nth(1).locator('input[type="checkbox"]')).toBeChecked();

    // 9. HYDRATE Test: Verify config survives hydration
    await page.evaluate(() => {
      const { store } = (window as any).testHelpers;
      const state = store.getState();
      store.dispatch({
        type: "HYDRATE",
        payload: { ...state }
      });
    });

    // Re-verify modal after simulated hydration
    await expect(stepRows.nth(0)).toContainText("Background Removal");
    await expect(stepRows.nth(1)).toContainText("Auto-Crop");
    await expect(stepRows.nth(2)).toContainText("Color Correction");

    await page.locator('button:has-text("Cancel")').click();
  });
});
