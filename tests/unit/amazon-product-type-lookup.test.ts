import { describe, it, expect } from "vitest";
import { amazonProductTypeLookup } from "../../src/lib/amazon-product-type-lookup";
const title = "Amifa 3D Aurora Stickers (22)",
  seller = "seller",
  marketplaceId = "A1F83G8C2ARO7P";
const search = (id = "lookup") => ({
  id,
  requestId: id,
  kind: "product_type_search",
  key: title,
  sellerId: seller,
  marketplaceId,
  status: 200,
  ok: true,
  fetchedAtMs: 100,
  raw: {
    productTypes: [{ name: "STICKER_DECAL", displayName: "Sticker Decal" }],
  },
});
const params = { responses: {}, events: {}, seller, title };
describe("Amazon product type lookup UI results", () => {
  it("recovers the completed suggestion from cached API facts", () => {
    expect(
      amazonProductTypeLookup({ ...params, responses: { a: search() } }),
    ).toMatchObject({
      status: "success",
      requestId: "lookup",
      types: [{ name: "STICKER_DECAL", displayName: "Sticker Decal" }],
    });
  });
  it("uses the live search result before definition/schema downloads finish", () => {
    const event = {
      requestId: "lookup",
      createdAtMs: 100,
      eventType: "amazon/product_type_discovery_api_call",
      payload: {
        requestType: "product_type_search",
        success: true,
        response: search().raw,
        context: { key: title, sellerId: seller, marketplaceId, status: 200 },
      },
    };
    expect(
      amazonProductTypeLookup({
        ...params,
        requestId: "lookup",
        events: { a: event },
      }).status,
    ).toBe("success");
  });
  it("does not present stale results as completion of a new lookup or mix seller contexts", () => {
    expect(
      amazonProductTypeLookup({
        ...params,
        requestId: "new",
        responses: { a: search("old") },
      }).status,
    ).toBe("pending");
    expect(
      amazonProductTypeLookup({
        ...params,
        responses: { a: { ...search(), sellerId: "other" } },
      }).status,
    ).toBe("idle");
  });
  it("distinguishes no results, multiple choices and server failure", () => {
    expect(
      amazonProductTypeLookup({
        ...params,
        responses: { a: { ...search(), raw: { productTypes: [] } } },
      }).status,
    ).toBe("empty");
    expect(
      amazonProductTypeLookup({
        ...params,
        responses: {
          a: {
            ...search(),
            raw: {
              productTypes: [{ name: "STICKER_DECAL" }, { name: "LABEL" }],
            },
          },
        },
      }).types,
    ).toHaveLength(2);
    expect(
      amazonProductTypeLookup({
        ...params,
        requestId: "lookup",
        events: {
          a: {
            requestId: "lookup",
            eventType: "amazon/product_type_discovery_failed",
            payload: { errorMessage: "Amazon authorization expired" },
          },
        },
      }),
    ).toMatchObject({ status: "error", error: "Amazon authorization expired" });
  });
});
