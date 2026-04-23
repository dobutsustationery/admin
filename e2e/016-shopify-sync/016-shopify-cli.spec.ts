import { test, expect } from "@playwright/test";
import { waitForAppReady } from "../helpers/loading-helper";
import crypto from "crypto";

// Increase timeout for this specific test
test.setTimeout(120000);

test("Shopify CLI Webhook Flow", async ({ page }) => {
  // Capture console logs for debugging
  let listenerStarted = false;
  page.on('console', msg => {
    const text = msg.text();
    console.log(`BROWSER [${msg.type()}] ${text}`);
    if (text.includes("[Layout] Starting broadcast listener...")) {
      listenerStarted = true;
    }
  });

  // 1. Sign in using emulator REST API + localStorage injection
  console.log("Navigating to home to sign in...");
  await page.goto("/");
  await page.waitForLoadState('networkidle');

  const authEmulatorUrl = process.env.E2E_AUTH_EMULATOR_URL || "http://localhost:9099";
  const testEmail = `test-${Date.now()}@example.com`;
  const testPassword = "testpassword123";

  console.log("Creating test user in auth emulator...");
  const authResponse = await page.request.post(
    `${authEmulatorUrl}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-api-key`,
    {
      data: {
        email: testEmail,
        password: testPassword,
        displayName: "Test User",
        returnSecureToken: true,
      },
    },
  );

  if (!authResponse.ok()) {
    throw new Error(`Failed to create test user: ${authResponse.status()}`);
  }

  const authData = await authResponse.json();

  console.log("Injecting auth token into localStorage...");
  await page.evaluate((authInfo) => {
    const authKey = "firebase:authUser:demo-api-key:[DEFAULT]";
    localStorage.setItem(
      authKey,
      JSON.stringify({
        uid: authInfo.localId,
        email: authInfo.email,
        emailVerified: false,
        displayName: "Test User",
        isAnonymous: false,
        photoURL: null,
        providerData: [
          {
            providerId: "password",
            uid: authInfo.localId,
            displayName: "Test User",
            email: authInfo.email,
            phoneNumber: null,
            photoURL: null,
          },
        ],
        stsTokenManager: {
          refreshToken: authInfo.refreshToken,
          accessToken: authInfo.idToken,
          expirationTime: Date.now() + 3600000,
        },
        createdAt: String(Date.now()),
        lastLoginAt: String(Date.now()),
        apiKey: "demo-api-key",
        appName: "[DEFAULT]",
      }),
    );
  }, authData);

  console.log("Reloading page to apply auth...");
  await page.reload({ waitUntil: "load" });
  await page.waitForLoadState('networkidle');

  // Wait for the Sign In button to disappear as a sign of successful login
  const signInButton = page.locator("button:has-text('Sign In')");
  await signInButton.waitFor({ state: "hidden", timeout: 20000 }).catch(() => {
    console.log("Sign-in button still visible after reload");
  });

  // 2. Wait for broadcast listener to start
  console.log("Waiting for broadcast listener to start...");
  const startTime = Date.now();
  while (!listenerStarted && Date.now() - startTime < 30000) {
    await page.waitForTimeout(1000);
  }
  
  if (!listenerStarted) {
    console.log("WARNING: Broadcast listener did not start within 30s. Proceeding anyway...");
  } else {
    console.log("✓ Broadcast listener started");
  }

  // 3. Navigate to Sync Status page
  console.log("Navigating to Sync Status page...");
  await page.goto("/sync-status");
  await waitForAppReady(page);
  await page.waitForLoadState('networkidle');

  const topics = ["orders/create", "orders/updated", "orders/cancelled", "refunds/create"];
  const webhookUrl = "http://localhost:15001/demo-test-project/us-central1/shopifyOrderWebhook";
  const clientSecret = "test_secret"; // Default from functions/index.js
  const orderID = `mock-order-${Date.now()}`;

  for (const topic of topics) {
    console.log(`Triggering ${topic} webhook for ${orderID}...`);
    
    // Construct mock payload
    const payloadObj = {
      id: orderID,
      order_id: orderID, // For refunds
      topic,
      line_items: [{ id: `li-${topic.replace("/", "-")}`, sku: "", quantity: 1 }],
      refund_line_items: [{ line_item_id: `li-orders-create`, quantity: 1 }] // For refunds
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
      console.log(`✓ Triggered ${topic} successfully`);
    } else {
      console.error(`✗ Failed to trigger ${topic}: ${response.status()} ${await response.text()}`);
    }
  }

  // 4. Wait for exceptions to appear on the page
  console.log("Waiting for exceptions to appear on Sync Status page...");
  const exceptionsSection = page.locator(".exceptions-section");
  
  // Wait up to 60 seconds for the exceptions to appear
  await expect(exceptionsSection).toBeVisible({ timeout: 60000 });

  // 5. Verify specific exception content
  const exceptionText = await exceptionsSection.textContent() || "";
  console.log(`Exceptions found: ${exceptionText}`);
  
  expect(exceptionText).toContain(`shopify:${orderID}`);
  expect(exceptionText).toContain("Unknown SKU");
});
