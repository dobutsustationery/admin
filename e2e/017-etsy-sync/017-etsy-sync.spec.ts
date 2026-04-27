import { test, expect } from "../fixtures/auth";
import { createScreenshotHelper } from "../helpers/screenshot-helper";
import { waitForAppReady, waitForImages } from "../helpers/loading-helper";
import crypto from "crypto";

const ETSY_SECRET = "test_secret";

function computeHmac(payload: string, secret: string) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64");
}

test("Etsy Order Sync - Exception UI", async ({ authenticatedPage: page, request }) => {
  test.setTimeout(120000);
  
  const screenshots = createScreenshotHelper();
  const runId = Math.floor(Date.now() / 1000);

  // Step 1: Navigate to sync-status
  await page.goto("/sync-status");
  await waitForAppReady(page);
  await screenshots.capture(page, "000-initial-sync-status");

  // Step 2: Trigger an order with unknown SKU to cause exception
  const exceptionReceiptId = `etsy-exc-${runId}`;
  const exceptionPayload = {
    event_type: "receipt.created",
    resource_data: {
      receipt_id: exceptionReceiptId,
      create_timestamp: runId,
      status: "paid",
      transactions: [
        {
          transaction_id: `tx-exc-${runId}`,
          sku: "UNKNOWN-SKU",
          quantity: 1
        }
      ]
    }
  };
  const exceptionBody = JSON.stringify(exceptionPayload);
  const exceptionSignature = computeHmac(exceptionBody, ETSY_SECRET);

  console.log("Sending Etsy webhook with unknown SKU...");
  const response = await request.post("http://localhost:15001/demo-test-project/us-central1/etsyOrderWebhook", {
    data: exceptionBody,
    headers: {
      "Content-Type": "application/json",
      "x-etsy-signature": exceptionSignature,
      "x-etsy-event-id": `evt-exc-${runId}`
    }
  });
  expect(response.ok()).toBe(true);

  // Step 3: Verify Exception UI appears
  // Reload or wait for state sync
  await page.reload();
  await waitForAppReady(page);
  
  console.log("Checking for exception section...");
  const exceptionSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Etsy Order Sync Exceptions' }) });
  await expect(exceptionSection).toBeVisible({ timeout: 30000 });
  await expect(exceptionSection).toContainText(`etsy:${exceptionReceiptId}`);
  await expect(exceptionSection).toContainText('Unknown SKU: UNKNOWN-SKU');
  
  await screenshots.capture(page, "001-etsy-exceptions-shown");

  // Step 4: Hide exception
  console.log("Hiding exception...");
  await page.locator('button', { hasText: 'Hide' }).first().click();
  await expect(exceptionSection).not.toBeVisible({ timeout: 10000 });
  
  await screenshots.capture(page, "002-etsy-exceptions-hidden");
});
