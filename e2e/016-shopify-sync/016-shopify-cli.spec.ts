import { test, expect } from "../fixtures/auth";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

test("Shopify CLI Webhook Flow", async ({ authenticatedPage: page }) => {
  test.setTimeout(60000);

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

  // 3. Trigger the webhook using Shopify CLI
  console.log("Triggering orders/create webhook via Shopify CLI...");
  // Note: We use --client-id because the CLI requires it when an app config is present
  const command = [
    "npx @shopify/cli app webhook trigger",
    "--topic orders/create",
    "--address http://localhost:15001/demo-test-project/us-central1/shopifyOrderWebhook",
    "--client-secret test_secret",
    "--client-id dummy-id",
    "--api-version 2026-01"
  ].join(" ");

  try {
    // We expect this might fail in some CI environments if it tries to login,
    // but here we are providing all the flags.
    execSync(command, { stdio: "inherit" });
  } catch (error) {
    console.error("Error running Shopify CLI webhook trigger:", error);
    // We don't fail here yet, because we want to see if the webhook arrived anyway
  }

  // 4. Verify that the exception was logged in state.shopifyExceptions
  // Since the CLI uses a dummy payload (e.g. with dummy SKUs), it is expected
  // that the system cannot find the item and registers a Shopify Exception.
  const hasExceptions = await page.evaluate(() => {
    return new Promise((resolve) => {
      // Poll until an exception appears in the state
      const interval = setInterval(() => {
        const store = (window as any).store;
        if (store) {
          const state = store.getState();
          const exceptions = state.inventory?.shopifyExceptions || {};
          if (Object.keys(exceptions).length > 0) {
            clearInterval(interval);
            resolve(true);
          }
        }
      }, 500);

      // Timeout after 20s
      setTimeout(() => {
        clearInterval(interval);
        resolve(false);
      }, 20000);
    });
  });

  // If the CLI failed due to login, this might fail, but that's expected in some environments.
  // We want the test to be there as requested.
  expect(hasExceptions).toBe(true);
});
