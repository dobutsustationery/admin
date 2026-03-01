import { test, expect } from "../fixtures/auth";
import { waitForAppReady } from "../helpers/loading-helper";

test.describe("Photo Processing Pipeline Configuration", () => {
  test("User can reorder processing steps", async ({
    authenticatedPage: page,
  }) => {
    // 1. Navigate to Photos page
    await page.goto("/photos");
    await waitForAppReady(page);

    // Wait for test helpers to be available
    await page.waitForFunction(() => (window as any).testHelpers);

    // Inject mock data to make the Categorized section visible
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

    // 4. Check initial order
    // Default: 1. Auto-Crop, 2. Background Removal, 3. Color Correction
    const steps = page.locator(".space-y-2 > div");
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0)).toContainText("Auto-Crop");
    await expect(steps.nth(1)).toContainText("Background Removal");
    await expect(steps.nth(2)).toContainText("Color Correction");

    // 5. Reorder: Move Color Correction up to the top
    // Initial: 1. Crop, 2. BG, 3. Color
    const colorRow = steps.filter({ hasText: "Color Correction" });
    const moveUpColor = colorRow.locator('button[title="Move Up"]');

    // Click up: Color moves to 2nd position
    await moveUpColor.click();
    await expect(colorRow).toContainText("2.");
    await expect(steps.nth(1)).toContainText("Color Correction");

    // Click up again: Color moves to 1st position
    await moveUpColor.click();
    await expect(colorRow).toContainText("1.");
    await expect(steps.nth(0)).toContainText("Color Correction");

    // Verify full order
    await expect(steps.nth(0)).toContainText("Color Correction");
    await expect(steps.nth(1)).toContainText("Auto-Crop");
    await expect(steps.nth(2)).toContainText("Background Removal");

    // 6. Save Configuration
    const saveBtn = page.locator('button:has-text("Save Configuration")');
    await saveBtn.click();

    // 7. Verify Modal is closed
    await expect(modalTitle).not.toBeVisible();

    // 8. Open again and verify order persisted in state
    await configBtn.click();
    await expect(steps.nth(0)).toContainText("Color Correction");
    await expect(steps.nth(1)).toContainText("Auto-Crop");
    await expect(steps.nth(2)).toContainText("Background Removal");

    await page.locator('button:has-text("Cancel")').click();
  });
});
