import { describe, expect, it } from "vitest";
import { buildAmazonVariationFamily } from "../../src/lib/amazon-variation-family";
import {
  initialPreparation,
  projectPreparation,
  reducePreparation,
} from "../../src/lib/amazon-preparation";
import {
  initialAmazonAudit,
  projectAmazonAudit,
} from "../../src/lib/amazon-audit";
const {
  validateRequest,
} = require("../../functions/shared/amazon-preparation-worker.cjs");
function fixture(shared = false) {
  const items: any = {
    a: {
      janCode: "4542804151466",
      subtype: "Blue",
      qty: 9,
      shipped: 1,
      pieces: 1,
      price: 4,
      image: "https://example.com/blue.png",
    },
    b: {
      janCode: shared ? "4542804151466" : "4542804151473",
      subtype: "Green",
      qty: 0,
      shipped: 0,
      pieces: 1,
      price: 4,
      image: "https://example.com/green.png",
    },
  };
  const inventory = { idToItem: items };
  const listings = {
    idToHandle: { a: "letters", b: "letters" },
    handleToListing: {
      letters: {
        handle: "letters",
        title: "Amifa Kamome Letter Set",
        bodyHtml: "<p>Japanese stationery.</p>",
        variantOptionsByItemId: { a: "Blue", b: "Green" },
      },
    },
  };
  const audit = {
    ...initialAmazonAudit,
    sellerId: "seller",
    rows: [] as any[],
  };
  audit.rows = projectAmazonAudit(audit, inventory, listings);
  let prep = initialPreparation;
  for (const itemKey of ["a", "b"])
    prep = reducePreparation(prep, {
      type: "amazonPrepare/decision",
      payload: { sellerId: "seller", itemKey, decision: { priceGBP: "4" } },
    });
  const rows = projectPreparation(prep, audit, inventory, listings);
  return {
    handle: "letters",
    inventory,
    listings,
    rows,
    decision: { productType: "STICKER_DECAL", variationTheme: "COLOR" },
  };
}
const request = (entries: any[]) => ({
  creator: "user",
  sellerId: "seller",
  marketplaceId: "A1F83G8C2ARO7P",
  mode: "preview",
  entries,
});
describe("Amifa variation family preparation", () => {
  it("builds a non-buyable parent and distinct children with explicit stock, GBP prices, images and relationships", () => {
    const f = fixture();
    const p = buildAmazonVariationFamily(f);
    expect(p.reason).toBe("");
    expect(p.entries).toHaveLength(3);
    const [parent, blue, green] = p.entries;
    expect(parent.body.attributes.purchasable_offer).toBeUndefined();
    expect(parent.body.attributes.fulfillment_availability).toBeUndefined();
    expect(
      parent.body.attributes.externally_assigned_product_identifier,
    ).toBeUndefined();
    expect(
      blue.body.attributes.child_parent_sku_relationship[0].parent_sku,
    ).toBe(parent.sku);
    expect(blue.body.attributes.fulfillment_availability[0].quantity).toBe(8);
    expect(green.body.attributes.fulfillment_availability[0].quantity).toBe(0);
    expect(
      blue.body.attributes.main_product_image_locator[0].media_location,
    ).toBe("https://example.com/blue.png");
    expect(blue.body.attributes.safety_warning).toBeUndefined();
    expect(() => validateRequest(request(p.entries))).not.toThrow();
  });
  it("never infers an exemption from a shared JAN, and accepts an explicit scoped confirmation", () => {
    const f = fixture(true);
    expect(buildAmazonVariationFamily(f).reason).toContain("Shared JANs");
    const p = buildAmazonVariationFamily({
      ...f,
      decision: {
        ...f.decision,
        identifierExemption: true,
        exemptionReference: "UK Amifa STICKER_DECAL approval case 123",
      },
    });
    expect(p.reason).toBe("");
    expect(
      p.entries[1].body.attributes.externally_assigned_product_identifier,
    ).toBeUndefined();
    expect(p.entries[1].family?.exemptionReference).toContain("case 123");
    expect(() => validateRequest(request(p.entries))).not.toThrow();
    p.entries[1].family!.exemptionApproved = false;
    expect(() => validateRequest(request(p.entries))).toThrow("exemption");
  });
  it("uses supplied child identifiers and supports design variants without relabeling them as colours", () => {
    const f = fixture(true);
    f.rows[0].decision.identifierEAN = "4542804151466";
    f.rows[1].decision.identifierEAN = "4542804151473";
    const p = buildAmazonVariationFamily({
      ...f,
      decision: { ...f.decision, variationTheme: "STYLE_NAME" },
    });
    expect(p.reason).toBe("");
    expect(p.entries[1].body.attributes.color).toBeUndefined();
    expect(p.entries[1].body.attributes.style_name[0].value).toBe("Blue");
    expect(() => validateRequest(request(p.entries))).not.toThrow();
    const orphan = p.entries.slice(1);
    expect(() => validateRequest(request(orphan))).toThrow("complete family");
    p.entries[2].body.attributes.externally_assigned_product_identifier[0].value =
      "4542804151466";
    expect(() => validateRequest(request(p.entries))).toThrow("share");
  });
});

it("records an explicit exemption selection without requiring an invented case number", () => {
  const f = fixture(true);
  const p = buildAmazonVariationFamily({
    ...f,
    decision: { ...f.decision, identifierExemption: true },
  });
  expect(p.reason).toBe("");
  expect(
    p.entries[1].body.attributes
      .supplier_declared_has_product_identifier_exemption[0].value,
  ).toBe(true);
  expect(p.entries[1].family?.exemptionReference).toContain(
    "Operator selected",
  );
  expect(() => validateRequest(request(p.entries))).not.toThrow();
});
