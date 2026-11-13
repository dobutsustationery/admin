import { test, expect } from "../fixtures/auth";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

test("map categories and queue individual or bulk issue-specific Amazon updates", async ({
  authenticatedPage: page,
}) => {
  test.setTimeout(90000);
  await page.route("https://example.com/*.png", (route) =>
    route.fulfill({
      path: "e2e/test-images/006ccee443ad388aa0799f9d6d97290f.jpg",
      contentType: "image/jpeg",
    }),
  );
  process.env.FIRESTORE_EMULATOR_HOST ||= "localhost:18080";
  const at = Date.now(),
    sellerId = `issue-sync-${at}`,
    jan = String(8400000000000 + (at % 1000000000)),
    handle = sellerId;
  const app = initializeApp({ projectId: "demo-test-project" }, sellerId),
    db = getFirestore(app);
  const category = "Arts & Crafts > Scrapbooking Paper";
  const raw = {
    sku: jan,
    attributes: {
      brand: [{ value: "Amifa" }],
      item_name: [{ value: "Old name" }],
      main_product_image_locator: [
        { media_location: "https://example.com/old.png" },
      ],
      fulfillment_availability: [
        { fulfillment_channel_code: "DEFAULT", quantity: 2 },
      ],
      purchasable_offer: [
        {
          marketplace_id: "A1F83G8C2ARO7P",
          currency: "GBP",
          our_price: [{ schedule: [{ value_with_tax: 99 }] }],
        },
      ],
    },
    summaries: [
      { asin: "B0TESTASIN", productType: "SHEET_PAPER", status: ["BUYABLE"] },
    ],
    offers: [{ price: { currencyCode: "GBP", amount: 99 } }],
    fulfillmentAvailability: [
      { fulfillmentChannelCode: "DEFAULT", quantity: 2 },
    ],
  };
  const events: any[] = [
    {
      type: "create_listing",
      payload: {
        listing: {
          handle,
          title: `Amifa sync paper ${at}`,
          bodyHtml: "<p>Japanese paper.</p>",
          productCategory: category,
          productType: "Paper",
          vendor: "Amifa",
          tags: [],
          status: "active",
          option1Name: "Title",
          images: [
            { id: "paper", url: "https://example.com/paper.png", position: 1 },
          ],
          lastUpdated: at,
        },
      },
    },
    {
      type: "update_item",
      payload: {
        id: jan,
        item: {
          janCode: jan,
          handle,
          image: "https://example.com/paper.png",
          description: `Amifa sync paper ${at}`,
          qty: 8,
          shipped: 0,
          pieces: 1,
          price: 4,
        },
      },
    },
    {
      type: "amazonAudit/job",
      payload: {
        id: sellerId,
        sellerId,
        marketplaceId: "A1F83G8C2ARO7P",
        mode: "catalogue",
        status: "complete",
        startedAt: at,
        updatedAt: at,
        pages: 1,
        count: 1,
      },
    },
    {
      type: "amazonAudit/chunk",
      payload: { responseId: sellerId, index: 0, json: JSON.stringify(raw) },
    },
    {
      type: "amazonAudit/response",
      payload: {
        responseId: sellerId,
        sellerId,
        marketplaceId: "A1F83G8C2ARO7P",
        sku: jan,
        status: 200,
        chunks: 1,
        at,
      },
    },
    {
      type: "amazonPrepare/decision",
      payload: {
        sellerId,
        itemKey: jan,
        decision: { priceGBP: "99", productType: "OTHER" },
      },
    },
  ];
  const batch = db.batch();
  events.forEach((event, i) =>
    batch.set(db.collection("broadcast").doc(`${sellerId}-${i}`), {
      ...event,
      creator: "browser-fixture",
      timestamp: Timestamp.fromMillis(at + i),
    }),
  );
  await batch.commit();
  try {
    await page.goto("/amazon-listings");
    const screen = page.getByRole("region", {
      name: "Amazon sync issues",
    });
    await expect(screen).toBeVisible();
    await screen.getByLabel("Search listings").fill(jan);
    const filters = screen.getByRole("navigation", {
      name: "Filter Amazon sync issues",
    });
    await expect(filters).toBeVisible();
    await expect(
      filters.getByRole("button", { name: /^Variant image/ }),
    ).toHaveCount(0);
    await filters
      .getByRole("button", { name: "Inventory quantity (1)", exact: true })
      .click();
    await expect(screen.locator("details[data-issue]")).toHaveCount(1);
    await expect(
      filters.getByRole("button", {
        name: "Inventory quantity (1)",
        exact: true,
      }),
    ).toHaveAttribute("aria-pressed", "true");
    const quantity = screen.locator('details[data-issue="quantity"]');
    await quantity.locator("summary").click();
    await expect(
      quantity.getByText(`Amifa sync paper ${at}`, { exact: true }),
    ).toBeVisible();
    await quantity
      .getByRole("button", { name: "Sync listing", exact: true })
      .click();
    await expect(screen.getByRole("status")).toContainText("sync queued");
    const requests = () =>
      db
        .collection("request_amazon_prepare")
        .where("sellerId", "==", sellerId)
        .get();
    await expect.poll(async () => (await requests()).size).toBe(1);
    const qty = (await requests()).docs[0].data();
    expect(qty.mode).toBe("sync");
    expect(qty.entries).toHaveLength(1);
    expect(qty.entries[0].syncIssue).toBe("all");
    const patches = qty.entries[0].body.patches;
    expect(
      patches.find(
        (p: any) => p.path === "/attributes/fulfillment_availability",
      ).value[0].quantity,
    ).toBe(8);
    expect(
      patches.find((p: any) => p.path === "/attributes/purchasable_offer")
        .value[0].our_price[0].schedule[0].value_with_tax,
    ).toBe(4);
    expect(patches.some((p: any) => p.path === "/attributes/item_name")).toBe(
      true,
    );
    expect(patches.some((p: any) => /image_locator/.test(p.path))).toBe(false);
    await expect(
      quantity.getByRole("button", { name: "Sync listing", exact: true }),
    ).toBeDisabled();
    await filters
      .getByRole("button", { name: "All listings (1)", exact: true })
      .click();
    await expect(
      screen.locator('details[data-issue="variant_image"] summary'),
    ).toHaveCount(0);
    await expect(
      screen.locator('details[data-issue="offer_unchecked"] summary'),
    ).toContainText("1 listing(s)");
    await screen
      .getByRole("link", { name: "Amazon category mappings and exchange rate" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Amazon categories", exact: true }),
    ).toBeVisible();
    const row = page.locator("tbody tr").filter({
      has: page.getByLabel(`Product type for ${category}`, { exact: true }),
    });
    await expect(
      row.getByLabel(`Product type for ${category}`, { exact: true }),
    ).toHaveValue("SHEET_PAPER");
    await expect(row.getByText("Suggested", { exact: true })).toBeVisible();
    await row
      .getByLabel(`Product type for ${category}`, { exact: true })
      .fill("STICKER_DECAL");
    await row
      .getByRole("button", { name: "Save mapping", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("saved");
    await page.reload();
    await expect(
      page.getByLabel(`Product type for ${category}`, { exact: true }),
    ).toHaveValue("STICKER_DECAL");
    await page.getByLabel("GBP per EUR", { exact: true }).fill("1.2");
    await page
      .getByRole("button", { name: "Save exchange rate", exact: true })
      .click();
    await expect(
      page.getByText("Exchange rate saved.", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByText("Current rate: 1.2.", { exact: false }),
    ).toBeVisible();
  } finally {
    await deleteApp(app);
  }
});
