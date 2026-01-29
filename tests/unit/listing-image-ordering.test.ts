import { describe, expect, it } from "vitest";
import { reorderListingImages } from "$lib/listing-image-ordering";

describe("reorderListingImages", () => {
  it("orders variant images by SKU and gallery images after them", () => {
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

    const result = reorderListingImages({
      listingImages,
      associatedItems,
      sourceId: "g-1",
      targetId: "g-2",
      listingOnlyImages: [{ id: "g-1" }, { id: "g-2" }],
    });

    expect(result).toBeTruthy();
    if (!result) return;

    const orderedIds = result.updatedImages.map((img) => img.id);
    expect(orderedIds).toEqual(["v-a", "v-b", "g-2", "g-1"]);

    const positions = result.updatedImages.reduce<Record<string, number>>(
      (acc, img) => {
        acc[img.id] = img.position;
        return acc;
      },
      {},
    );
    expect(positions).toEqual({
      "v-a": 1,
      "v-b": 2,
      "g-2": 3,
      "g-1": 4,
    });

    expect(result.reorderedGalleryIds).toEqual(["g-2", "g-1"]);
    expect(result.updatedListingOnly).toEqual([
      { id: "g-1", position: 4 },
      { id: "g-2", position: 3 },
    ]);
  });

  it("returns null when source/target not in gallery subset", () => {
    const listingImages = [{ id: "v-a", url: "img-a", position: 1, altText: "A" }];
    const associatedItems = [{ id: "sku-a", image: "img-a" }];

    const result = reorderListingImages({
      listingImages,
      associatedItems,
      sourceId: "v-a",
      targetId: "v-a",
      listingOnlyImages: [],
    });

    expect(result).toBeNull();
  });
});
