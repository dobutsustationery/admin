import { describe, expect, it } from "vitest";

const {
  buildProductPayload,
} = require("../../functions/shared/shopify-sync-core.cjs");

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
});
