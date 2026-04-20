import { test, expect } from "../fixtures/auth";
import { createScreenshotHelper } from "../helpers/screenshot-helper";
import crypto from "crypto";

const SHOPIFY_SECRET = "test_secret";

function computeHmac(payload: string, secret: string) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64");
}

test("Shopify Order Sync Flow", async ({ authenticatedPage: page, request }) => {
  test.setTimeout(120000); // Increase to 120s
  
  const screenshots = createScreenshotHelper();
  const janCode = "4902778133583";
  // The UI displays JAN and Subtype. For this item, subtype is empty.

  // Step 1: Check initial state
  page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text()));
  await page.goto("/inventory");
  await page.waitForLoadState('networkidle');
  
  console.log("Waiting for inventory to initialize...");
  // Wait for the item to be visible
  const rowLocator = page.locator('tr').filter({ has: page.locator('td', { hasText: janCode }) }).first();
  await expect(rowLocator).toBeVisible({ timeout: 30000 });
  
  const getShippedCell = () => rowLocator.locator('td').nth(7);
  
  // Initial shipped might not be 0 if test was run before, but we just need to see it increase
  const initialShippedText = await getShippedCell().innerText();
  const initialShipped = parseInt(initialShippedText) || 0;
  console.log(`Initial shipped value: ${initialShipped}`);
  
  await screenshots.capture(page, "initial-inventory");

  // Step 2: Trigger shopify/orders/create webhook
  const runId = Date.now();
  const orderPayload = {
    id: runId, // Use unique order ID
    email: "test-customer@example.com",
    created_at: new Date().toISOString(),
    line_items: [
      {
        id: runId + 1, // Unique line item ID
        sku: janCode,
        quantity: 5,
        variant_title: ""
      }
    ]
  };
  const body = JSON.stringify(orderPayload);
  const hmac = computeHmac(body, SHOPIFY_SECRET);

  console.log("Sending orders/create webhook...");
  const response = await request.post("http://localhost:5001/demo-test-project/us-central1/shopifyOrderWebhook", {
    data: orderPayload,
    headers: {
      "x-shopify-topic": "orders/create",
      "x-shopify-hmac-sha256": hmac,
      "x-shopify-webhook-id": `web-create-${runId}`
    }
  });

  expect(response.ok()).toBe(true);
  
  // Step 3: Verify UI update
  await expect(getShippedCell()).toHaveText(String(initialShipped + 5), { timeout: 30000 });
  
  await screenshots.capture(page, "after-shopify-order");

  // Step 4: Trigger refund
  const refundPayload = {
    id: runId + 2,
    order_id: runId,
    refund_line_items: [
      {
        line_item_id: runId + 1,
        quantity: 2,
        line_item: { id: runId + 1, sku: janCode }
      }
    ]
  };
  const refundBody = JSON.stringify(refundPayload);
  const refundHmac = computeHmac(refundBody, SHOPIFY_SECRET);

  console.log("Sending refunds/create webhook...");
  const refundResponse = await request.post("http://localhost:5001/demo-test-project/us-central1/shopifyOrderWebhook", {
    data: refundPayload,
    headers: {
      "x-shopify-topic": "refunds/create",
      "x-shopify-hmac-sha256": refundHmac,
      "x-shopify-webhook-id": `web-refund-${runId}`
    }
  });

  expect(refundResponse.ok()).toBe(true);

  // Step 5: Verify UI update
  await expect(getShippedCell()).toHaveText(String(initialShipped + 3), { timeout: 30000 });
  
  await screenshots.capture(page, "after-shopify-refund");

  // Step 6: Trigger reconciliation via orders/updated
  const updatedPayload = {
    ...orderPayload,
    updated_at: new Date().toISOString(),
    line_items: [
      {
        ...orderPayload.line_items[0],
        quantity: 10,
        refund_quantity: 0
      }
    ]
  };
  const updatedBody = JSON.stringify(updatedPayload);
  const updatedHmac = computeHmac(updatedBody, SHOPIFY_SECRET);
  
  console.log("Sending orders/updated webhook (reconcile)...");
  const updatedResponse = await request.post("http://localhost:5001/demo-test-project/us-central1/shopifyOrderWebhook", {
    data: updatedPayload,
    headers: {
      "x-shopify-topic": "orders/updated",
      "x-shopify-hmac-sha256": updatedHmac,
      "x-shopify-webhook-id": `web-update-${runId}`
    }
  });
  
  expect(updatedResponse.ok()).toBe(true);
  
  await expect(getShippedCell()).toHaveText(String(initialShipped + 10), { timeout: 30000 });
  
  await screenshots.capture(page, "after-shopify-reconcile");
});
