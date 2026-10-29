import { describe, expect, it } from "vitest";
import {
  etsyComparison,
  etsySyncEntry,
  plainDescription,
  type EtsyListing,
} from "../../src/lib/etsy-listings";
const {
  inventoryUpdate,
} = require("../../functions/shared/etsy-listing-sync.cjs");
const inventory = () => ({
  products: [
    {
      product_id: 1,
      sku: "123Blue",
      property_values: [
        {
          property_id: 513,
          values: ["Blue"],
          value_ids: [1],
          scale_name: "ignored",
        },
      ],
      offerings: [
        {
          offering_id: 10,
          price: { amount: 400, divisor: 100 },
          quantity: 8,
          is_enabled: true,
          readiness_state_id: 42,
        },
      ],
    },
    {
      product_id: 2,
      sku: "unknown",
      property_values: [{ property_id: 513, values: ["Red"], value_ids: [2] }],
      offerings: [
        {
          offering_id: 20,
          price: { amount: 600, divisor: 100 },
          quantity: 7,
          is_enabled: false,
          readiness_state_id: 43,
        },
      ],
    },
  ],
  quantity_on_property: [513],
  price_on_property: [513],
  sku_on_property: [513],
  readiness_state_on_property: [513],
});
const target = {
  productId: "1",
  sku: "123Blue",
  beforeQuantity: 8,
  beforePrice: 4,
  value: 3,
};
function root() {
  return {
    inventory: {
      idToItem: {
        "123Blue": {
          janCode: "123",
          subtype: "Blue",
          qty: 5,
          shipped: 2,
          price: 4,
        },
      },
    },
    listings: {
      idToHandle: { "123Blue": "pens" },
      handleToListing: {
        pens: { title: "Pens", bodyHtml: "<p>Local description</p>" },
      },
    },
  };
}
function listing(): EtsyListing {
  return {
    listingId: "100",
    shopId: "shop",
    title: "Pens",
    description: "Local description",
    state: "active",
    url: "",
    currency: "EUR",
    images: [{ id: "image", url: "", rank: 1 }],
    inventory: inventory(),
    inventoryError: "",
    observedAtMs: 1,
  };
}

describe("Etsy inventory replacement", () => {
  it("updates only targeted quantities, preserving price, unknown variants, disabled offerings and processing profiles", () => {
    const source = inventory(),
      before = structuredClone(source),
      body = inventoryUpdate(source, [target], "quantity");
    expect(source).toEqual(before);
    expect(body.products[0].offerings[0]).toEqual({
      quantity: 3,
      price: 4,
      is_enabled: true,
      readiness_state_id: 42,
    });
    expect(body.products[1].offerings[0]).toEqual({
      quantity: 7,
      price: 6,
      is_enabled: false,
      readiness_state_id: 43,
    });
    expect(body.products[1].sku).toBe("unknown");
    expect(body.readiness_state_on_property).toEqual([513]);
    expect(body.products[0]).not.toHaveProperty("product_id");
    expect(body.products[0].offerings[0]).not.toHaveProperty("offering_id");
  });
  it("updates price without changing stock", () => {
    const body = inventoryUpdate(
      inventory(),
      [{ ...target, value: 4.5 }],
      "price",
    );
    expect(body.products[0].offerings[0].quantity).toBe(8);
    expect(body.products[0].offerings[0].price).toBe(4.5);
  });
  it("rejects stale stock or changed SKU before replacing the matrix", () => {
    expect(() =>
      inventoryUpdate(
        inventory(),
        [{ ...target, beforeQuantity: 9 }],
        "quantity",
      ),
    ).toThrow("changed");
    expect(() =>
      inventoryUpdate(inventory(), [{ ...target, sku: "other" }], "quantity"),
    ).toThrow("SKU changed");
    expect(() =>
      inventoryUpdate(
        inventory(),
        [{ ...target, productId: "missing" }],
        "quantity",
      ),
    ).toThrow("disappeared");
  });
  it("does not flatten shared quantity constraints into independently writable variations", () => {
    const source = inventory();
    source.quantity_on_property = [];
    expect(() => inventoryUpdate(source, [target], "quantity")).toThrow(
      "shares quantity",
    );
  });
});
describe("Etsy listing comparison", () => {
  it("compares mapped SKUs and exposes unmatched variations without guessing", () => {
    const row = etsyComparison(root(), [listing()])[0];
    expect(row.issues).toContain("quantity");
    expect(row.issues).toContain("mapping");
    expect(etsySyncEntry(row, "quantity").targets).toEqual([
      { ...target, itemKey: "123Blue" },
    ]);
    expect(etsySyncEntry(row, "title")).toBeNull();
  });
  it("uses an explicit mapping for a missing SKU", () => {
    const remote = listing();
    remote.inventory.products = [remote.inventory.products[1]];
    const row = etsyComparison(root(), [remote], { "100-2": "123Blue" })[0];
    expect(row.matches[0].itemKey).toBe("123Blue");
    expect(row.issues).not.toContain("mapping");
  });
  it("does not propose currency conversion or prices in another currency", () => {
    const remote = listing();
    remote.currency = "GBP";
    remote.inventory.products = [remote.inventory.products[0]];
    const row = etsyComparison(root(), [remote])[0];
    expect(row.issues).toContain("price");
    expect(etsySyncEntry(row, "price")).toBeNull();
  });
  it("does not sync No Sync listings", () => {
    const local: any = root();
    local.listings.handleToListing.pens.status = "no_sync";
    expect(
      etsySyncEntry(etsyComparison(local, [listing()])[0], "quantity"),
    ).toBeNull();
  });
  it("normalizes descriptions without requiring identical HTML", () => {
    expect(plainDescription("<p>A &amp; B</p><p>Second</p>")).toBe(
      "A & B\nSecond",
    );
  });
});
