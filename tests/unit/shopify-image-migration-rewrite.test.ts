import { describe, expect, it } from "vitest";
import { rootReducer } from "../../src/lib/root-reducer";
import { update_item } from "../../src/lib/inventory";
import { create_listing } from "../../src/lib/listings-slice";

describe("shopify image migration rewrite", () => {
  it("rewrites Shopify CDN URLs in inventory and listings on shopify_cdn completion", () => {
    const sourceUrl =
      "https://cdn.shopify.com/s/files/1/0914/2937/2286//files/IMG_5787.heic?v=1759222350";
    const deletedSourceUrl =
      "https://cdn.shopify.com/s/files/1/0914/2937/2286/deleted/files/IMG_5787.heic?v=1759222350";
    const driveUrl = "https://drive.google.com/thumbnail?id=drive-file-123";

    let state: any = rootReducer(undefined, { type: "@@INIT" });

    state = rootReducer(
      state,
      update_item({
        id: "jan-1",
        item: {
          janCode: "jan-1",
          subtype: "",
          description: "Item 1",
          hsCode: "",
          image: sourceUrl,
          qty: 1,
          pieces: 1,
          shipped: 0,
          creationDate: "",
          timestamp: 0,
        },
      }) as any,
    );

    state = rootReducer(
      state,
      create_listing({
        listing: {
          handle: "item-1",
          title: "Item 1",
          bodyHtml: "",
          productCategory: "",
          productType: "",
          vendor: "",
          tags: [],
          status: "active",
          option1Name: "Subtype",
          images: [
            {
              id: sourceUrl,
              url: sourceUrl,
              position: 1,
              altText: "",
            },
            {
              id: "keep-id",
              url: "https://example.com/keep.jpg",
              position: 2,
              altText: "",
            },
          ],
          lastUpdated: 0,
        },
      }) as any,
    );

    state = rootReducer(state, {
      type: "photos/shopify_cdn_uploaded",
      payload: {
        permanentUrl: driveUrl,
        sourceType: "shopify_cdn",
        sourceBaseUrl: sourceUrl,
        sourceUrl: deletedSourceUrl,
      },
      _timestamp: 1760000000000,
    });

    expect(state.inventory.idToItem["jan-1"].image).toBe(driveUrl);
    expect(state.inventory.shopifyUrlToDriveUrl[sourceUrl]).toBe(driveUrl);
    expect(state.inventory.shopifyUrlToDriveUrl[deletedSourceUrl]).toBe(
      driveUrl,
    );

    const listing = state.listings.handleToListing["item-1"];
    expect(listing.images[0].url).toBe(driveUrl);
    expect(listing.images[0].id).toBe(driveUrl);
    expect(listing.images[1].url).toBe("https://example.com/keep.jpg");
  });
});
