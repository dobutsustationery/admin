import { test, expect } from '../fixtures/auth';
import { waitForAppReady } from "../helpers/loading-helper";

test.describe('Variant Updates (Modal-driven)', () => {
    test('User can split and remove variants in Draft mode with stable identity', async ({ authenticatedPage: page }) => {
        test.setTimeout(120000);
        
        const janCode = 'VARIANT-TEST';
        const item1Id = 'item-v1';

        // Setup Console Logging
        page.on('console', msg => console.log(`BROWSER LOG: ${msg.text()}`));

        // Navigate to Listing Detail FIRST
        await page.goto(`/listing-detail?mode=create&janCode=${janCode}`);
        await waitForAppReady(page);
        await page.waitForFunction(() => (window as any).testHelpers);

        // WAIT FOR SYNC
        await page.waitForFunction(() => {
            const { store } = (window as any).testHelpers;
            return store.getState().inventory.initialized;
        }, { timeout: 60000 });

        // Setup Broadcast Capture
        await page.evaluate(() => {
            const { store } = (window as any).testHelpers;
            (window as any).broadcastHistory = [];
            const originalDispatch = store.dispatch;
            store.dispatch = (action: any) => {
                if (action.type?.includes('requested') || action.type?.includes('update_variant_qty')) {
                    (window as any).broadcastHistory.push(action);
                }
                return originalDispatch(action);
            };
        });
        
        // Inject Items & Proposal with TWO variants using same item
        await page.evaluate(({ janCode, item1Id }) => {
            const { store, actions } = (window as any).testHelpers;
            
            store.dispatch(actions.bulk_import_items({
                items: [{
                    id: item1Id,
                    item: { janCode, description: "Variant Test Product", qty: 10, subtype: "Base" },
                    type: 'new'
                }]
            }));

            store.dispatch(actions.add_proposals([{
                janCode,
                title: "Variant Test Product",
                status: 'draft',
                variants: [
                    { id: `${janCode}:V1:v1`, itemId: item1Id, qty: 5, option1Value: "V1" },
                    { id: `${janCode}:V2:v2`, itemId: item1Id, qty: 5, option1Value: "V2" }
                ],
                photoGroupIds: [],
                handle: "test-handle"
            }]));

            store.dispatch(actions.start_batch({ janCodes: [janCode], batchId: 'test-batch', createdAt: Date.now() }));
            store.dispatch(actions.set_current_step(0));
        }, { janCode, item1Id });

        // Wait for UI
        await expect(page.locator('.subtype-label', { hasText: 'V1' }).first()).toBeVisible({ timeout: 15000 });

        // --- TEST SPLIT (Issue #4 fix: pick between V1 and V2) ---
        
        await page.click('button:has-text("Manage Variants")');
        
        // Search for item
        await page.fill('#variant-search', janCode);
        const searchResult = page.locator('.result-item').first();
        await expect(searchResult).toBeVisible();
        await searchResult.click();

        // Verify BOTH V1 and V2 rows have radio buttons
        const rowV1 = page.locator('.allocation-row', { hasText: 'V1' }).first();
        const rowV2 = page.locator('.allocation-row', { hasText: 'V2' }).first();
        await expect(rowV1.locator('input[type="radio"]')).toBeVisible();
        await expect(rowV2.locator('input[type="radio"]')).toBeVisible();

        // Select V2 as source
        await rowV2.locator('input[type="radio"]').click();
        await expect(rowV2.locator('.source-badge')).toBeVisible();

        // Set Split Details
        await page.fill('#new-subtype', 'V3');
        await page.fill('#new-qty', '3');
        await rowV2.locator('input[type="number"]').fill('2'); // 5 - 3 = 2

        // Confirm Split
        const saveBtn = page.locator('button.btn-save');
        await expect(saveBtn).toBeEnabled();
        await saveBtn.click();
        
        // Verify Payload (Issue #2 fix included)
        await page.waitForFunction(() => (window as any).broadcastHistory.some((a: any) => a.type.includes('add_variant_requested')));
        const splitPayload = await page.evaluate(() => (window as any).broadcastHistory.find((a: any) => a.type.includes('add_variant_requested')).payload);
        expect(splitPayload.sourceVariantId).toBe(`${janCode}:V2:v2`);
        expect(splitPayload.subtype).toBe('V3');
        expect(splitPayload.qty).toBe(3);

        // --- TEST REMOVE (Issue #3 fix: remove specific variant) ---
        
        await page.click('button:has-text("Manage Variants")');
        
        // Toggle removal for V1
        await rowV1.locator('.row-remove-btn').click();
        await expect(rowV1.locator('.removed-badge')).toBeVisible();

        // Re-allocate 5 back to V2 to make it valid (V2 was 2, now 2+5=7)
        await rowV2.locator('input[type="number"]').fill('7');
        
        const removeSaveBtn = page.locator('button.btn-save');
        await expect(removeSaveBtn).toBeEnabled();
        await removeSaveBtn.click();

        // Verify removal broadcast
        await page.waitForFunction(() => (window as any).broadcastHistory.some((a: any) => a.type.includes('remove_variant_requested')));
        const removePayload = await page.evaluate(() => (window as any).broadcastHistory.find((a: any) => a.type.includes('remove_variant_requested')).payload);
        expect(removePayload.variantId).toBe(`${janCode}:V1:v1`);
    });

    test('User can pick specific source item for split in Live mode', async ({ authenticatedPage: page }) => {
        test.setTimeout(120000);
        
        const janCode = 'LIVE-SPLIT-TEST';
        const item1Id = `${janCode}:S`;
        const handle = 'live-handle';

        await page.goto(`/listing-detail?mode=live&handle=${handle}`);
        await waitForAppReady(page);
        await page.waitForFunction(() => (window as any).testHelpers);

        // WAIT FOR SYNC
        await page.waitForFunction(() => (window as any).testHelpers.store.getState().inventory.initialized, { timeout: 60000 });

        // Setup Broadcast Capture
        await page.evaluate(() => {
            const { store } = (window as any).testHelpers;
            (window as any).broadcastHistory = [];
            const originalDispatch = store.dispatch;
            store.dispatch = (action: any) => {
                if (action.type?.includes('split_inventory_item')) (window as any).broadcastHistory.push(action);
                return originalDispatch(action);
            };
        });

        // Inject Items & Listing
        await page.evaluate(({ janCode, item1Id, handle }) => {
            const { store, actions } = (window as any).testHelpers;
            store.dispatch(actions.bulk_import_items({
                items: [{ id: item1Id, item: { janCode, subtype: "S", qty: 5, handle }, type: 'new' }]
            }));
            store.dispatch(actions.create_listing({
                handle,
                listing: { handle, title: "Live Split Test", images: [] }
            }));
        }, { janCode, item1Id, handle });

        await expect(page.locator('.subtype-label', { hasText: 'S' }).first()).toBeVisible({ timeout: 10000 });

        await page.click('button:has-text("Manage Variants")');
        await page.fill('#variant-search', janCode);
        await page.locator('.result-item').first().click();

        // Set Split Details (Split 2 from S into M)
        await page.fill('#new-subtype', 'M');
        await page.fill('#new-qty', '2');
        await page.locator('.allocation-row', { hasText: 'S' }).first().locator('input[type="number"]').fill('3');

        await page.click('button.btn-save');

        await page.waitForFunction(() => (window as any).broadcastHistory.length > 0);
        const payload = await page.evaluate(() => (window as any).broadcastHistory[0].payload);
        expect(payload.sourceId).toBe(item1Id);
        expect(payload.splits[0].subtype).toBe('M');
        expect(payload.splits[0].qty).toBe(2);
    });
});
