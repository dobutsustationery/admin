import { describe, it, expect } from "vitest";
import {
  offerReviewPricing,
  localOfferImage,
} from "../../src/lib/amazon-offer-review";
import {
  initialPreparation,
  emptyPreparationDraft,
  preparationDraftScope,
  preparationScope,
} from "../../src/lib/amazon-preparation";
import { offerMatches } from "../../src/lib/amazon-offer-matches";
const row = {
  key: "blue",
  jan: "4542804044355",
  family: "paper",
  sharedJan: true,
};
describe("visual offer review", () => {
  it("reuses saved pricing without adopting unrelated draft decisions", () => {
    const prep = {
      ...initialPreparation,
      drafts: {
        [preparationDraftScope("seller", "user")]: {
          ...emptyPreparationDraft(),
          gbpPerEur: "0.9",
          decisions: { blue: { deferred: true } },
        },
      },
    };
    const result = offerReviewPricing(prep, "seller", "user");
    expect(result.factor).toBe("0.9");
    expect(result.prep.decisions).toEqual({});
    expect(prep.policies).toEqual({});
    expect(offerReviewPricing(prep, "seller", "other").factor).toBe("");
    expect(
      offerReviewPricing(
        {
          ...prep,
          policies: { [preparationScope("seller")]: { gbpPerEur: "0.8" } },
        },
        "seller",
        "user",
      ).factor,
    ).toBe("0.8");
  });
  it("prefers the variant photo and labels shared/gallery fallbacks", () => {
    const photos = {
      janCodeToPhotos: { [row.jan]: [{ id: "p", baseUrl: "shared.jpg" }] },
    };
    expect(
      localOfferImage(
        row,
        { idToItem: { blue: { image: "blue.jpg" } } },
        {},
        photos,
      ).url,
    ).toBe("blue.jpg");
    expect(localOfferImage(row, {}, {}, photos).label).toContain(
      "shared-barcode",
    );
    expect(
      localOfferImage(
        row,
        {},
        {
          handleToListing: {
            paper: { images: [{ url: "gallery.jpg", position: 1 }] },
          },
        },
        {},
      ).label,
    ).toContain("gallery");
    expect(localOfferImage(row, {}, {}, {}).url).toBe("");
  });
  it("uses a current registry URL for variant photos", () => {
    expect(
      localOfferImage(
        row,
        {},
        {},
        {
          janCodeToPhotos: { blue: [{ id: "p", baseUrl: "old" }] },
          registry: { p: { baseUrl: "current" } },
        },
      ).url,
    ).toBe("current");
  });
  it("selects the large main Amazon photo for the target marketplace", () => {
    const catalog = {
      rawResponsesById: {
        r: {
          kind: "catalog_search_by_jan",
          key: row.jan,
          sellerId: "seller",
          marketplaceId: "A1F83G8C2ARO7P",
          ok: true,
          status: 200,
          fetchedAtMs: 1,
          raw: {
            items: [
              {
                asin: "B012345678",
                images: [
                  {
                    marketplaceId: "A1F83G8C2ARO7P",
                    images: [
                      { link: "small", variant: "MAIN", width: 75, height: 75 },
                      {
                        link: "back",
                        variant: "PT01",
                        width: 1000,
                        height: 1000,
                      },
                      {
                        link: "large",
                        variant: "MAIN",
                        width: 500,
                        height: 500,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
    };
    expect(offerMatches(catalog, "seller", row.jan).candidates[0].image).toBe(
      "large",
    );
  });
});
