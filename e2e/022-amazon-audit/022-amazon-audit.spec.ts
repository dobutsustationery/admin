import { test, expect } from "../fixtures/auth";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { initializeFirestore, Timestamp } from "firebase-admin/firestore";

test("Amifa audit filters, maps SKUs and queues read-only refreshes", async ({
  page,
  authenticatedPage,
}, testInfo) => {
  void authenticatedPage;
  test.setTimeout(90000);
  const stamp = Date.now(),
    jan = String(8100000000000 + (stamp % 1000000000));
  const blue = `${jan}Blue`,
    green = `${jan}Green`,
    title = `Amifa browser audit ${stamp}`;
  const app = initializeApp(
    { projectId: "demo-test-project" },
    `audit-${stamp}`,
  );
  const db = initializeFirestore(app, {
    host: `127.0.0.1:${process.env.E2E_FIRESTORE_EMULATOR_PORT || "8080"}`,
    ssl: false,
    preferRest: false,
  });
  const sellerId = `seller-${stamp}`,
    marketplaceId = "A1F83G8C2ARO7P";
  const events = [
    ...[blue, green].map((key, i) => ({
      type: "update_item",
      payload: {
        id: key,
        item: {
          janCode: jan,
          subtype: i ? "Green" : "Blue",
          description: title,
          qty: 5,
          pieces: 1,
        },
      },
    })),
    {
      type: "amazonAudit/job",
      payload: {
        id: `audit-${stamp}`,
        sellerId,
        marketplaceId,
        mode: "catalogue",
        status: "complete",
        startedAt: stamp,
        updatedAt: stamp,
        pages: 1,
        count: 1,
      },
    },
    {
      type: "amazonAudit/chunk",
      payload: {
        responseId: `page-${stamp}`,
        index: 0,
        json: JSON.stringify({
          items: [
            {
              sku: blue,
              summaries: [{ asin: "B000TEST", status: ["BUYABLE"] }],
              offers: [{ price: { amount: 4, currencyCode: "GBP" } }],
              fulfillmentAvailability: [
                { fulfillmentChannelCode: "DEFAULT", quantity: 3 },
              ],
            },
          ],
        }),
      },
    },
    {
      type: "amazonAudit/response",
      payload: {
        responseId: `page-${stamp}`,
        chunks: 1,
        sellerId,
        marketplaceId,
        at: stamp,
        status: 200,
      },
    },
  ];
  const batch = db.batch();
  events.forEach((event, i) =>
    batch.set(db.collection("broadcast").doc(`audit-${stamp}-${i}`), {
      ...event,
      creator: "browser-fixture",
      timestamp: Timestamp.fromMillis(stamp + i),
    }),
  );
  await batch.commit();
  try {
    await page.goto("/amazon-listings");
    await expect(
      page.getByRole("heading", { name: "Amazon · Amifa catalogue" }),
    ).toBeVisible();
    await page.getByLabel("Find products").fill(title);
    const family = page.locator("details.family").filter({ hasText: title });
    await expect(family).toBeVisible();
    await expect(family.getByRole("cell", { name: /^GBP 4/ })).toBeVisible();
    await expect(family.getByText("Not linked", { exact: true })).toBeVisible();
    await page
      .getByRole("combobox", { name: "Status", exact: true })
      .selectOption("Not linked");
    const row = family.locator("tbody tr");
    await expect(row).toHaveCount(1);
    await row
      .getByLabel("Seller SKU", { exact: true })
      .fill(`remote-green-${stamp}`);
    await row.getByRole("button", { name: "Save mapping" }).click();
    await page
      .getByRole("combobox", { name: "Status", exact: true })
      .selectOption("All");
    await expect(
      family.getByText("Saved mapping", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Select filtered" }).click();
    await page.getByRole("button", { name: "Refresh selected SKUs" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Refresh requested" }),
    ).toBeVisible();
    const requests = await db
      .collection("request_amazon_audit")
      .where("skus", "array-contains", `remote-green-${stamp}`)
      .get();
    expect(requests.size).toBe(1);
    expect(requests.docs[0].data().mode).toBe("selected");
    await page.reload();
    await page.getByLabel("Find products").fill(title);
    await expect(
      page
        .locator("tbody tr")
        .filter({ hasText: "Green" })
        .getByLabel("Seller SKU", { exact: true }),
    ).toHaveValue(`remote-green-${stamp}`);
    await page.screenshot({
      path: testInfo.outputPath("amifa-audit-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("button", { name: "Refresh seller catalogue" }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("amifa-audit-mobile.png"),
      fullPage: true,
    });
    await page.locator("details.diagnostics > summary").click();
    await expect(
      page.getByRole("heading", { name: "Amazon diagnostics", exact: true }),
    ).toBeVisible();
  } finally {
    await db.terminate();
    await deleteApp(app);
  }
});
