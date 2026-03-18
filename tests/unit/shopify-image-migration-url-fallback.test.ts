import { describe, expect, it } from "vitest";

const {
  toDeletedShopifyCdnUrl,
} = require("../../functions/shared/photos-sync-worker.cjs");

describe("shopify image migration deleted fallback URL", () => {
  it("inserts /deleted/ before /files/ in Shopify CDN URLs", () => {
    const source =
      "https://cdn.shopify.com/s/files/1/0914/2937/2286//files/IMG_5787_eb2ff014-e321-4c76-b4ef-04f0b0436ebc.heic?v=1759222350";

    expect(toDeletedShopifyCdnUrl(source)).toBe(
      "https://cdn.shopify.com/s/files/1/0914/2937/2286/deleted/files/IMG_5787_eb2ff014-e321-4c76-b4ef-04f0b0436ebc.heic?v=1759222350",
    );
  });

  it("handles single-slash /files/ paths (no double slash) used in listings", () => {
    const source =
      "https://cdn.shopify.com/s/files/1/0914/2937/2286/files/IMG_5789.heic?v=1759222350";

    expect(toDeletedShopifyCdnUrl(source)).toBe(
      "https://cdn.shopify.com/s/files/1/0914/2937/2286/deleted/files/IMG_5789.heic?v=1759222350",
    );
  });

  it("returns empty string when URL is already deleted variant", () => {
    const source =
      "https://cdn.shopify.com/s/files/1/0914/2937/2286/deleted/files/IMG_5787.heic?v=1759222350";

    expect(toDeletedShopifyCdnUrl(source)).toBe("");
  });

  it("returns empty string for non-shopify URLs", () => {
    expect(
      toDeletedShopifyCdnUrl("https://example.com/s/files/1/2/3/4/files/a.jpg"),
    ).toBe("");
  });
});
