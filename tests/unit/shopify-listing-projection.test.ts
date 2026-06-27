import { describe, expect, it } from "vitest";
import {
  buildAdminShopifyListingProjection,
  buildComparableAdminShopifySyncProjection,
  buildShopifySyncRequestEvent,
} from "$lib/shopify-listing-projection";

describe("Shopify listing projection", () => {
  it("builds the canonical admin-to-Shopify sync projection", () => {
    const projection = buildAdminShopifyListingProjection({
      handle: "test-listing",
      listing: {
        handle: "test-listing",
        title: "Test Listing",
        bodyHtml: "<p>Hello</p>",
        productCategory: "Stationery",
        productType: "Letter Set",
        vendor: "SPNSS Ltd.",
        tags: ["cute"],
        status: "active",
        option1Name: "Color",
        variantOptionsByItemId: {
          "4542804105827Red": "Scarlet",
        },
        images: [
          {
            id: "gallery",
            url: "https://drive.google.com/file/d/gallery-file-id/view",
            position: 1,
            altText: "Gallery",
          },
        ],
      },
      items: [
        {
          id: "4542804105827Red",
          janCode: "4542804105827",
          subtype: "Red",
          qty: 4,
          shipped: 1,
          price: 8.5,
          weight: 12,
          image: "https://drive.google.com/file/d/variant-file-id/view",
        } as any,
      ],
    });

    expect(projection).toEqual({
      handle: "test-listing",
      listing: {
        handle: "test-listing",
        title: "Test Listing",
        bodyHtml: "<p>Hello</p>",
        productCategory: "Stationery",
        option1Name: "Color",
        productType: "Letter Set",
        vendor: "SPNSS Ltd.",
        tags: ["cute"],
        status: "active",
        images: [
          {
            id: "gallery",
            url: "https://lh3.googleusercontent.com/d/gallery-file-id=s0",
            position: 1,
            altText: "Gallery",
          },
        ],
      },
      variants: [
        {
          itemId: "4542804105827Red",
          sku: "4542804105827Red",
          janCode: "4542804105827",
          subtype: "Scarlet",
          available: 3,
          price: 8.5,
          weight: 12,
          image: "https://lh3.googleusercontent.com/d/variant-file-id=s0",
        },
      ],
    });
  });

  it("does not build a Shopify projection for No Sync listings", () => {
    const projection = buildAdminShopifyListingProjection({
      handle: "no-sync-listing",
      listing: {
        handle: "no-sync-listing",
        title: "No Sync Listing",
        status: "no_sync",
      },
      items: [
        {
          id: "4542804105827Red",
          janCode: "4542804105827",
          subtype: "Red",
          qty: 4,
          shipped: 1,
        } as any,
      ],
    });

    expect(projection).toBeNull();
  });

  it("projects the post-sync Shopify product image shape", () => {
    const projection = buildAdminShopifyListingProjection({
      handle: "image-listing",
      listing: {
        title: "Image Listing",
        images: [
          {
            url: "https://drive.google.com/file/d/gallery-file-id/view",
            position: 1,
            altText: "Gallery shared image",
          },
        ],
      },
      items: [
        {
          id: "4901681382316Standard",
          janCode: "4901681382316",
          subtype: "Standard",
          qty: 1,
          shipped: 0,
          image: "https://drive.google.com/file/d/variant-file-id/view",
        } as any,
      ],
    });

    expect(projection).not.toBeNull();
    const comparable = buildComparableAdminShopifySyncProjection(projection!);

    expect(comparable.galleryImages).toEqual([
      {
        url: "drive:gallery-file-id",
        altText: "Gallery shared image",
      },
    ]);
    expect(comparable.variants[0].image).toBe("drive:variant-file-id");
  });

  it("uses the same projection for queued sync requests", () => {
    const projection = buildAdminShopifyListingProjection({
      handle: "request-listing",
      listing: { title: "Request Listing" },
      items: [
        {
          id: "4542804105827",
          janCode: "4542804105827",
          qty: 2,
          shipped: 0,
        } as any,
      ],
    });

    const event = buildShopifySyncRequestEvent({
      projection: projection!,
      requestId: "request-1",
      uid: "operator",
      source: "test",
      nowMs: 123,
      serverTimestamp: "SERVER_TIMESTAMP",
    });

    expect(event.listing).toBe(projection!.listing);
    expect(event.variants).toBe(projection!.variants);
    expect(event).toMatchObject({
      eventType: "shopify/sync_requested",
      requestId: "request-1",
      handle: "request-listing",
      creator: "operator",
      requestedBy: "operator",
      requestedAt: 123,
      payloadVersion: 1,
    });
  });

  it("does not project an item image as a variant image for single default products", () => {
    const projection = buildAdminShopifyListingProjection({
      handle: "single-default-listing",
      listing: {
        title: "Single Default Listing",
        images: [
          {
            url: "https://drive.google.com/file/d/default-image-file-id/view",
            position: 1,
            altText: "Default product image",
          },
        ],
      },
      items: [
        {
          id: "4542804122688",
          janCode: "4542804122688",
          subtype: "",
          qty: 3,
          shipped: 0,
          image: "https://drive.google.com/file/d/default-image-file-id/view",
        } as any,
      ],
    });

    expect(projection?.variants).toEqual([
      {
        itemId: "4542804122688",
        sku: "4542804122688",
        janCode: "4542804122688",
        subtype: "",
        available: 3,
        price: 0,
        weight: 0,
        image: "",
      },
    ]);

    const comparable = buildComparableAdminShopifySyncProjection(projection!);
    expect(comparable.galleryImages).toEqual([
      {
        url: "drive:default-image-file-id",
        altText: "Default product image",
      },
    ]);
    expect(comparable.variants[0].image).toBe("");
  });
});
