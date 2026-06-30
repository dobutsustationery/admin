import { describe, expect, it } from "vitest";
import {
  buildAmazonListingCreateDraft,
  buildAmazonListingCreateDraftFromState,
} from "$lib/amazon-listing-projection";

describe("Amazon listing projection", () => {
  it("uses the product maker instead of the seller vendor for Amifa listings", () => {
    const draft = buildAmazonListingCreateDraft({
      handle: "amifa-sakura-origami-design-paper-4542804131499",
      itemKey: "4542804131499",
      marketplaceId: "A1F83G8C2ARO7P",
      listing: {
        handle: "amifa-sakura-origami-design-paper-4542804131499",
        title: "Amifa Sakura Origami/Design Paper",
        bodyHtml: "<p>Sakura design paper.</p>",
        vendor: "SPNSS Ltd.",
        images: [],
      },
      item: {
        janCode: "4542804131499",
        subtype: "",
        description: "Amifa Sakura Origami/Design Paper",
        qty: 12,
        shipped: 2,
        price: 4,
      },
    });

    expect(draft).not.toBeNull();
    expect(draft!.submissions).toHaveLength(1);
    expect(draft!.submissions[0].role).toBe("standalone");
    const attributes = draft!.submissions[0].payload.attributes as Record<
      string,
      any[]
    >;
    expect(attributes.brand[0].value).toBe("Amifa");
    expect(attributes.brand[0].language_tag).toBe("en_GB");
    expect(attributes.manufacturer[0].value).toBe("Amifa");
    expect(attributes.manufacturer[0].language_tag).toBe("en_GB");
    expect(JSON.stringify(attributes)).not.toContain("SPNSS Ltd.");
  });

  it("does not invent SPNSS as the manufacturer when no maker is known", () => {
    const draft = buildAmazonListingCreateDraft({
      handle: "unknown-stationery-1234567890123",
      itemKey: "1234567890123",
      marketplaceId: "A1F83G8C2ARO7P",
      listing: {
        handle: "unknown-stationery-1234567890123",
        title: "Pretty Stationery Set",
        bodyHtml: "<p>Stationery set.</p>",
        vendor: "SPNSS Ltd.",
        images: [],
      },
      item: {
        janCode: "1234567890123",
        subtype: "",
        description: "Pretty Stationery Set",
        qty: 3,
        shipped: 0,
        price: 4,
      },
    });

    expect(draft).not.toBeNull();
    const attributes = draft!.submissions[0].payload.attributes as Record<
      string,
      any[]
    >;
    expect(attributes.brand[0].value).toBe("Generic");
    expect(attributes.manufacturer).toBeUndefined();
    expect(JSON.stringify(attributes)).not.toContain("SPNSS Ltd.");
  });

  it("generates the real required SELF_STICK_NOTE fields from local item data", () => {
    const draft = buildAmazonListingCreateDraft({
      handle: "amifa-kawaiil-dog-cat-sticky-notes-4542804050264",
      itemKey: "4542804050264Dog",
      marketplaceId: "A1F83G8C2ARO7P",
      productType: "SELF_STICK_NOTE",
      listing: {
        handle: "amifa-kawaiil-dog-cat-sticky-notes-4542804050264",
        title: "Amifa Kawaii Dog/Cat Sticky Notes (100)",
        bodyHtml:
          "<p><strong>Sticky notes</strong> so cute, they'll make you want to jot down important reminders immediately.</p><p>Available in: Dog and Cat designs</p>",
        vendor: "SPNSS Ltd.",
        images: [],
      },
      item: {
        janCode: "4542804050264",
        subtype: "Dog",
        description: "Amifa Kawaii Dog/Cat Sticky Notes (100)",
        countryOfOrigin: "China",
        weight: 48.5,
        qty: 9,
        shipped: 5,
        price: 4,
      },
    });

    expect(draft).not.toBeNull();
    expect(draft!.productType).toBe("SELF_STICK_NOTE");
    const attributes = draft!.submissions[0].payload.attributes as Record<
      string,
      any[]
    >;
    expect(attributes.bullet_point[0].value).toBe(
      "Amifa Kawaii Dog/Cat Sticky Notes (100)",
    );
    expect(attributes.country_of_origin[0].value).toBe("CN");
    expect(attributes.supplier_declared_dg_hz_regulation[0].value).toBe(
      "not_applicable",
    );
    expect(attributes.batteries_required[0].value).toBe(false);
    expect(attributes.item_package_weight[0]).toMatchObject({
      value: 48.5,
      unit: "grams",
    });
    expect(attributes.list_price[0]).toMatchObject({
      currency: "GBP",
      value_with_tax: 4,
    });
    expect(attributes.skip_offer[0]).toMatchObject({
      marketplace_id: "A1F83G8C2ARO7P",
      value: false,
    });
    expect(attributes.purchasable_offer[0]).toMatchObject({
      marketplace_id: "A1F83G8C2ARO7P",
      currency: "GBP",
    });
    expect(attributes.warranty_description).toBeUndefined();
    expect(attributes.part_number[0].value).toBe("4542804050264Dog");
    expect(attributes.unit_count[0]).toMatchObject({
      value: 100,
      type: {
        value: "count",
        language_tag: "en_GB",
      },
    });
  });

  it("projects a multi-option admin listing as one parent and child SKUs", () => {
    const state = {
      inventory: {
        idToItem: {
          "4542804050264Dog": {
            janCode: "4542804050264",
            subtype: "Dog",
            description: "Amifa Kawaii Dog/Cat Sticky Notes (100)",
            countryOfOrigin: "China",
            weight: 48.5,
            qty: 9,
            shipped: 5,
            price: 4,
          },
          "4542804050264Cat": {
            janCode: "4542804050264",
            subtype: "Cat",
            description: "Amifa Kawaii Dog/Cat Sticky Notes (100)",
            countryOfOrigin: "China",
            weight: 48.5,
            qty: 8,
            shipped: 3,
            price: 4,
          },
        },
      },
      listings: {
        idToHandle: {
          "4542804050264Dog":
            "amifa-kawaiil-dog-cat-sticky-notes-4542804050264",
          "4542804050264Cat":
            "amifa-kawaiil-dog-cat-sticky-notes-4542804050264",
        },
        handleToListing: {
          "amifa-kawaiil-dog-cat-sticky-notes-4542804050264": {
            handle: "amifa-kawaiil-dog-cat-sticky-notes-4542804050264",
            title: "Amifa Kawaii Dog/Cat Sticky Notes (100)",
            bodyHtml: "<p>Sticky notes.</p>",
            vendor: "SPNSS Ltd.",
            option1Name: "Style",
            variantOptionsByItemId: {
              "4542804050264Dog": "Dog",
              "4542804050264Cat": "Cat",
            },
            images: [],
          },
        },
      },
    };

    const draft = buildAmazonListingCreateDraftFromState({
      state,
      handle: "amifa-kawaiil-dog-cat-sticky-notes-4542804050264",
      itemKey: "4542804050264Dog",
      marketplaceId: "A1F83G8C2ARO7P",
      productType: "SELF_STICK_NOTE",
    });

    expect(draft).not.toBeNull();
    expect(draft!.submissions.map((submission) => submission.role)).toEqual([
      "parent",
      "child",
      "child",
    ]);
    const parent = draft!.submissions[0];
    expect(parent.sku).toMatch(/^P-/);
    expect(parent.payload.attributes.parentage_level[0]).toMatchObject({
      value: "parent",
    });
    expect(
      parent.payload.attributes.externally_assigned_product_identifier,
    ).toBe(undefined);
    expect(parent.payload.attributes.skip_offer).toBe(undefined);
    expect(parent.payload.attributes.purchasable_offer).toBe(undefined);

    const child = draft!.submissions.find(
      (submission) => submission.sku === "4542804050264Dog",
    );
    expect(child).toBeTruthy();
    expect(child!.payload.attributes.parentage_level[0]).toMatchObject({
      value: "child",
    });
    expect(
      child!.payload.attributes.child_parent_sku_relationship[0],
    ).toMatchObject({
      child_relationship_type: "variation",
      parent_sku: parent.sku,
    });
    expect((child!.payload.attributes.color[0] as any).value).toBe("Dog");
    expect(child!.payload.attributes.skip_offer[0]).toMatchObject({
      value: false,
    });
    expect(child!.payload.attributes.purchasable_offer).toBeTruthy();
    expect(
      child!.payload.attributes.externally_assigned_product_identifier,
    ).toBeUndefined();
    expect(
      child!.payload.attributes
        .supplier_declared_has_product_identifier_exemption[0],
    ).toMatchObject({
      marketplace_id: "A1F83G8C2ARO7P",
      value: true,
    });
  });

  it("generates required STICKER_DECAL fields from local item data", () => {
    const draft = buildAmazonListingCreateDraft({
      handle: "amifa-smiley-sticker-flakes-kawaii-4542804056341",
      itemKey: "4542804056341",
      marketplaceId: "A1F83G8C2ARO7P",
      productType: "STICKER_DECAL",
      listing: {
        handle: "amifa-smiley-sticker-flakes-kawaii-4542804056341",
        title: "Amifa Smiley Sticker Flakes Kawaii (40)",
        bodyHtml: "<p>Forty smiley sticker flakes.</p>",
        vendor: "SPNSS Ltd.",
        images: [],
      },
      item: {
        janCode: "4542804056341",
        subtype: "",
        description: "Amifa Smiley Sticker Flakes Kawaii (40)",
        countryOfOrigin: "China",
        weight: 21,
        qty: 10,
        shipped: 4,
        price: 3.5,
      },
    });

    expect(draft).not.toBeNull();
    const attributes = draft!.submissions[0].payload.attributes as Record<
      string,
      any[]
    >;
    expect(attributes.model_number[0]).toMatchObject({
      marketplace_id: "A1F83G8C2ARO7P",
      value: "4542804056341",
    });
    expect(attributes.externally_assigned_product_identifier[0]).toMatchObject({
      marketplace_id: "A1F83G8C2ARO7P",
      type: "ean",
      value: "4542804056341",
    });
    expect(
      attributes.supplier_declared_has_product_identifier_exemption,
    ).toBeUndefined();
    expect(attributes.size[0]).toMatchObject({
      value: "One Size",
      language_tag: "en_GB",
    });
    expect(attributes.color[0]).toMatchObject({
      value: "Multicoloured",
      language_tag: "en_GB",
    });
    expect(attributes.number_of_items[0]).toMatchObject({ value: 40 });
    expect(attributes.unit_count[0]).toMatchObject({
      value: 40,
      type: {
        value: "count",
        language_tag: "en_GB",
      },
    });
    expect(attributes.safety_warning[0]).toMatchObject({
      language_tag: "en_GB",
    });
    expect(attributes.safety_warning[0].value).toContain(
      "Not suitable for children under 3 years",
    );
    expect(attributes.warranty_description).toBeUndefined();
  });
});
