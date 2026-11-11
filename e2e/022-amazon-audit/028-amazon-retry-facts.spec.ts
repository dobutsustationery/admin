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
    handle = sellerId;
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
          status: "active",
          images: [],
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
          description: `Amifa retry tape ${at}`,
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
      name: "Amifa Amazon sync issues",
    });
    await screen.getByLabel("Search listings").fill(jan);
    const attention = screen.locator('details[data-issue="attention"]');
    await attention.locator("summary").click();
    await expect(
      attention.getByText(/Enter Amazon product details: Total tape/),
    ).toBeVisible();
    await attention
      .getByRole("button", { name: "Edit Amazon product details" })
      .click();
    await attention.getByLabel("Total tape / roll length (metres)").fill("4");
    await attention
      .getByRole("button", { name: "Save Amazon product details" })
      .click();
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
    expect(request.entries[0].body.attributes.unit_count[0]).toMatchObject({
      value: 4,
      type: { value: "meter" },
    });
    expect(
      request.entries[0].body.attributes.fulfillment_availability[0].quantity,
    ).toBe(8);
    const updates = await db
      .collection("broadcast")
      .where("type", "==", "update_item")
      .get();
    expect(
      updates.docs.filter((d) => d.data().payload?.id === jan),
    ).toHaveLength(1);
  } finally {
    await deleteApp(app);
  }
});
