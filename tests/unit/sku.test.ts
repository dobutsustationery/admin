import { describe, expect, it } from "vitest";
import {
  canonicalizeInventoryItemKey,
  canonicalizeSubtype,
  generateSku,
  makeInventoryItemKey,
} from "$lib/sku";

describe("SKU helpers", () => {
  it("creates SKUs from JAN plus real subtype", () => {
    expect(generateSku("4542804154658", "Blue")).toBe("4542804154658Blue");
    expect(makeInventoryItemKey("4542804154658", "Blue")).toBe(
      "4542804154658Blue",
    );
  });

  it("strips Shopify default subtype labels from canonical SKUs", () => {
    expect(generateSku("4542804154658", "Default")).toBe("4542804154658");
    expect(generateSku("4542804154658", "Default Title")).toBe("4542804154658");
    expect(makeInventoryItemKey("4542804154658", " default ")).toBe(
      "4542804154658",
    );
    expect(canonicalizeSubtype("Default Title")).toBe("");
  });

  it("canonicalizes existing Default-suffixed SKUs back to their base JAN", () => {
    expect(canonicalizeInventoryItemKey("4542804154658Default")).toBe(
      "4542804154658",
    );
    expect(canonicalizeInventoryItemKey("4542804154658Default Title")).toBe(
      "4542804154658",
    );
  });
});
