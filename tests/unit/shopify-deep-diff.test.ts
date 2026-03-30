import { describe, expect, it } from "vitest";
import type { Listing } from "$lib/listings-slice";
import { diffLocalListingAgainstShopifyCatalog } from "$lib/shopify-deep-diff";
import type { ShopifyCatalogListing } from "$lib/shopify-catalog-slice";

describe("shopify deep diff", () => {
  it("treats equivalent local and remote listings as a match", () => {
    const listing: Listing = {
      handle: "test-product",
      title: "Test Product",
      bodyHtml: "<p>Hello&nbsp;world</p>",
      productCategory: "Stationery",
      productType: "Letter Set",
      vendor: "SPNSS Ltd.",
      tags: ["Cute", "Japan"],
      status: "active",
      option1Name: "Color",
      images: [
        {
          id: "https://drive.google.com/file/d/gallery-file-id/view",
          url: "https://drive.google.com/file/d/gallery-file-id/view",
          position: 1,
          altText: "Gallery alt",
        },
      ],
      lastUpdated: 123,
    };

    const remoteListing: ShopifyCatalogListing = {
      productId: "10",
      handle: "test-product",
      title: "Test Product",
      bodyHtml: "<p>Hello world</p>",
      vendor: "SPNSS Ltd.",
      productType: "Letter Set",
      productCategory: "Stationery",
      tags: ["japan", "cute"],
      status: "active",
      option1Name: "Color",
      updatedAtIso: "2026-03-29T12:00:00.000Z",
      updatedAtMs: 1000,
      images: [
        {
          id: "1",
          url: "https://cdn.shopify.com/s/files/1/files/gallery-image.png?v=1",
          position: 1,
          altText: "Gallery alt",
        },
        {
          id: "2",
          url: "https://cdn.shopify.com/s/files/1/files/variant-image.png?v=1",
          position: 2,
          altText: "Red",
        },
      ],
      variants: [
        {
          id: "20",
          sku: "4542804105827Red",
          subtype: "Red",
          price: 8.5,
          janCode: "4542804105827",
          weight: 12,
          inventoryQuantity: 3,
          image:
            "https://cdn.shopify.com/s/files/1/files/variant-image.png?v=1",
        },
      ],
    };

    const result = diffLocalListingAgainstShopifyCatalog({
      handle: "test-product",
      listing,
      items: [
        {
          janCode: "4542804105827",
          subtype: "Red",
          description: "Test Product",
          qty: 3,
          price: 8.5,
          weight: 12,
          image: "https://drive.google.com/file/d/variant-file-id/view",
          timestamp: 0,
          shipped: 0,
        } as any,
      ],
      remoteListing,
    });

    expect(result.matches).toBe(true);
    expect(result.mismatchKeys).toEqual([]);
  });

  it("canonicalizes nbsp and equivalent spacing in bodyHtml", () => {
    const listing: Listing = {
      handle: "html-test",
      title: "HTML Test",
      bodyHtml: "<p>One&nbsp;&nbsp;Two</p>",
      productCategory: "",
      productType: "",
      vendor: "SPNSS Ltd.",
      tags: [],
      status: "active",
      option1Name: "Subtype",
      images: [],
      lastUpdated: 123,
    };

    const remoteListing: ShopifyCatalogListing = {
      productId: "99",
      handle: "html-test",
      title: "HTML Test",
      bodyHtml: "<p>One Two</p>",
      vendor: "SPNSS Ltd.",
      productType: "",
      productCategory: "",
      tags: [],
      status: "active",
      option1Name: "Subtype",
      updatedAtIso: "2026-03-29T12:00:00.000Z",
      updatedAtMs: 1000,
      images: [],
      variants: [],
    };

    const result = diffLocalListingAgainstShopifyCatalog({
      handle: "html-test",
      listing,
      items: [],
      remoteListing,
    });

    expect(result.matches).toBe(true);
    expect(result.mismatchKeys).toEqual([]);
  });

  it("reports variant mismatches when Shopify data diverges", () => {
    const listing: Listing = {
      handle: "test-product",
      title: "Test Product",
      bodyHtml: "",
      productCategory: "",
      productType: "",
      vendor: "SPNSS Ltd.",
      tags: [],
      status: "active",
      option1Name: "Subtype",
      images: [],
      lastUpdated: 123,
    };

    const remoteListing: ShopifyCatalogListing = {
      productId: "10",
      handle: "test-product",
      title: "Test Product",
      bodyHtml: "",
      vendor: "SPNSS Ltd.",
      productType: "",
      productCategory: "",
      tags: [],
      status: "active",
      option1Name: "Subtype",
      updatedAtIso: "2026-03-29T12:00:00.000Z",
      updatedAtMs: 1000,
      images: [],
      variants: [
        {
          id: "20",
          sku: "4542804105827Red",
          subtype: "Red",
          price: 9,
          janCode: "4542804105827",
          weight: 12,
          inventoryQuantity: 3,
          image: "",
        },
      ],
    };

    const result = diffLocalListingAgainstShopifyCatalog({
      handle: "test-product",
      listing,
      items: [
        {
          janCode: "4542804105827",
          subtype: "Red",
          description: "Test Product",
          qty: 3,
          price: 8.5,
          weight: 12,
          timestamp: 0,
          shipped: 0,
        } as any,
      ],
      remoteListing,
    });

    expect(result.matches).toBe(false);
    expect(result.mismatchKeys).toContain("variants");
  });

  it("ignores vendor and tags differences in deep diff", () => {
    const listing: Listing = {
      handle: "metadata-test",
      title: "Metadata Test",
      bodyHtml: "",
      productCategory: "",
      productType: "",
      vendor: "Dobutsu",
      tags: ["New Arrival"],
      status: "active",
      option1Name: "Subtype",
      images: [],
      lastUpdated: 123,
    };

    const remoteListing: ShopifyCatalogListing = {
      productId: "10",
      handle: "metadata-test",
      title: "Metadata Test",
      bodyHtml: "",
      vendor: "SPNSS Ltd.",
      productType: "",
      productCategory: "",
      tags: [],
      status: "active",
      option1Name: "Subtype",
      updatedAtIso: "2026-03-29T12:00:00.000Z",
      updatedAtMs: 1000,
      images: [],
      variants: [],
    };

    const result = diffLocalListingAgainstShopifyCatalog({
      handle: "metadata-test",
      listing,
      items: [],
      remoteListing,
    });

    expect(result.matches).toBe(true);
    expect(result.mismatchKeys).toEqual([]);
  });
});
