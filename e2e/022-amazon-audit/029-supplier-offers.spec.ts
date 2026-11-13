import { test, expect } from "../fixtures/auth";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

test("prepare supplier offers on the main screen and sync individually or in bulk", async ({
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
    sellerId = `supplier-offers-${at}`;
  const app = initializeApp({ projectId: "demo-test-project" }, sellerId),
    db = getFirestore(app);
  const products = ["Uni", "Zebra", "Pilot"].map((brand, i) => ({
    brand,
    jan: String(8700000000000 + (at % 1000000000) + i),
    handle: `supplier-${at}-${i}`,
    asin: `B01234567${i}`,
  }));
  const events: any[] = [];
  for (const p of products) {
    events.push({
      type: "create_listing",
      payload: {
        listing: {
          handle: p.handle,
          title: `${p.brand} Supplier demo ${at}`,
          vendor: "Dobutsu",
          bodyHtml: "<p>Pen.</p>",
          productCategory: "Unmapped",
          status: "active",
          images: [{ url: "https://example.com/local.png", position: 1 }],
          lastUpdated: at,
        },
      },
    });
    events.push({
      type: "update_item",
      payload: {
        id: p.jan,
        item: {
          janCode: p.jan,
          subtype: "",
          handle: p.handle,
          description: `${p.brand} Supplier demo ${at}`,
          qty: 4,
          shipped: 0,
          pieces: 1,
          price: 5,
          image: "https://example.com/local.png",
        },
      },
    });
  }
  events.push({
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
      count: 0,
    },
  });
  events.push({
    type: "amazonCatalog/apply_probe_chunk",
    payload: {
      requestId: sellerId,
      mode: "jan_probe",
      sellerId,
      marketplaceId: "A1F83G8C2ARO7P",
      responses: products.map((p) => ({
        id: p.jan,
        kind: "catalog_search_by_jan",
        key: p.jan,
        sellerId,
        marketplaceId: "A1F83G8C2ARO7P",
        ok: true,
        status: 200,
        fetchedAtMs: at,
        raw: {
          items: [
            {
              asin: p.asin,
              summaries: [
                { itemName: `${p.brand} Amazon demo`, brand: p.brand },
              ],
              images: [
                {
                  marketplaceId: "A1F83G8C2ARO7P",
                  images: [
                    {
                      variant: "MAIN",
                      link: "https://example.com/amazon.png",
                      width: 100,
                      height: 100,
                    },
                  ],
                },
              ],
            },
          ],
        },
      })),
    },
  });
  const batch = db.batch();
  events.forEach((e, i) =>
    batch.set(db.collection("broadcast").doc(`${sellerId}-${i}`), {
      ...e,
      creator: "fixture",
      timestamp: Timestamp.fromMillis(at + i),
    }),
  );
  await batch.commit();
  try {
    await page.goto("/amazon-listings");
    const screen = page.getByRole("region", { name: "Amazon sync issues" });
    await screen.getByLabel("Search listings").fill(String(at));
    await screen.getByRole("button", { name: /^Pilot \(/ }).click();
    await expect(screen).toContainText(
      "Pilot approval is still to be verified",
    );
    await screen.getByRole("button", { name: /^All brands \(/ }).click();
    await screen
      .getByRole("button", { name: "Prepare offers (3 listings)", exact: true })
      .click();
    const editor = screen.getByRole("region", {
      name: "Prepare existing Amazon offers",
    });
    await expect(editor.locator("fieldset")).toHaveCount(3);
    for (const p of products) {
      const variant = editor
        .locator("fieldset")
        .filter({ hasText: `${p.brand} Supplier demo ${at}` });
      await expect(
        variant.getByLabel("Existing ASIN", { exact: true }),
      ).toHaveValue(p.asin);
      await variant.getByRole("checkbox").check();
      if (p.brand === "Uni") {
        await variant
          .getByLabel("Existing ASIN", { exact: true })
          .fill("B099999999");
        await expect(variant.getByRole("checkbox")).not.toBeChecked();
        await variant.getByLabel("Existing ASIN", { exact: true }).fill(p.asin);
        await variant.getByRole("checkbox").check();
      }
    }
    await editor.getByRole("button", { name: "Save offer choices" }).click();
    await expect(editor.getByRole("status")).toContainText("Choices saved");
    await screen.getByRole("button", { name: /^Zebra \(/ }).click();
    const presence = screen.locator('details[data-issue="presence"]');
    await presence.locator("summary").click();
    await expect(presence).toContainText(products[1].asin);
    await expect(presence).toContainText("GBP 5.00");
    await presence
      .getByRole("button", { name: "Sync listing", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (
            await db
              .collection("request_amazon_prepare")
              .where("sellerId", "==", sellerId)
              .get()
          ).size,
      )
      .toBe(1);
    const first = (
      await db
        .collection("request_amazon_prepare")
        .where("sellerId", "==", sellerId)
        .get()
    ).docs[0].data();
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0].sku).toBe(products[1].jan);
    await screen.getByRole("button", { name: /^All brands \(/ }).click();
    await screen
      .getByRole("button", { name: /^Sync all listings with changes/ })
      .click();
    await expect
      .poll(
        async () =>
          (
            await db
              .collection("request_amazon_prepare")
              .where("sellerId", "==", sellerId)
              .get()
          ).size,
      )
      .toBe(2);
    const requests = (
      await db
        .collection("request_amazon_prepare")
        .where("sellerId", "==", sellerId)
        .get()
    ).docs.map((d) => d.data());
    expect(
      new Set(requests.flatMap((r) => r.entries.map((e: any) => e.sku))).size,
    ).toBe(3);
    for (const r of requests)
      for (const e of r.entries) {
        expect(e.body.requirements).toBe("LISTING_OFFER_ONLY");
        expect(e.body.productType).toBe("PRODUCT");
        expect(Object.keys(e.body.attributes).sort()).toEqual([
          "condition_type",
          "fulfillment_availability",
          "merchant_suggested_asin",
          "purchasable_offer",
        ]);
        expect(e.body.attributes.fulfillment_availability[0].quantity).toBe(4);
        expect(
          e.body.attributes.purchasable_offer[0].our_price[0].schedule[0]
            .value_with_tax,
        ).toBe(5);
      }
    await screen.screenshot({
      path: test.info().outputPath("supplier-offers-main-screen.png"),
    });
  } finally {
    await deleteApp(app);
  }
});
