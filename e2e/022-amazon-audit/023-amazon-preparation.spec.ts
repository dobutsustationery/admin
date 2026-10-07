import { test, expect } from "../fixtures/auth";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { initializeFirestore, Timestamp } from "firebase-admin/firestore";
import { createRequire } from "node:module";
const { createWorker } = createRequire(import.meta.url)(
  "../../functions/shared/amazon-preparation-worker.cjs",
);

test("prepare, leave an issue for later, and publish only the validated product", async ({
  page,
  authenticatedPage,
}, testInfo) => {
  void authenticatedPage;
  test.setTimeout(90000);
  const at = Date.now(),
    sellerId = `prepare-${at}`,
    marketplaceId = "A1F83G8C2ARO7P";
  const jan = String(8200000000000 + (at % 1000000000)),
    good = `${jan}Blue`,
    bad = `${jan}Green`;
  const app = initializeApp({ projectId: "demo-test-project" }, sellerId);
  const db = initializeFirestore(app, {
    host: `127.0.0.1:${process.env.E2E_FIRESTORE_EMULATOR_PORT || "8080"}`,
    ssl: false,
    preferRest: false,
  });
  const observation = (sku: string) => ({
    sku,
    summaries: [
      { asin: `ASIN${sku}`, productType: "STICKER_DECAL", status: ["BUYABLE"] },
    ],
    offers: [{ price: { currencyCode: "GBP", amount: 4 } }],
    fulfillmentAvailability: [
      { fulfillmentChannelCode: "DEFAULT", quantity: 2 },
    ],
  });
  const events = [
    ...[good, bad].map((key, i) => ({
      type: "update_item",
      payload: {
        id: key,
        item: {
          janCode: jan,
          subtype: i ? "Green" : "Blue",
          description: `Amifa preparation ${at}`,
          qty: 5,
          pieces: 1,
        },
      },
    })),
    {
      type: "amazonAudit/job",
      payload: {
        id: sellerId,
        sellerId,
        marketplaceId,
        mode: "catalogue",
        status: "complete",
        startedAt: at,
        updatedAt: at,
        pages: 1,
        count: 2,
      },
    },
    {
      type: "amazonAudit/chunk",
      payload: {
        responseId: sellerId,
        index: 0,
        json: JSON.stringify({ items: [observation(good), observation(bad)] }),
      },
    },
    {
      type: "amazonAudit/response",
      payload: {
        responseId: sellerId,
        chunks: 1,
        sellerId,
        marketplaceId,
        status: 200,
        at,
      },
    },
  ];
  const batch = db.batch();
  events.forEach((event, i) =>
    batch.set(db.collection("broadcast").doc(`${sellerId}-${i}`), {
      ...event,
      creator: "test",
      timestamp: Timestamp.fromMillis(at + i),
    }),
  );
  await batch.commit();
  const sent: string[] = [];
  const worker = createWorker({
    db,
    getConfig: () => ({ sellerId, marketplaceId }),
    getToken: async () => "test",
    read: async ({ sku }: any) => ({
      ok: true,
      status: 200,
      data: observation(sku),
    }),
    write: async ({ entry, preview }: any) => {
      if (!preview) sent.push(entry.sku);
      return {
        ok: true,
        status: 200,
        data: {
          status:
            entry.sku === bad ? "INVALID" : preview ? "VALID" : "ACCEPTED",
          issues:
            entry.sku === bad
              ? [
                  {
                    severity: "ERROR",
                    code: "8560",
                    message: "Missing product detail",
                  },
                ]
              : [],
        },
      };
    },
    enqueueReadback: async () => {},
    pause: async () => {},
  });
  const runRequest = async (mode: string) => {
    const requests = await db
      .collection("request_amazon_prepare")
      .where("sellerId", "==", sellerId)
      .get();
    const doc = requests.docs.find((d) => d.data().mode === mode);
    expect(doc).toBeTruthy();
    await worker.enqueue(doc!.id, doc!.data());
    await worker.tick();
    return doc!.data();
  };
  try {
    await page.goto("/amazon-listings");
    await page
      .getByRole("button", { name: "Prepare Amifa products for Amazon" })
      .click();
    const panel = page.getByRole("region", { name: "Prepare Amazon products" });
    await panel.getByLabel("Filter preparation").fill(String(at));
    const green = panel.locator("tbody tr").filter({ hasText: "Green" });
    await green.getByRole("button", { name: "Later", exact: true }).click();
    await expect(green).toHaveCount(0);
    await page.reload();
    await expect(panel.getByLabel("Filter preparation")).toHaveValue(
      String(at),
    );
    await panel.getByRole("button", { name: /Needs attention/ }).click();
    await expect(
      panel.getByText("Set aside in draft; apply choices to confirm.", {
        exact: true,
      }),
    ).toBeVisible();
    await panel.getByRole("button", { name: "Resume", exact: true }).click();
    await panel.getByRole("button", { name: /1. Prepare products/ }).click();
    const blue = panel.locator("tbody tr").filter({ hasText: "Blue" });
    await blue
      .getByLabel(`GBP price for ${good}`, { exact: true })
      .fill("4.50");
    await blue.getByLabel(`Include ${good}`, { exact: true }).uncheck();
    await panel.getByRole("button", { name: /Needs attention/ }).click();
    await page.goto("/inventory");
    await page.goto("/amazon-listings");
    await expect(
      panel.getByRole("button", { name: /Needs attention/ }),
    ).toHaveClass(/current/);
    await panel.getByRole("button", { name: /1. Prepare products/ }).click();
    await expect(
      blue.getByLabel(`GBP price for ${good}`, { exact: true }),
    ).toHaveValue("4.50");
    await expect(
      blue.getByLabel(`Include ${good}`, { exact: true }),
    ).not.toBeChecked();
    expect(
      (
        await db
          .collection("request_amazon_prepare")
          .where("sellerId", "==", sellerId)
          .get()
      ).size,
    ).toBe(0);
    await panel
      .getByRole("button", { name: "Discard draft", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Prepare Amifa products for Amazon" })
      .click();
    await panel.getByLabel("Filter preparation").fill(String(at));
    await expect(
      blue.getByLabel(`GBP price for ${good}`, { exact: true }),
    ).toHaveValue("");
    await expect(
      blue.getByLabel(`Include ${good}`, { exact: true }),
    ).toBeChecked();
    await blue
      .getByLabel(`GBP price for ${good}`, { exact: true })
      .fill("4.50");
    await panel
      .getByRole("button", { name: "Apply draft choices", exact: true })
      .click();
    await page.reload();
    await expect(
      blue.getByLabel(`GBP price for ${good}`, { exact: true }),
    ).toHaveValue("4.50");
    await expect(
      panel.getByRole("button", { name: "Apply draft choices", exact: true }),
    ).toBeDisabled();
    await panel
      .getByRole("button", {
        name: "Check 2 products with Amazon",
        exact: true,
      })
      .click();
    await expect(panel.getByRole("status")).toContainText(
      "Checking 2 products",
    );
    await runRequest("preview");
    await expect(
      panel.getByRole("button", { name: /2. Review and publish \(1 ready\)/ }),
    ).toBeVisible();
    const publish = panel.getByRole("button", {
      name: "Publish 1 ready products · leave issues for later",
      exact: true,
    });
    await expect(publish).toBeDisabled();
    await panel
      .getByRole("checkbox", { name: /I have checked these quantities/ })
      .check();
    await expect(publish).toBeEnabled();
    await publish.click();
    await expect(panel.getByRole("status")).toContainText(
      "Publishing requested for 1 products",
    );
    const request = await runRequest("publish");
    expect(request.jobIds).toHaveLength(1);
    expect(sent).toEqual([good]);
    const recorded = await db
      .collection("broadcast")
      .where("payload.sellerId", "==", sellerId)
      .get();
    const edits = recorded.docs
      .map((d) => d.data())
      .filter((d) => d.type.startsWith("amazonPrepare/draft"));
    expect(
      edits.some((d) => d.type === "amazonPrepare/draftDecisionChanged"),
    ).toBe(true);
    for (const e of edits) {
      expect(e.payload).not.toHaveProperty("draft");
      if (
        ["amazonPrepare/draftApplied", "amazonPrepare/draftDiscarded"].includes(
          e.type,
        )
      )
        expect(Object.keys(e.payload).sort()).toEqual([
          "owner",
          "revision",
          "sellerId",
          "token",
        ]);
      if (e.type === "amazonPrepare/draftDecisionChanged")
        expect(Object.keys(e.payload).sort()).toEqual([
          "field",
          "itemKey",
          "owner",
          "revision",
          "sellerId",
          "token",
          "value",
        ]);
    }

    await panel.getByRole("button", { name: /Needs attention/ }).click();
    await expect(
      panel.getByText("8560: Missing product detail", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("amazon-preparation-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: testInfo.outputPath("amazon-preparation-mobile.png"),
      fullPage: true,
    });
  } finally {
    await db.terminate();
    await deleteApp(app);
  }
});

test("one factor previews all prices before apply and survives reload", async ({
  page,
  authenticatedPage,
}) => {
  void authenticatedPage;
  const at = Date.now(),
    sellerId = `pricing-${at}`;
  const app = initializeApp({ projectId: "demo-test-project" }, sellerId);
  const db = initializeFirestore(app, {
    host: `127.0.0.1:${process.env.E2E_FIRESTORE_EMULATOR_PORT || "8080"}`,
    ssl: false,
    preferRest: false,
  });
  const keys = [`${at}1`, `${at}2`];
  const events = [
    ...keys.map((key, i) => ({
      type: "update_item",
      payload: {
        id: key,
        item: {
          janCode: key,
          description: `Amifa bulk pricing ${at}`,
          qty: 5,
          pieces: 1,
          price: i ? 10 : 5,
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
        count: 2,
      },
    },
    {
      type: "amazonAudit/chunk",
      payload: {
        responseId: sellerId,
        index: 0,
        json: JSON.stringify({
          items: keys.map((sku) => ({
            sku,
            summaries: [
              {
                asin: `ASIN${sku}`,
                status: ["BUYABLE"],
                productType: "STICKER_DECAL",
              },
            ],
            offers: [],
            fulfillmentAvailability: [
              { fulfillmentChannelCode: "DEFAULT", quantity: 2 },
            ],
          })),
        }),
      },
    },
    {
      type: "amazonAudit/response",
      payload: {
        responseId: sellerId,
        chunks: 1,
        sellerId,
        marketplaceId: "A1F83G8C2ARO7P",
        status: 200,
        at,
      },
    },
  ];
  try {
    const batch = db.batch();
    events.forEach((e, i) =>
      batch.set(db.collection("broadcast").doc(`${sellerId}-${i}`), {
        ...e,
        creator: "test",
        timestamp: Timestamp.fromMillis(at + i),
      }),
    );
    await batch.commit();
    await page.goto("/amazon-listings");
    const panel = page.getByRole("region", { name: "Prepare Amazon products" });
    await panel
      .getByRole("button", {
        name: "Prepare Amifa products for Amazon",
        exact: true,
      })
      .click();
    await panel.getByLabel("Filter preparation").fill(String(at));
    await panel
      .getByText("Set prices for products without an Amazon GBP price", {
        exact: true,
      })
      .click();
    await panel.getByLabel("GBP per EUR").fill("0.9");
    await expect(
      panel.getByText("Preview: £4.50", { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByText("Preview: £9.00", { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", {
        name: "Check 2 products with Amazon",
        exact: true,
      }),
    ).toBeDisabled();
    await page.reload();
    await expect(panel.getByLabel("GBP per EUR")).toHaveValue("0.9");
    await expect(
      panel.getByText("Preview: £9.00", { exact: true }),
    ).toBeVisible();
    expect(
      (
        await db
          .collection("request_amazon_prepare")
          .where("sellerId", "==", sellerId)
          .get()
      ).size,
    ).toBe(0);
    await panel
      .getByRole("button", { name: "Apply draft choices", exact: true })
      .click();
    await expect(
      panel.getByRole("button", {
        name: "Check 2 products with Amazon",
        exact: true,
      }),
    ).toBeEnabled();
    await expect(
      panel.getByText("Preview: £4.50", { exact: true }),
    ).toBeVisible();
  } finally {
    await deleteApp(app);
  }
});
