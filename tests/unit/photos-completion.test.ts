import { describe, expect, it } from "vitest";
import {
  buildCompletedPhotoGroupIndexes,
  isCompletedPhotoGroupKey,
} from "../../src/lib/photos-completion";

function item(janCode: string, subtype = "") {
  return {
    janCode,
    subtype,
    qty: 1,
    shipped: 0,
    description: "",
    image: "",
    pieces: 1,
  } as any;
}

function listing(optionLabels: Record<string, string> = {}) {
  return {
    handle: "listed-handle",
    title: "Listed",
    bodyHtml: "<p>Listed</p>",
    productCategory: "",
    productType: "",
    vendor: "",
    tags: [],
    status: "active",
    option1Name: "Subtype",
    variantOptionsByItemId: optionLabels,
    images: [],
    lastUpdated: 1,
  } as any;
}

describe("photos completion", () => {
  it("marks exact bare and subtype photo groups complete", () => {
    const indexes = buildCompletedPhotoGroupIndexes(
      {
        idToItem: {
          "4901681382316Standard": item("4901681382316", "Standard"),
        },
      },
      {
        idToHandle: { "4901681382316Standard": "listed-handle" },
        handleToListing: { "listed-handle": listing() },
      },
    );

    expect(isCompletedPhotoGroupKey("4901681382316", indexes)).toBe(true);
    expect(isCompletedPhotoGroupKey("4901681382316:Standard", indexes)).toBe(
      true,
    );
  });

  it("treats option-label photo groups as complete when the listed inventory item is bare", () => {
    const indexes = buildCompletedPhotoGroupIndexes(
      {
        idToItem: {
          "4901681382316": item("4901681382316"),
        },
      },
      {
        idToHandle: { "4901681382316": "listed-handle" },
        handleToListing: {
          "listed-handle": listing({ "4901681382316": "Standard" }),
        },
      },
    );

    expect(isCompletedPhotoGroupKey("4901681382316:Standard", indexes)).toBe(
      true,
    );
    expect(isCompletedPhotoGroupKey("4901681382316:Dark", indexes)).toBe(true);
  });

  it("does not hide a real unlisted subtype just because a sibling base JAN is listed", () => {
    const indexes = buildCompletedPhotoGroupIndexes(
      {
        idToItem: {
          "4542804089301Blue": item("4542804089301", "Blue"),
          "4542804089301Pink": item("4542804089301", "Pink"),
        },
      },
      {
        idToHandle: { "4542804089301Blue": "listed-handle" },
        handleToListing: { "listed-handle": listing() },
      },
    );

    expect(isCompletedPhotoGroupKey("4542804089301:Blue", indexes)).toBe(true);
    expect(isCompletedPhotoGroupKey("4542804089301:Pink", indexes)).toBe(false);
    expect(
      isCompletedPhotoGroupKey("4542804089301:Display Label", indexes),
    ).toBe(true);
  });
});
