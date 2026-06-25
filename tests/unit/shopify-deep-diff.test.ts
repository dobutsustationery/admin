import { describe, expect, it } from "vitest";
import type { Listing } from "$lib/listings-slice";
import {
  diffLocalListingAgainstShopifyCatalog,
  diffLocalListingAgainstShopifyCatalogDetailed,
} from "$lib/shopify-deep-diff";
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
        {
          id: "https://drive.google.com/file/d/variant-file-id/view",
          url: "https://drive.google.com/file/d/variant-file-id/view",
          position: 2,
          altText: "Red",
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

  it("treats Shopify CDN images generated from the same Drive image as one imported gallery image", () => {
    const listing: Listing = {
      handle: "image-test",
      title: "Image Test",
      bodyHtml: "",
      productCategory: "",
      productType: "",
      vendor: "SPNSS Ltd.",
      tags: [],
      status: "active",
      option1Name: "Subtype",
      images: [
        {
          id: "https://drive.google.com/file/d/1AG0M-A10HNm6oCOhDUwmnZGYOtRMpsfu/view",
          url: "https://drive.google.com/file/d/1AG0M-A10HNm6oCOhDUwmnZGYOtRMpsfu/view",
          position: 1,
          altText: "Pastel",
        },
      ],
      lastUpdated: 123,
    };

    const remoteListing: ShopifyCatalogListing = {
      productId: "99",
      handle: "image-test",
      title: "Image Test",
      bodyHtml: "",
      vendor: "SPNSS Ltd.",
      productType: "",
      productCategory: "",
      tags: [],
      status: "active",
      option1Name: "Subtype",
      updatedAtIso: "2026-03-29T12:00:00.000Z",
      updatedAtMs: 1000,
      images: [
        {
          id: "1",
          url: "https://cdn.shopify.com/s/files/1/files/1AG0M-A10HNm6oCOhDUwmnZGYOtRMpsfu_s1600.png?v=1",
          position: 1,
          altText: "Pastel",
        },
        {
          id: "2",
          url: "https://cdn.shopify.com/s/files/1/files/1AG0M-A10HNm6oCOhDUwmnZGYOtRMpsfu_s1600_04005ad6-18ca-4dc3-898d-7d3bd73455ac.png?v=1",
          position: 2,
          altText: "Pastel duplicate",
        },
      ],
      variants: [
        {
          id: "20",
          sku: "4901681382347Pastel",
          subtype: "Pastel",
          price: 16.95,
          janCode: "4901681382347",
          weight: 117,
          inventoryQuantity: 5,
          image:
            "https://cdn.shopify.com/s/files/1/files/1AG0M-A10HNm6oCOhDUwmnZGYOtRMpsfu_s1600_04005ad6-18ca-4dc3-898d-7d3bd73455ac.png?v=1",
        },
      ],
    };

    const result = diffLocalListingAgainstShopifyCatalogDetailed({
      handle: "image-test",
      listing,
      items: [
        {
          janCode: "4901681382347",
          subtype: "Pastel",
          description: "Image Test",
          qty: 5,
          shipped: 0,
          price: 16.95,
          weight: 117,
          image:
            "https://drive.google.com/file/d/1AG0M-A10HNm6oCOhDUwmnZGYOtRMpsfu/view",
          timestamp: 0,
        } as any,
      ],
      remoteListing,
    });

    expect(result.galleryImageDiffs).toEqual([]);
    expect(result.matches).toBe(true);
  });

  it("does not treat gallery alt text alone as an image mismatch", () => {
    const listing: Listing = {
      handle: "alt-test",
      title: "Alt Test",
      bodyHtml: "",
      productCategory: "",
      productType: "",
      vendor: "SPNSS Ltd.",
      tags: [],
      status: "active",
      option1Name: "Subtype",
      images: [
        {
          id: "https://drive.google.com/file/d/gallery-file-id/view",
          url: "https://drive.google.com/file/d/gallery-file-id/view",
          position: 1,
          altText: "imported.jpg",
        },
      ],
      lastUpdated: 123,
    };

    const remoteListing: ShopifyCatalogListing = {
      productId: "99",
      handle: "alt-test",
      title: "Alt Test",
      bodyHtml: "",
      vendor: "SPNSS Ltd.",
      productType: "",
      productCategory: "",
      tags: [],
      status: "active",
      option1Name: "Subtype",
      updatedAtIso: "2026-03-29T12:00:00.000Z",
      updatedAtMs: 1000,
      images: [
        {
          id: "1",
          url: "https://cdn.shopify.com/s/files/1/files/gallery-file-id_s1600.png?v=1",
          position: 1,
          altText: "Standard",
        },
      ],
      variants: [],
    };

    const result = diffLocalListingAgainstShopifyCatalogDetailed({
      handle: "alt-test",
      listing,
      items: [],
      remoteListing,
    });

    expect(result.galleryImageDiffs).toEqual([]);
    expect(result.matches).toBe(true);
  });

  it("ignores product image order for variant-associated images", () => {
    const listing: Listing = {
      handle: "variant-image-order-test",
      title: "Variant Image Order Test",
      bodyHtml: "",
      productCategory: "",
      productType: "",
      vendor: "SPNSS Ltd.",
      tags: [],
      status: "active",
      option1Name: "Color",
      images: [
        {
          id: "blue-gallery",
          url: "https://drive.google.com/file/d/blue-image-file-id/view",
          position: 1,
          altText: "Blue",
        },
        {
          id: "pink-gallery",
          url: "https://drive.google.com/file/d/pink-image-file-id/view",
          position: 2,
          altText: "Pink",
        },
      ],
      lastUpdated: 123,
    };

    const remoteListing: ShopifyCatalogListing = {
      productId: "99",
      handle: "variant-image-order-test",
      title: "Variant Image Order Test",
      bodyHtml: "",
      vendor: "SPNSS Ltd.",
      productType: "",
      productCategory: "",
      tags: [],
      status: "active",
      option1Name: "Color",
      updatedAtIso: "2026-03-29T12:00:00.000Z",
      updatedAtMs: 1000,
      images: [
        {
          id: "pink",
          url: "https://cdn.shopify.com/s/files/1/files/pink-image-file-id_s1600.png?v=1",
          position: 1,
          altText: "Pink",
        },
        {
          id: "blue",
          url: "https://cdn.shopify.com/s/files/1/files/blue-image-file-id_s1600.png?v=1",
          position: 2,
          altText: "Blue",
        },
      ],
      variants: [
        {
          id: "20",
          sku: "4542804105827Blue",
          subtype: "Blue",
          price: 8.5,
          janCode: "4542804105827",
          weight: 12,
          inventoryQuantity: 3,
          image:
            "https://cdn.shopify.com/s/files/1/files/blue-image-file-id_s1600.png?v=1",
        },
        {
          id: "21",
          sku: "4542804105828Pink",
          subtype: "Pink",
          price: 8.5,
          janCode: "4542804105828",
          weight: 12,
          inventoryQuantity: 4,
          image:
            "https://cdn.shopify.com/s/files/1/files/pink-image-file-id_s1600.png?v=1",
        },
      ],
    };

    const result = diffLocalListingAgainstShopifyCatalogDetailed({
      handle: "variant-image-order-test",
      listing,
      items: [
        {
          janCode: "4542804105827",
          subtype: "Blue",
          description: "Variant Image Order Test",
          qty: 3,
          shipped: 0,
          price: 8.5,
          weight: 12,
          image: "https://drive.google.com/file/d/blue-image-file-id/view",
          timestamp: 0,
        } as any,
        {
          janCode: "4542804105828",
          subtype: "Pink",
          description: "Variant Image Order Test",
          qty: 4,
          shipped: 0,
          price: 8.5,
          weight: 12,
          image: "https://drive.google.com/file/d/pink-image-file-id/view",
          timestamp: 0,
        } as any,
      ],
      remoteListing,
    });

    expect(result.galleryImageDiffs).toEqual([]);
    expect(result.mismatchKeys).toEqual([]);
  });

  it("still compares order among non-variant gallery images", () => {
    const listing: Listing = {
      handle: "gallery-order-test",
      title: "Gallery Order Test",
      bodyHtml: "",
      productCategory: "",
      productType: "",
      vendor: "SPNSS Ltd.",
      tags: [],
      status: "active",
      option1Name: "Title",
      images: [
        {
          id: "front",
          url: "https://drive.google.com/file/d/front-image-file-id/view",
          position: 1,
          altText: "Front",
        },
        {
          id: "back",
          url: "https://drive.google.com/file/d/back-image-file-id/view",
          position: 2,
          altText: "Back",
        },
      ],
      lastUpdated: 123,
    };

    const remoteListing: ShopifyCatalogListing = {
      productId: "99",
      handle: "gallery-order-test",
      title: "Gallery Order Test",
      bodyHtml: "",
      vendor: "SPNSS Ltd.",
      productType: "",
      productCategory: "",
      tags: [],
      status: "active",
      option1Name: "Title",
      updatedAtIso: "2026-03-29T12:00:00.000Z",
      updatedAtMs: 1000,
      images: [
        {
          id: "back",
          url: "https://cdn.shopify.com/s/files/1/files/back-image-file-id_s1600.png?v=1",
          position: 1,
          altText: "Back",
        },
        {
          id: "front",
          url: "https://cdn.shopify.com/s/files/1/files/front-image-file-id_s1600.png?v=1",
          position: 2,
          altText: "Front",
        },
      ],
      variants: [
        {
          id: "20",
          sku: "4542804105827",
          subtype: "Default Title",
          price: 8.5,
          janCode: "4542804105827",
          weight: 12,
          inventoryQuantity: 3,
          image: "",
        },
      ],
    };

    const result = diffLocalListingAgainstShopifyCatalogDetailed({
      handle: "gallery-order-test",
      listing,
      items: [
        {
          janCode: "4542804105827",
          subtype: "",
          description: "Gallery Order Test",
          qty: 3,
          shipped: 0,
          price: 8.5,
          weight: 12,
          image: "",
          timestamp: 0,
        } as any,
      ],
      remoteListing,
    });

    expect(result.mismatchKeys).toEqual(["galleryImages"]);
    expect(result.galleryImageDiffs).toHaveLength(2);
    expect(result.galleryImageDiffs[0].fields).toEqual(["url"]);
    expect(result.galleryImageDiffs[1].fields).toEqual(["url"]);
  });

  it("compares Shopify inventory quantity against local on-hand quantity", () => {
    const listing: Listing = {
      handle: "quantity-test",
      title: "Quantity Test",
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
      productId: "99",
      handle: "quantity-test",
      title: "Quantity Test",
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
          price: 8.5,
          janCode: "4542804105827",
          weight: 12,
          inventoryQuantity: 2,
          image: "",
        },
      ],
    };

    const result = diffLocalListingAgainstShopifyCatalogDetailed({
      handle: "quantity-test",
      listing,
      items: [
        {
          janCode: "4542804105827",
          subtype: "Red",
          description: "Quantity Test",
          qty: 3,
          shipped: 1,
          price: 8.5,
          weight: 12,
          timestamp: 0,
        } as any,
      ],
      remoteListing,
    });

    expect(result.matches).toBe(true);
    expect(result.variantDiffs).toEqual([]);
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

  it("classifies bare SKU and inventory quantity variant differences", () => {
    const listing: Listing = {
      handle: "variant-detail-test",
      title: "Variant Detail Test",
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
      handle: "variant-detail-test",
      title: "Variant Detail Test",
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
          sku: "4542804105827",
          subtype: "Red",
          price: 8.5,
          janCode: "4542804105827",
          weight: 12,
          inventoryQuantity: 2,
          image: "",
        },
      ],
    };

    const result = diffLocalListingAgainstShopifyCatalogDetailed({
      handle: "variant-detail-test",
      listing,
      items: [
        {
          janCode: "4542804105827",
          subtype: "Red",
          description: "Variant Detail Test",
          qty: 3,
          price: 8.5,
          weight: 12,
          timestamp: 0,
          shipped: 0,
        } as any,
      ],
      remoteListing,
    });

    expect(result.mismatchKeys).toEqual(["variants"]);
    expect(result.variantDiffs).toHaveLength(1);
    expect(result.variantDiffs[0].matchType).toBe("singleJan");
    expect(result.variantDiffs[0].fields).toEqual(["sku", "inventoryQuantity"]);
  });

  it("matches variants by unique JAN when subtype differs", () => {
    const listing: Listing = {
      handle: "single-jan-test",
      title: "Single JAN Test",
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
      handle: "single-jan-test",
      title: "Single JAN Test",
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
          sku: "4542804105827",
          subtype: "Default Title",
          price: 8.5,
          janCode: "4542804105827",
          weight: 12,
          inventoryQuantity: 3,
          image: "",
        },
      ],
    };

    const result = diffLocalListingAgainstShopifyCatalogDetailed({
      handle: "single-jan-test",
      listing,
      items: [
        {
          janCode: "4542804105827",
          subtype: "Blue",
          description: "Single JAN Test",
          qty: 3,
          price: 8.5,
          weight: 12,
          timestamp: 0,
          shipped: 0,
        } as any,
      ],
      remoteListing,
    });

    expect(result.variantDiffs).toHaveLength(1);
    expect(result.variantDiffs[0].matchType).toBe("singleJan");
    expect(result.variantDiffs[0].fields).toEqual(["sku", "subtype"]);
  });

  it("does not report blank Shopify variant image as an edit when image assignment cannot target the current variant SKU", () => {
    const listing: Listing = {
      handle: "default-image-target-test",
      title: "Default Image Target Test",
      bodyHtml: "",
      productCategory: "",
      productType: "",
      vendor: "SPNSS Ltd.",
      tags: [],
      status: "active",
      option1Name: "Title",
      images: [],
      lastUpdated: 123,
    };

    const remoteListing: ShopifyCatalogListing = {
      productId: "10",
      handle: "default-image-target-test",
      title: "Default Image Target Test",
      bodyHtml: "",
      vendor: "SPNSS Ltd.",
      productType: "",
      productCategory: "",
      tags: [],
      status: "active",
      option1Name: "Title",
      updatedAtIso: "2026-03-29T12:00:00.000Z",
      updatedAtMs: 1000,
      images: [],
      variants: [
        {
          id: "20",
          sku: "4542804105827Default Title",
          subtype: "Default Title",
          price: 8.5,
          janCode: "4542804105827",
          weight: 12,
          inventoryQuantity: 3,
          image: "",
        },
      ],
    };

    const result = diffLocalListingAgainstShopifyCatalogDetailed({
      handle: "default-image-target-test",
      listing,
      items: [
        {
          janCode: "4542804105827",
          subtype: "",
          description: "Default Image Target Test",
          qty: 3,
          price: 8.5,
          weight: 12,
          image: "https://drive.google.com/file/d/default-image-file-id/view",
          timestamp: 0,
          shipped: 0,
        } as any,
      ],
      remoteListing,
    });

    expect(result.variantDiffs).toHaveLength(1);
    expect(result.variantDiffs[0].fields).toEqual(["sku"]);
    expect(result.variantDiffs[0].fields).not.toContain("image");
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
