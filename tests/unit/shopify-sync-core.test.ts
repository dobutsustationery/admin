import { afterEach, describe, expect, it, vi } from "vitest";

const {
  buildProductPayload,
  upsertProductFromRequest,
} = require("../../functions/shared/shopify-sync-core.cjs");

describe("shopify-sync-core update failures", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([409, 422, 500])(
    "propagates HTTP %i without creating a replacement product",
    async (status) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: {
              productByHandle: {
                id: "gid://shopify/Product/123",
                handle: "existing-product",
                variants: { nodes: [] },
              },
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status,
          json: async () => ({ errors: "Product update failed" }),
        })
        .mockRejectedValue(new Error("Unexpected additional Shopify request"));
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        upsertProductFromRequest(
          {
            storeUrl: "test.myshopify.com",
            apiVersion: "2026-01",
            accessToken: "test-token",
          },
          {
            handle: "existing-product",
            listing: { title: "Existing Product" },
            variants: [{ sku: "123", price: 6 }],
          },
        ),
      ).rejects.toThrow("Product update failed");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toBe(
        "https://test.myshopify.com/admin/api/2026-01/products/123.json",
      );
      expect(fetchMock.mock.calls[1][1].method).toBe("PUT");
    },
  );
});

describe("shopify-sync-core buildProductPayload", () => {
  it("sets draft status and global published scope for new products", () => {
    const payload = buildProductPayload(
      {
        handle: "test-handle",
        listing: {
          handle: "test-handle",
          title: "Test Product",
        },
        variants: [
          {
            sku: "123ABC",
            subtype: "Default",
            price: 6,
            janCode: "123",
            weight: 10,
          },
        ],
      },
      null,
    );

    expect(payload.status).toBe("draft");
    expect(payload.published_scope).toBe("global");
  });

  it("does not override publication scope on updates", () => {
    const payload = buildProductPayload(
      {
        handle: "test-handle",
        listing: {
          handle: "test-handle",
          title: "Test Product",
          status: "draft",
        },
        variants: [
          {
            sku: "123ABC",
            subtype: "Default",
            price: 6,
            janCode: "123",
            weight: 10,
          },
        ],
      },
      { id: 1, handle: "test-handle", status: "active", variants: [] },
    );

    expect(payload.status).toBe("draft");
    expect(payload).not.toHaveProperty("published_scope");
  });

  it("includes standard_product_type in payload from productCategory", () => {
    const payload = buildProductPayload(
      {
        handle: "test-handle",
        listing: {
          handle: "test-handle",
          title: "Test Product",
          productCategory: "Stationery",
        },
        variants: [
          {
            sku: "123",
            janCode: "123",
          },
        ],
      },
      null,
    );

    expect(payload.standard_product_type).toBe("Stationery");
  });

  it("handles single default variant case correctly (Default Title and no options)", () => {
    const payload = buildProductPayload(
      {
        handle: "test-handle",
        listing: {
          handle: "test-handle",
          title: "Test Product",
        },
        variants: [
          {
            sku: "123ABC",
            subtype: "Default",
            price: 6,
            janCode: "123",
            weight: 10,
          },
        ],
      },
      null,
    );

    expect(payload.variants[0].option1).toBe("Default Title");
    expect(payload.options).toBeUndefined();
  });

  it("matches existing Default-suffixed Shopify variants by canonical SKU", () => {
    const payload = buildProductPayload(
      {
        handle: "test-handle",
        listing: {
          handle: "test-handle",
          title: "Test Product",
        },
        variants: [
          {
            sku: "123",
            subtype: "",
            janCode: "123",
          },
        ],
      },
      {
        id: 1,
        handle: "test-handle",
        status: "active",
        variants: [{ id: 456, sku: "123Default" }],
      },
    );

    expect(payload.variants[0].id).toBe(456);
    expect(payload.variants[0].sku).toBe("123");
  });

  it("matches existing Default Title-suffixed Shopify variants by canonical SKU", () => {
    const payload = buildProductPayload(
      {
        handle: "test-handle",
        listing: {
          handle: "test-handle",
          title: "Test Product",
        },
        variants: [
          {
            sku: "123",
            subtype: "",
            janCode: "123",
          },
        ],
      },
      {
        id: 1,
        handle: "test-handle",
        status: "active",
        variants: [{ id: 789, sku: "123Default Title" }],
      },
    );

    expect(payload.variants[0].id).toBe(789);
    expect(payload.variants[0].sku).toBe("123");
  });

  it("matches a local JAN+label SKU to the only existing bare-JAN Shopify variant", () => {
    const janCode = "4952270291328";
    const payload = buildProductPayload(
      {
        handle: "test-handle",
        listing: {
          handle: "test-handle",
          title: "Test Product",
          option1Name: "Style",
        },
        variants: [
          {
            sku: `${janCode}Flake Stickers`,
            subtype: "Flake Stickers",
            janCode,
          },
        ],
      },
      {
        id: 1,
        handle: "test-handle",
        status: "active",
        variants: [{ id: 456, sku: janCode, barcode: janCode }],
      },
    );

    expect(payload.variants[0].id).toBe(456);
    expect(payload.variants[0].sku).toBe(`${janCode}Flake Stickers`);
  });

  it("does not match a local JAN+label SKU to ambiguous existing Shopify variants", () => {
    const janCode = "4952270291328";
    const payload = buildProductPayload(
      {
        handle: "test-handle",
        listing: {
          handle: "test-handle",
          title: "Test Product",
          option1Name: "Style",
        },
        variants: [
          {
            sku: `${janCode}Flake Stickers`,
            subtype: "Flake Stickers",
            janCode,
          },
        ],
      },
      {
        id: 1,
        handle: "test-handle",
        status: "active",
        variants: [
          { id: 456, sku: janCode, barcode: janCode },
          { id: 789, sku: `${janCode}Memo`, barcode: janCode },
        ],
      },
    );

    expect(payload.variants[0].id).toBeUndefined();
  });

  it("includes options for products with multiple variants even if some are 'Default'", () => {
    const payload = buildProductPayload(
      {
        handle: "test-handle",
        listing: {
          handle: "test-handle",
          title: "Test Product",
          option1Name: "Color",
        },
        variants: [
          {
            sku: "123A",
            subtype: "Red",
          },
          {
            sku: "123B",
            subtype: "Default",
          },
        ],
      },
      null,
    );

    expect(payload.variants[0].option1).toBe("Red");
    expect(payload.variants[1].option1).toBe("Default");
    expect(payload.options).toEqual([{ name: "Color" }]);
  });
});
