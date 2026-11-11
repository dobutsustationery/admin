import { describe, it, expect } from "vitest";
import {
  amazonCategoryAttributes,
  amazonProductFacts,
  missingAmazonProductFacts,
} from "../../src/lib/amazon-product-attributes";
const make = (
  productType: string,
  janCode: string,
  title: string,
  amazonFacts: any = {},
) =>
  amazonCategoryAttributes({
    productType,
    marketplaceId: "A1F83G8C2ARO7P",
    sku: janCode,
    packCount: 1,
    item: { janCode, amazonFacts },
    listing: { title },
  });
describe("Amazon category retry attributes", () => {
  it("uses the recorded roll length in metres rather than relabelling the piece count", () => {
    const a = make(
      "ADHESIVE_TAPES",
      "4542804113723",
      "Amifa Retro Washi Masking Tape",
    );
    expect(a.unit_count[0]).toMatchObject({
      value: 4,
      type: { value: "meter" },
    });
    expect(a.number_of_items[0].value).toBe(1);
    expect(a.included_components[0].value).toContain("Washi");
  });
  it("does not guess a tape length from an apparent supplier millimetre typo", () => {
    const item = { janCode: "4542804113679" },
      listing = { title: "Amifa Film Washi Masking Tape" };
    expect(
      missingAmazonProductFacts("ADHESIVE_TAPES", item, listing),
    ).toContain("Total tape / roll length (metres)");
    expect(
      make("ADHESIVE_TAPES", item.janCode, listing.title).unit_count,
    ).toBeUndefined();
    expect(
      make("ADHESIVE_TAPES", item.janCode, listing.title, { lengthMetres: 2 })
        .unit_count[0].value,
    ).toBe(2);
  });
  it("uses supplier materials for bags but leaves their unrecorded third dimension for the operator", () => {
    const item = { janCode: "4542804136005" },
      listing = { title: "Amifa Cat Freezer Bags" };
    expect(amazonProductFacts(item, listing)).toMatchObject({
      material: "HDPE",
      lengthCm: 28.5,
      widthCm: 27,
    });
    expect(
      missingAmazonProductFacts("FOOD_STORAGE_BAG", item, listing),
    ).toEqual(["Height / depth (cm)"]);
    expect(
      missingAmazonProductFacts("FOOD_STORAGE_BAG", item, listing, {
        heightCm: 1,
      }),
    ).toEqual([]);
    expect(
      make("FOOD_STORAGE_BAG", item.janCode, listing.title, { heightCm: 1 })
        .item_length_width_height[0],
    ).toMatchObject({
      length: { value: 28.5, unit: "centimeters" },
      height: { value: 1 },
    });
  });
  it("does not assume water-based ink for an unspecified self-inking stamp or marker", () => {
    expect(
      missingAmazonProductFacts(
        "RUBBER_STAMP",
        { janCode: "4542804153637" },
        { title: "Amifa Self-Inking Stamp" },
      ),
    ).toContain("Ink base");
    expect(
      make("RUBBER_STAMP", "4542804152388", "Amifa Wooden Animal Stamps").ink[0]
        .base,
    ).toEqual([{ value: "no_ink" }]);
    expect(
      make(
        "WRITING_INSTRUMENT",
        "4542804147421",
        "Amifa Water-Based Double Tip Pen",
      ).ink[0].base,
    ).toEqual([{ value: "water" }]);
  });
  it("supplies the missing warranty for sticky notes without inventing a warranty duration", () => {
    expect(
      make("SELF_STICK_NOTE", "4542804126785", "Amifa Sticky Notes")
        .warranty_description[0].value,
    ).toBe("No additional manufacturer's warranty is specified.");
  });
});
