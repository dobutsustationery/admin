import { describe, expect, it } from "vitest";
import { reorderListingImages } from "$lib/listing-image-ordering";

describe("reorderListingImages", () => {
  it("allows arbitrary reordering including variant images", () => {
    const listingImages = [
      { id: "v-b", url: "img-b", position: 1, altText: "B" },
      { id: "v-a", url: "img-a", position: 2, altText: "A" },
      { id: "g-1", url: "img-g1", position: 3, altText: "G1" },
      { id: "g-2", url: "img-g2", position: 4, altText: "G2" },
    ];

    const associatedItems = [
      { id: "sku-b", image: "img-b" },
      { id: "sku-a", image: "img-a" },
    ];

    // Move g-1 to g-2 (swap last two)
    const result = reorderListingImages({
      listingImages,
      associatedItems,
      sourceId: "g-1",
      targetId: "g-2",
      listingOnlyImages: [{ id: "g-1" }, { id: "g-2" }],
    });

    expect(result).toBeTruthy();
    if (!result) return;

    // Expect v-b, v-a (preserved order), g-2, g-1 (swapped)
    const orderedIds = result.updatedImages.map((img) => img.id);
    expect(orderedIds).toEqual(["v-b", "v-a", "g-2", "g-1"]);

    const positions = result.updatedImages.reduce<Record<string, number>>(
      (acc, img) => {
        acc[img.id] = img.position;
        return acc;
      },
      {},
    );
    expect(positions).toEqual({
      "v-b": 1,
      "v-a": 2,
      "g-2": 3,
      "g-1": 4,
    });

    expect(result.reorderedGalleryIds).toEqual(["v-b", "v-a", "g-2", "g-1"]);
  });

  it("returns result when reordering variant images", () => {
    const listingImages = [
        { id: "v-a", url: "img-a", position: 1, altText: "A" }, 
        { id: "v-b", url: "img-b", position: 2, altText: "B" }
    ];
    const associatedItems = [{ id: "sku-a", image: "img-a" }, { id: "sku-b", image: "img-b" }];

    const result = reorderListingImages({
      listingImages,
      associatedItems,
      sourceId: "v-a",
      targetId: "v-b",
      listingOnlyImages: [],
    });

    expect(result).toBeTruthy();
    expect(result?.updatedImages.map(i => i.id)).toEqual(["v-b", "v-a"]);
  });
});
