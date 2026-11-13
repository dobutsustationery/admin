import { test, expect } from "../fixtures/auth";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

test("complete a missing tape length and retry with metres without changing inventory", async ({
  authenticatedPage: page,
}) => {
  test.setTimeout(90000);
  process.env.FIRESTORE_EMULATOR_HOST ||= "localhost:18080";
  const at = Date.now(),
    sellerId = `retry-facts-${at}`,
    jan = String(8500000000000 + (at % 1000000000)),
    handle = sellerId,
    blue = `${jan}Blue`,
    pink = `${jan}Pink`;
  const app = initializeApp({ projectId: "demo-test-project" }, sellerId),
    db = getFirestore(app);
  const events = [
    {
      type: "create_listing",
      payload: {
        listing: {
          handle,
          title: `Amifa retry tape ${at}`,
          bodyHtml: "<p>Decorative paper tape.</p>",
          productCategory: "Arts & Crafts > Decorative Tape",
          vendor: "Amifa",
          option1Name: "Subtype",
          variantOptionsByItemId: { [blue]: "Blue", [pink]: "Pink" },
          status: "active",
          images: [],
          lastUpdated: at,
        },
      },
    },
    ...[
      [blue, "Blue"],
      [pink, "Pink"],
    ].map(([id, subtype]) => ({
      type: "update_item",
      payload: {
        id,
        item: {
          janCode: jan,
          subtype,
          handle,
          description: `Amifa retry tape ${at}`,
          qty: 8,
          shipped: 0,
          pieces: 1,
          price: 4,
        },
      },
    })),
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
    await screen.getByLabel("Search listings").fill(jan);
    const missing = screen.locator('details[data-issue="missing_data"]');
    await screen
      .getByRole("button", { name: "Missing product data (1)", exact: true })
      .click();
    await missing.locator("summary").click();
    await expect(missing.locator(".listing")).toHaveCount(1);
    await expect(missing.locator(".heading")).toContainText(`JAN ${jan}`);
    await expect(missing.locator(".missing-fields li")).toHaveCount(1);
    await expect(missing.locator(".missing-fields")).toContainText(
      "Total tape / roll length (metres)",
    );
    await expect(missing.locator(".missing-fields")).toContainText(
      "Blue · Pink",
    );
    await expect(
      missing.getByRole("button", { name: /Sync listing/ }),
    ).toHaveCount(0);
    await expect(screen.locator('details[data-issue="attention"]')).toHaveCount(
      0,
    );
    await missing.screenshot({
      path: test.info().outputPath("missing-product-data.png"),
    });
    await missing
      .getByRole("button", { name: "Edit Amazon product details" })
      .click();
    await missing
      .locator("fieldset")
      .filter({ has: page.getByText(`Blue · ${blue}`, { exact: true }) })
      .getByLabel("Total tape / roll length (metres)")
      .fill("4");
    await missing
      .getByRole("button", { name: "Save Amazon product details" })
      .click();
    await expect(missing.locator(".missing-fields")).toContainText("Pink");
    await expect(missing.locator(".missing-fields")).not.toContainText("Blue");
    await missing
      .getByRole("button", { name: "Edit Amazon product details" })
      .click();
    await missing
      .locator("fieldset")
      .filter({ has: page.getByText(`Pink · ${pink}`, { exact: true }) })
      .getByLabel("Total tape / roll length (metres)")
      .fill("6");
    await missing
      .getByRole("button", { name: "Save Amazon product details" })
      .click();
    await expect(missing).toHaveCount(0);
    const presence = screen.locator('details[data-issue="presence"]');
    await presence.locator("summary").click();
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
    const request = (
      await db
        .collection("request_amazon_prepare")
        .where("sellerId", "==", sellerId)
        .get()
    ).docs[0].data();
    for (const [sku, metres] of [
      [blue, 4],
      [pink, 6],
    ] as const) {
      const entry = request.entries.find((e: any) => e.sku === sku);
      expect(entry.body.attributes.unit_count[0]).toMatchObject({
        value: metres,
        type: { value: "meter" },
      });
      expect(entry.body.attributes.fulfillment_availability[0].quantity).toBe(
        8,
      );
    }
    const updates = await db
      .collection("broadcast")
      .where("type", "==", "update_item")
      .get();
    expect(
      updates.docs.filter((d) => [blue, pink].includes(d.data().payload?.id)),
    ).toHaveLength(2);
  } finally {
    await deleteApp(app);
  }
});
