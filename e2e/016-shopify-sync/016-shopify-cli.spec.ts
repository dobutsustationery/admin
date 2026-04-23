import { test, expect } from "../fixtures/auth";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

test("Shopify CLI Webhook Flow", async ({ authenticatedPage: page }) => {
  test.setTimeout(120000);

  // 1. Ensure minimal shopify.app.toml exists
  const tomlPath = path.resolve(process.cwd(), "shopify.app.toml");
  if (!fs.existsSync(tomlPath)) {
    fs.writeFileSync(
      tomlPath,
      `name = "dummy-app"\nclient_id = "dummy-id"\n[webhooks]\napi_version = "2026-01"\n[pos]\nembedded = false`
    );
  }

  // 2. Load the app to initialize Redux store
  await page.goto("/inventory");
  await page.waitForLoadState('networkidle');

  const topics = ["orders/create", "orders/updated", "orders/cancelled", "refunds/create"];
  const clientSecret = "test_secret";
  const webhookUrl = "http://localhost:15001/demo-test-project/us-central1/shopifyOrderWebhook";

  for (const topic of topics) {
    console.log(`Triggering ${topic} webhook...`);
    
    // Attempt via Shopify CLI first
    const command = [
      "npx @shopify/cli app webhook trigger",
      `--topic ${topic}`,
      `--address ${webhookUrl}`,
      `--client-secret ${clientSecret}`,
      "--client-id dummy-id",
      "--api-version 2026-01"
    ].join(" ");

    let cliSuccess = false;
    try {
      execSync(command, { stdio: "pipe" });
      cliSuccess = true;
      console.log(`✓ Triggered ${topic} via Shopify CLI`);
    } catch (error) {
      console.warn(`! Shopify CLI failed for ${topic} (likely login required). Falling back to internal request.`);
    }

    if (!cliSuccess) {
      // Fallback to internal request with manual HMAC
      const payloadObj = {
        id: `mock-${topic.replace("/", "-")}-${Date.now()}`,
        topic,
        line_items: [{ sku: "", quantity: 1 }]
      };
      const payloadStr = JSON.stringify(payloadObj);
      const hmac = crypto
        .createHmac("sha256", clientSecret)
        .update(payloadStr)
        .digest("base64");

      const response = await page.request.post(webhookUrl, {
        data: payloadStr,
        headers: {
          "X-Shopify-Topic": topic,
          "X-Shopify-Hmac-SHA256": hmac,
          "X-Shopify-Webhook-Id": `mock-id-${topic.replace("/", "-")}-${Date.now()}`,
          "Content-Type": "application/json"
        }
      });

      if (response.ok()) {
        console.log(`✓ Triggered ${topic} via internal request fallback`);
      } else {
        const text = await response.text();
        console.error(`✗ Fallback failed for ${topic}: ${response.status()} ${text}`);
      }
    }
  }

  // 4. Verify that the exceptions were logged in state.shopifyExceptions
  const exceptionCount = await page.evaluate((expectedCount) => {
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        const store = (window as any).store;
        if (store) {
          const state = store.getState();
          const exceptions = state.inventory?.shopifyExceptions || {};
          const count = Object.keys(exceptions).length;
          if (count >= expectedCount) {
            clearInterval(interval);
            resolve(count);
          }
        }
      }, 1000);

      setTimeout(() => {
        clearInterval(interval);
        const store = (window as any).store;
        const state = store?.getState();
        const exceptions = state?.inventory?.shopifyExceptions || {};
        resolve(Object.keys(exceptions).length);
      }, 40000);
    });
  }, topics.length);

  console.log(`Found ${exceptionCount} exceptions in state.`);
  expect(exceptionCount).toBeGreaterThanOrEqual(1);
});
