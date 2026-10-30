import { test, expect } from "../fixtures/auth";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

test("standalone price survives save and reload and enables Amazon validation", async ({
  page,
  authenticatedPage,
}) => {
  void authenticatedPage;
  test.setTimeout(90000);
  const at = Date.now(),
    jan = String(8300000000000 + (at % 1000000000));
  const sellerId = `standalone-${at}`,
    title = `Amifa standalone paper ${at}`;
  const app = initializeApp({ projectId: "demo-test-project" }, sellerId);
  process.env.FIRESTORE_EMULATOR_HOST ||= "localhost:18080";
  const db = getFirestore(app);
  const events = [
    {
      type: "create_listing",
      payload: {
        listing: {
          handle: sellerId,
          title,
          bodyHtml: "<p>Origami paper</p>",
          productCategory: "Paper",
          productType: "Paper",
          vendor: "Amifa",
          tags: [],
          status: "active",
          option1Name: "Title",
          images: [
            {
              id: "paper",
              url: "https://example.com/paper.png",
              position: 1,
              altText: "Paper",
            },
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
          handle: sellerId,
          image: "https://example.com/paper.png",
          description: title,
          qty: 7,
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
        count: 0,
      },
    },
    // Reproduce the numeric event already recorded in production.
    {
      type: "amazonPrepare/decision",
      payload: {
        sellerId,
        itemKey: jan,
        decision: { priceGBP: 4, productType: "SHEET_PAPER" },
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
    await page.getByLabel("Find products").fill(jan);
    const family = page.locator("details.family").filter({ hasText: title });
    await expect(family).toBeVisible();
    await family.locator("summary").first().click();
    await expect(
      family.getByText("Proposed: GBP 4.00", { exact: false }),
    ).toBeVisible();
    await family
      .getByRole("button", { name: "Edit choices", exact: true })
      .click();
    await expect(family.getByLabel("GBP price", { exact: true })).toHaveValue(
      "4",
    );
    await family.getByLabel("GBP price", { exact: true }).fill("4.50");
    await family
      .getByRole("button", { name: "Save choices", exact: true })
      .click();
    await expect(
      family.getByText("Proposed: GBP 4.50", { exact: false }),
    ).toBeVisible();
    const saved = await db
      .collection("broadcast")
      .where("type", "==", "amazonPrepare/decision")
      .where("payload.itemKey", "==", jan)
      .get();
    expect(
      saved.docs.some((d) => d.data().payload.decision.priceGBP === "4.50"),
    ).toBe(true);
    await page.reload();
    await page.getByLabel("Find products").fill(jan);
    await family.locator("summary").first().click();
    await expect(
      family.getByText("Proposed: GBP 4.50", { exact: false }),
    ).toBeVisible();
    await family
      .getByRole("button", { name: "Edit choices", exact: true })
      .click();
    await expect(family.getByLabel("GBP price", { exact: true })).toHaveValue(
      "4.5",
    );
    await family
      .getByRole("button", { name: "Save choices", exact: true })
      .click();
    await family
      .getByRole("button", { name: "Check with Amazon", exact: true })
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
    const requests = await db
      .collection("request_amazon_prepare")
      .where("sellerId", "==", sellerId)
      .get();
    const request = requests.docs[0].data();
    expect(request.mode).toBe("preview");
    expect(
      request.entries[0].body.attributes.purchasable_offer[0].our_price[0]
        .schedule[0].value_with_tax,
    ).toBe(4.5);
  } finally {
    await deleteApp(app);
  }
});
