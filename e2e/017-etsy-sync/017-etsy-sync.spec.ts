import { test, expect } from "../fixtures/auth";
import { createScreenshotHelper } from "../helpers/screenshot-helper";
import { waitForAppReady, waitForImages } from "../helpers/loading-helper";
import crypto from "crypto";

const ETSY_SECRET = "test_secret";

function computeHmac(payload: string, secret: string) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64");
}

test("Etsy Order Sync Flow", async ({ authenticatedPage: page, request }) => {
  test.setTimeout(120000);
  
  const screenshots = createScreenshotHelper();
  const janCode = "4902778133583";

  // Step 1: Check initial state
  page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text()));
  await page.goto("/inventory");
  await waitForAppReady(page);
  
  console.log("Waiting for inventory to initialize...");
  const rowLocator = page.locator('tr').filter({ has: page.locator('td', { hasText: janCode }) }).first();
  await expect(rowLocator).toBeVisible({ timeout: 30000 });
  
  const getShippedCell = () => rowLocator.locator('td').nth(7);
  
  const initialShippedText = await getShippedCell().innerText();
  const initialShipped = parseInt(initialShippedText) || 0;
  console.log(`Initial shipped value: ${initialShipped}`);
  
  await page.waitForLoadState('networkidle');
  await waitForAppReady(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await waitForImages(page);
  await screenshots.capture(page, "000-initial-inventory");

  // Step 2: Trigger etsy/receipt.created webhook
  const runId = Math.floor(Date.now() / 1000);
  const receiptId = `etsy-rec-${runId}`;
  const orderPayload = {
    event_type: "receipt.created",
    resource_data: {
      receipt_id: receiptId,
      create_timestamp: runId,
      status: "paid",
      buyer_email: "etsy-customer@example.com",
      transactions: [
        {
          transaction_id: `tx-${runId}`,
          sku: janCode,
          quantity: 3
        }
      ]
    }
  };
  const body = JSON.stringify(orderPayload);
  const signature = computeHmac(body, ETSY_SECRET);

  console.log("Sending Etsy receipt.created webhook...");
  const response = await request.post("http://localhost:15001/demo-test-project/us-central1/etsyOrderWebhook", {
    data: body,
    headers: {
      "Content-Type": "application/json",
      "x-etsy-signature": signature,
      "x-etsy-event-id": `evt-${runId}`
    }
  });

  if (!response.ok()) {
    console.log(`Webhook failed with status ${response.status()}: ${await response.text()}`);
  }
  expect(response.ok()).toBe(true);
  
  // Step 3: Verify UI update
  await expect(getShippedCell()).toHaveText(String(initialShipped + 3), { timeout: 30000 });
  
  await waitForAppReady(page);
  await waitForImages(page);
  await screenshots.capture(page, "001-after-etsy-order");

  // Step 4: Trigger update (cancellation)
  const updatedPayload = {
    event_type: "receipt.updated",
    resource_data: {
      ...orderPayload.resource_data,
      updated_timestamp: runId + 100,
      status: "canceled"
    }
  };
  const updatedBody = JSON.stringify(updatedPayload);
  const updatedSignature = computeHmac(updatedBody, ETSY_SECRET);

  console.log("Sending Etsy receipt.updated webhook (cancelled)...");
  const updatedResponse = await request.post("http://localhost:15001/demo-test-project/us-central1/etsyOrderWebhook", {
    data: updatedBody,
    headers: {
      "Content-Type": "application/json",
      "x-etsy-signature": updatedSignature,
      "x-etsy-event-id": `evt-upd-${runId}`
    }
  });

  expect(updatedResponse.ok()).toBe(true);

  // Step 5: Verify UI update (back to initial)
  await expect(getShippedCell()).toHaveText(String(initialShipped), { timeout: 30000 });
  
  await waitForAppReady(page);
  await waitForImages(page);
  await screenshots.capture(page, "002-after-etsy-cancel");

  // Step 6: Verify Exception UI
  // Trigger an order with unknown SKU
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
  await request.post("http://localhost:15001/demo-test-project/us-central1/etsyOrderWebhook", {
    data: exceptionBody,
    headers: {
      "Content-Type": "application/json",
      "x-etsy-signature": exceptionSignature,
      "x-etsy-event-id": `evt-exc-${runId}`
    }
  });

  await page.goto("/sync-status");
  await waitForAppReady(page);
  
  const exceptionSection = page.locator('section').filter({ has: page.locator('h2', { hasText: 'Etsy Order Sync Exceptions' }) });
  await expect(exceptionSection).toBeVisible({ timeout: 10000 });
  await expect(exceptionSection).toContainText(`etsy:${exceptionReceiptId}`);
  await expect(exceptionSection).toContainText('Unknown SKU: UNKNOWN-SKU');
  
  await screenshots.capture(page, "003-etsy-exceptions");
});
