import { test, expect } from "../fixtures/auth";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
process.env.FIRESTORE_EMULATOR_HOST ||= "localhost:18080";
const app =
  getApps().find((a) => a.name === "amazon-family-browser") ||
  initializeApp({ projectId: "demo-test-project" }, "amazon-family-browser");
const db = getFirestore(app);

test("prepare a shared-JAN Amifa family, retain choices on reload, and queue the exact parent and children", async ({
  authenticatedPage: page,
}) => {
  test.setTimeout(60000);
  await page.goto("/amazon-listings");
  await expect(page.locator(".loading-overlay")).not.toBeVisible();
  async function fixture() {
    await expect(
      page.getByRole("heading", { name: "Amazon listings", exact: true }),
    ).toBeVisible();
    await page.waitForFunction(
      () => !!(window as any).store?.getState()?.inventory,
    );
    await expect(page.locator(".loading-overlay")).not.toBeVisible();
    await page.evaluate(() => {
      const store = (window as any).store,
        s = store.getState(),
        jan = "4542804116359",
        handle = "amifa-family-browser-test";
      const inventory = { ...s.inventory, initialized: true, idToItem: {} };
      const listings = {
        ...s.listings,
        idToHandle: {},
        handleToListing: {
          [handle]: {
            handle,
            title: "Amifa 3D Aurora Stickers (22)",
            bodyHtml: "<p>Two designs</p>",
            images: [],
          },
        },
      };
      for (const subtype of ["Blue", "Pink"]) {
        const key = jan + subtype;
        inventory.idToItem[key] = {
          janCode: jan,
          subtype,
          description: "Amifa 3D Aurora Stickers (22)",
          qty: 4,
          shipped: 0,
          pieces: 1,
          price: 4,
          handle,
          image: "",
        };
        listings.idToHandle[key] = handle;
      }
      store.dispatch({
        type: "HYDRATE",
        payload: {
          ...s,
          inventory,
          listings,
          amazonAudit: {
            ...s.amazonAudit,
            sellerId: "family-browser-seller",
            observations: {},
            mappings: {},
            rows: ["Blue", "Pink"].map((subtype) => ({
              key: jan + subtype,
              family: handle,
              title: "Amifa 3D Aurora Stickers (22)",
              jan,
              subtype,
              onHand: 4,
              sharedJan: true,
              sku: "",
              asin: "",
              health: "Not linked",
              detail: "No seller SKU",
              price: "Not observed",
              quantity: null,
              checkedAt: 0,
              skuCandidates: [],
              mappingSource: "",
            })),
          },
          amazonPreparation: {
            ...s.amazonPreparation,
            policies: {
              '["family-browser-seller","A1F83G8C2ARO7P",""]': {
                gbpPerEur: "1",
              },
            },
          },
        },
      });
    });
  }
  await fixture();
  const panel = page.getByRole("region", {
    name: "Create Amazon variation family",
  });
  const listing = page
    .locator("details.family")
    .filter({ hasText: "Amifa 3D Aurora Stickers (22)" });
  await listing.locator("summary").first().click();
  await expect(listing).not.toContainText(
    "Creating a new shared-barcode product is not supported",
  );
  await expect(listing.locator("article")).toHaveCount(1);
  await expect(
    listing.getByRole("button", {
      name: "Prepare variant family",
      exact: true,
    }),
  ).toHaveCount(1);
  await expect(listing).not.toContainText("price needed");
  await expect(
    listing.getByRole("button", { name: "Exclude from sync", exact: true }),
  ).toHaveCount(0);
  await expect(listing).toContainText("Local price (EUR)");
  await expect(listing).toContainText("€4.00");
  await listing
    .getByRole("button", { name: "Prepare variant family", exact: true })
    .click();
  await expect(
    panel.getByRole("combobox", { name: "Product family", exact: true }),
  ).toHaveCount(0);
  await expect(panel).toContainText("GTIN exempt");
  await expect(
    panel.getByLabel("Amazon has approved the applicable amifa GTIN exemption"),
  ).toBeChecked();
  await panel
    .getByLabel("Amazon has approved the applicable amifa GTIN exemption")
    .uncheck();
  await panel.getByLabel("Family Amazon product type").fill("STICKER_DECAL");
  await panel
    .getByRole("combobox", { name: "Variants differ by", exact: true })
    .selectOption("STYLE_NAME");
  for (const colour of ["Blue", "Pink"]) {
    await panel
      .getByLabel(`Family GBP price for 4542804116359${colour}`)
      .fill("4.50");
    await panel
      .getByLabel(`Family GBP price for 4542804116359${colour}`)
      .press("Tab");
  }
  await expect(panel).toContainText(
    "Shared JANs cannot identify different Amazon children",
  );
  await expect(
    panel.getByRole("button", {
      name: "Save and check variant family with Amazon",
    }),
  ).toBeDisabled();
  await panel
    .getByLabel("Amazon has approved the applicable amifa GTIN exemption")
    .check();
  await panel
    .getByLabel("Approval reference or note (optional)")
    .fill("Browser test: UK Amifa STICKER_DECAL approval");
  await panel.getByLabel("Approval reference or note (optional)").press("Tab");
  await expect(panel).toContainText("Parent SKU:");
  await page.reload();
  await expect(page.locator(".loading-overlay")).not.toBeVisible();
  await fixture();
  await listing.locator("summary").first().click();
  await listing
    .getByRole("button", { name: "Prepare variant family", exact: true })
    .click();
  await expect(panel.getByLabel("Family Amazon product type")).toHaveValue(
    "STICKER_DECAL",
  );
  await expect(
    panel.getByRole("combobox", { name: "Variants differ by", exact: true }),
  ).toHaveValue("STYLE_NAME");
  await expect(
    panel.getByLabel("Approval reference or note (optional)"),
  ).toHaveValue("Browser test: UK Amifa STICKER_DECAL approval");
  await panel
    .getByRole("button", { name: "Save and check variant family with Amazon" })
    .click();
  await expect(
    panel.getByRole("status").filter({ hasText: "Family validation queued" }),
  ).toBeVisible();
  const snap = await db.collection("request_amazon_prepare").get();
  const request = snap.docs
    .map((d) => d.data())
    .find((d) =>
      d.entries?.some(
        (e: any) => e.family?.handle === "amifa-family-browser-test",
      ),
    );
  expect(request?.entries).toHaveLength(3);
  expect(request?.entries[0].family.role).toBe("parent");
  expect(request?.entries[0].body.attributes.purchasable_offer).toBeUndefined();
  expect(request?.entries[1].family.theme).toBe("STYLE_NAME");
  expect(
    request?.entries[1].body.attributes.purchasable_offer[0].currency,
  ).toBe("GBP");
  expect(
    request?.entries[1].body.attributes.purchasable_offer[0].our_price[0]
      .schedule[0].value_with_tax,
  ).toBe(4.5);
  expect(request?.entries[1].family.exemptionReference).toContain("UK Amifa");
  await expect(
    panel.getByRole("button", { name: "Publish reviewed variant family" }),
  ).not.toBeVisible();
  await page.screenshot({
    path: "/tmp/amazon-variation-family-review.png",
    fullPage: true,
  });
});
