import { test, expect } from "../fixtures/auth";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

test("Amazon order becomes ready without a second deduction and keeps quantities read-only", async ({
  authenticatedPage: page,
}) => {
  test.setTimeout(90000);
  process.env.FIRESTORE_EMULATOR_HOST ||= "localhost:18080";
  const at = Date.now();
  const jan = String(8600000000000 + (at % 1000000000));
  const sku = `${jan}Blue`;
  const id = `203-${String(at % 10000000).padStart(7, "0")}-1234567`;
  const app = initializeApp(
    { projectId: "demo-test-project" },
    `amazon-orders-${at}`,
  );
  const db = getFirestore(app);
  const order = {
    orderId: id,
    marketplaceId: "A1F83G8C2ARO7P",
    purchaseDate: new Date(at + 10).toISOString(),
    lastUpdatedDate: new Date(at + 20).toISOString(),
    status: "PENDING",
    latestShipDate: "",
    lines: [
      {
        id: "line",
        sku,
        title: `Amazon order test ${at}`,
        quantity: 1,
        quantityShipped: 0,
        quantityCancelled: 0,
        buyerRequestedCancel: false,
      },
    ],
  };
  const refs = [
    db.collection("broadcast").doc(`amazon-item-${at}`),
    db.collection("broadcast").doc(`amazon-pending-${at}`),
    db.collection("broadcast").doc(`amazon-ready-${at}`),
  ];
  try {
    await refs[0].set({
      type: "update_item",
      payload: {
        id: sku,
        item: {
          janCode: jan,
          subtype: "Blue",
          description: `Amazon order test ${at}`,
          qty: 5,
          shipped: 0,
          pieces: 1,
          image: "",
          hsCode: "",
        },
      },
      creator: "fixture",
      timestamp: Timestamp.fromMillis(at),
    });
    await refs[1].set({
      type: "amazon_order_reconciled",
      payload: { order, source: "reconcile" },
      creator: "fixture",
      timestamp: Timestamp.fromMillis(at + 30),
    });
    await page.goto("/orders");
    const row = page.getByRole("row").filter({ hasText: `amazon:${id}` });
    await expect(row).toContainText("Pending payment — do not ship");
    await refs[2].set({
      type: "amazon_order_reconciled",
      payload: {
        order: {
          ...order,
          status: "UNSHIPPED",
          lastUpdatedDate: new Date(at + 40).toISOString(),
        },
        source: "notification",
      },
      creator: "fixture",
      timestamp: Timestamp.fromMillis(at + 50),
    });
    await expect(row).toContainText("Ready to ship");
    await row.click();
    await expect(page.getByRole("status")).toHaveText("Amazon: Ready to ship");
    await expect(
      page.getByRole("link", { name: "Open order in Amazon Seller Central" }),
    ).toHaveAttribute(
      "href",
      `https://sellercentral.amazon.co.uk/orders-v3/order/${id}`,
    );
    await expect(
      page.getByRole("button", { name: "Cancel Order", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('input[type="number"]')).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath("amazon-order-ready.png"),
      fullPage: true,
    });
    await page.reload();
    await expect(page.getByRole("status")).toHaveText("Amazon: Ready to ship");
  } finally {
    for (const ref of refs) await ref.delete();
    await deleteApp(app);
  }
});
