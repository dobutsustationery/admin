import { test, expect } from "../fixtures/auth";
import { resolve } from "node:path";

test("Shopify image differences preview Drive and actual Shopify copies on hover", async ({
  authenticatedPage: page,
}) => {
  test.setTimeout(60000);
  const fixture = resolve("static/hedgehogs/HedgehogV6ColourTransparentBG.png");
  for (const pattern of [
    "https://lh3.googleusercontent.com/**",
    "https://cdn.shopify.com/**",
  ]) {
    await page.route(pattern, (route: any) =>
      route.fulfill({
        path: fixture,
        contentType: "image/png",
        headers: { "access-control-allow-origin": "*" },
      }),
    );
  }
  await page.goto("/shopify-listings/diff?handle=test-image-diff");
  await expect(
    page.getByRole("heading", { name: "Shopify Diff", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const store = (window as any).store,
      s = store.getState(),
      h = "test-image-diff",
      sku = "4901234567890Blue";
    const localGallery =
        "https://lh3.googleusercontent.com/d/local-gallery-111111=s0",
      localVariant =
        "https://lh3.googleusercontent.com/d/local-variant-333333=s0";
    const remoteGallery =
        "https://cdn.shopify.com/s/files/remote-gallery-222222_s1600.png?v=42",
      remoteVariant =
        "https://cdn.shopify.com/s/files/remote-variant-444444_s1600.png?v=43";
    const listing = {
      handle: h,
      title: "Image Comparison",
      bodyHtml: "<p>Same</p>",
      productCategory: "Stationery",
      productType: "",
      vendor: "SPNSS Ltd.",
      tags: [],
      status: "active",
      option1Name: "Color",
      images: [
        { id: "gallery", url: localGallery, position: 1, altText: "Gallery" },
      ],
      lastUpdated: 1,
    };
    const remote = {
      ...listing,
      productId: "100",
      updatedAtMs: 1,
      updatedAtIso: "1970-01-01T00:00:00.001Z",
      images: [
        { id: "1", url: remoteGallery, position: 1, altText: "Gallery" },
        { id: "2", url: remoteVariant, position: 2, altText: "Blue" },
      ],
      variants: [
        {
          id: "11",
          sku,
          subtype: "Blue",
          price: 4,
          janCode: "4901234567890",
          weight: 10,
          inventoryQuantity: 3,
          image: remoteVariant,
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
              qty: 3,
              shipped: 0,
              price: 4,
              weight: 10,
              image: localVariant,
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
  const local = page.getByAltText("Local 4901234567890Blue image", {
    exact: true,
  });
  const remote = page.getByAltText("Shopify 4901234567890Blue image", {
    exact: true,
  });
  await expect(local).toBeVisible();
  await expect(remote).toBeVisible();
  await expect(local).toHaveAttribute("src", /local-variant-333333=s200/);
  await expect(remote).toHaveAttribute(
    "src",
    "https://cdn.shopify.com/s/files/remote-variant-444444_s1600.png?v=43",
  );
  await expect(
    page.getByAltText("Local gallery image 1", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByAltText("Shopify gallery image 1", { exact: true }),
  ).toHaveAttribute(
    "src",
    "https://cdn.shopify.com/s/files/remote-gallery-222222_s1600.png?v=42",
  );
  await local.hover();
  await expect(page.locator(".image-preview-overlay")).toBeVisible();
  await expect(page.locator(".image-preview-overlay img")).toHaveAttribute(
    "src",
    /local-variant-333333=s0/,
  );
  await page
    .getByRole("heading", { name: "Shopify Diff", exact: true })
    .hover();
  await expect(page.locator(".image-preview-overlay")).not.toBeVisible();
  await remote.hover();
  await expect(page.locator(".image-preview-overlay img")).toHaveAttribute(
    "src",
    "https://cdn.shopify.com/s/files/remote-variant-444444_s1600.png?v=43",
  );
  await page.screenshot({
    path: "/tmp/shopify-diff-image-hover.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "← Back to Shopify Listings" }).click();
  const section = page.locator("details.issue-section").filter({
    has: page.locator("summary strong", { hasText: "Variant Image" }),
  });
  await section.locator("summary").click();
  await expect(
    section.getByAltText("Local Blue image", { exact: true }),
  ).toBeVisible();
  await expect(
    section.getByAltText("Shopify Blue image", { exact: true }),
  ).toHaveAttribute(
    "src",
    "https://cdn.shopify.com/s/files/remote-variant-444444_s1600.png?v=43",
  );
});
