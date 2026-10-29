import { test, expect } from "../fixtures/auth";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

process.env.FIRESTORE_EMULATOR_HOST ||= "localhost:18080";
const app =
  getApps().find((a) => a.name === "etsy-listings-browser") ||
  initializeApp({ projectId: "demo-test-project" }, "etsy-listings-browser");
const db = getFirestore(app);

test("Etsy mismatch categories, explicit review, quantity request and reload", async ({
  authenticatedPage: page,
}) => {
  test.setTimeout(60000);
  await db
    .collection("etsy_listing_catalog")
    .doc("90001")
    .set({
      listingId: "90001",
      shopId: "test",
      title: "Test Etsy Pens",
      description: "Old description",
      state: "active",
      currency: "EUR",
      url: "https://www.etsy.com/listing/90001",
      images: [],
      inventoryError: "",
      observedAtMs: 1,
      inventory: {
        products: [
          {
            product_id: 11,
            sku: "4901234567890Blue",
            property_values: [{ values: ["Blue"] }],
            offerings: [
              {
                quantity: 8,
                is_enabled: true,
                price: { amount: 450, divisor: 100 },
              },
            ],
          },
        ],
      },
    });
  await db
    .collection("etsy_listing_sync")
    .doc("state")
    .set({ listingIds: ["90001"], currency: "EUR", completedAtMs: 1 });
  await page.goto("/etsy-listings");
  await expect(
    page.getByRole("heading", { name: "Etsy listings", exact: true }),
  ).toBeVisible();
  await page.waitForFunction(
    () => !!(window as any).store?.getState()?.inventory,
  );
  async function localState(zeroStock = false) {
    await expect(page.locator(".loading-overlay")).not.toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Etsy listings", exact: true }),
    ).toBeVisible();
    await page.evaluate((zeroStock) => {
      const store = (window as any).store,
        state = store.getState();
      store.dispatch({
        type: "HYDRATE",
        payload: {
          ...state,
          inventory: {
            ...state.inventory,
            initialized: true,
            idToItem: {
              "4901234567890Blue": {
                janCode: "4901234567890",
                subtype: "Blue",
                description: "Test Local Pens",
                qty: zeroStock ? 0 : 5,
                shipped: zeroStock ? 0 : 2,
                price: 4,
                image: "",
                handle: "test-etsy-pens",
              },
            },
          },
          listings: {
            ...state.listings,
            idToHandle: { "4901234567890Blue": "test-etsy-pens" },
            handleToListing: {
              "test-etsy-pens": {
                handle: "test-etsy-pens",
                title: "Test Local Pens",
                bodyHtml: "<p>New description</p>",
                status: "active",
                images: [],
              },
            },
          },
        },
      });
    }, zeroStock);
  }
  await localState();
  await expect(
    page.getByRole("button", { name: "Quantity (1)", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Price (1)", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Review quantity changes in this category",
      exact: true,
    })
    .click();
  const review = page.getByRole("region", { name: "Review Etsy changes" });
  await expect(review).toContainText("8 → 3");
  await page.screenshot({
    path: "/tmp/etsy-listings-review.png",
    fullPage: true,
  });
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(review).not.toBeVisible();
  await localState(true);
  await page
    .getByRole("button", {
      name: "Review quantity changes in this category",
      exact: true,
    })
    .click();
  await expect(review).toContainText(
    "Deactivate on Etsy: all variations are out of stock.",
  );
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  await localState();

  await page
    .getByRole("button", {
      name: "Review quantity changes in this category",
      exact: true,
    })
    .click();
  await db
    .collection("etsy_listing_sync")
    .doc("state")
    .set({ canWrite: false }, { merge: true });
  await expect(
    review.getByRole("button", {
      name: "Sync reviewed quantity changes to Etsy",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    page.getByText(/Etsy is connected for reading only/),
  ).toBeVisible();
  await db
    .collection("etsy_listing_sync")
    .doc("state")
    .set({ canWrite: true }, { merge: true });
  await expect(
    review.getByRole("button", {
      name: "Sync reviewed quantity changes to Etsy",
      exact: true,
    }),
  ).toBeEnabled();
  await review
    .getByRole("button", {
      name: "Sync reviewed quantity changes to Etsy",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Queued quantity updates" }),
  ).toBeVisible();
  const requests = await db.collection("request_etsy_listings").get();
  const request = requests.docs
    .map((d) => d.data())
    .find((d) => d.entries?.some((e: any) => e.listingId === "90001"));
  const recordedRequest = requests.docs.find((d) =>
    d.data().entries?.some((e: any) => e.listingId === "90001"),
  )!;
  const queued = await db
    .collection("sync")
    .doc(`etsy-listings-${recordedRequest.id}-requested`)
    .get();
  expect(queued.data()?.eventType).toBe("etsy/sync_requested");
  await expect
    .poll(() =>
      page.evaluate(
        (id) => (window as any).store.getState().syncQueue.jobsById[id]?.domain,
        recordedRequest.id,
      ),
    )
    .toBe("etsy");
  expect(request?.field).toBe("quantity");
  expect(request?.entries[0].targets).toEqual([
    {
      productId: "11",
      sku: "4901234567890Blue",
      itemKey: "4901234567890Blue",
      beforeQuantity: 8,
      beforePrice: 4.5,
      value: 3,
    },
  ]);
  await page.reload();
  await localState();
  await expect(
    page.getByRole("button", { name: "Quantity (1)", exact: true }),
  ).toBeVisible();
  await db
    .collection("etsy_listing_results")
    .doc("test-visible-error")
    .set({
      mode: "sync",
      status: "partial_failed",
      startedAtMs: Date.now(),
      completed: 1,
      total: 1,
      results: [
        {
          listingId: "90001",
          success: false,
          error: "Etsy rejected this test quantity",
        },
      ],
    });
  const failures = page.getByRole("alert", { name: "Etsy sync failures" });
  await expect(failures).toContainText("Test Etsy Pens");
  await expect(failures).toContainText("Etsy rejected this test quantity");
  await expect(
    page.getByRole("row").filter({ hasText: "Compare 1 variations" }),
  ).toContainText("Sync failed: Etsy rejected this test quantity");
  await db
    .collection("etsy_listing_results")
    .doc("test-visible-error")
    .set(
      {
        results: [{ listingId: "90001", success: true }],
        status: "completed",
      },
      { merge: true },
    );
  await expect(failures).not.toContainText("Etsy rejected this test quantity");
  await expect(
    page.getByRole("row").filter({ hasText: "Compare 1 variations" }),
  ).not.toContainText("Sync failed:");
  await page.getByRole("button", { name: "Title (1)", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Review title changes in this category",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("region", { name: "Review Etsy changes" }),
  ).toContainText("Test Local Pens");
});

test("Shopify quantity category submits inventory-only changes", async ({
  authenticatedPage: page,
}) => {
  test.setTimeout(60000);
  await page.goto("/shopify-listings");
  await expect(
    page.getByRole("heading", { name: "Shopify Listings", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const store = (window as any).store,
      s = store.getState(),
      h = "test-shopify-stock-only",
      sku = "4901234567890Blue";
    const listing = {
      handle: h,
      title: "Test Stock Only",
      bodyHtml: "<p>Same</p>",
      productCategory: "Stationery",
      productType: "",
      vendor: "SPNSS Ltd.",
      tags: [],
      status: "active",
      option1Name: "Color",
      images: [],
      lastUpdated: 1,
    };
    const remote = {
      ...listing,
      productId: "100",
      updatedAtMs: 1,
      updatedAtIso: "1970-01-01T00:00:00.001Z",
      variants: [
        {
          id: "11",
          sku,
          subtype: "Blue",
          price: 4,
          janCode: "4901234567890",
          weight: 10,
          inventoryQuantity: 8,
          image: "",
        },
      ],
    };
    store.dispatch({
      type: "HYDRATE",
      payload: {
        ...s,
        inventory: {
          ...s.inventory,
          initialized: true,
          idToItem: {
            [sku]: {
              janCode: "4901234567890",
              subtype: "Blue",
              qty: 5,
              shipped: 2,
              price: 4,
              weight: 10,
              image: "",
              handle: h,
            },
          },
        },
        listings: {
          ...s.listings,
          knownCategories: ["Stationery"],
          handleToListing: { [h]: listing },
          idToHandle: { [sku]: h },
        },
        shopifyCatalog: {
          ...s.shopifyCatalog,
          handleToListing: { [h]: remote },
        },
      },
    });
  });
  const section = page.locator("details.issue-section").filter({
    has: page.locator("summary strong", { hasText: "Inventory Quantity" }),
  });
  await section.locator("summary").click();
  await section
    .getByRole("button", { name: "Sync all (1)", exact: true })
    .click();
  await expect(
    page.getByText("Queued 1 Shopify sync request for Inventory Quantity.", {
      exact: true,
    }),
  ).toBeVisible();
  const requests = await db.collection("request_shopify_sync").get();
  const request = requests.docs
    .map((d) => d.data())
    .find((d) => d.handle === "test-shopify-stock-only");
  expect(request?.syncMode).toBe("inventory");
  expect(request?.variants).toHaveLength(1);
  expect(request?.variants[0].available).toBe(3);
});
