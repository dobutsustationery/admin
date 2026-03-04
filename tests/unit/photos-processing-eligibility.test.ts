import { describe, expect, it } from "vitest";
import { shouldProcessPhotoFromHistory } from "../../src/lib/photos-processing-eligibility";

describe("photos processing eligibility", () => {
  it("allows processing when there is no prior processed history", () => {
    expect(
      shouldProcessPhotoFromHistory({
        currentUrl: "https://drive.google.com/thumbnail?id=root",
        urlHistory: ["https://drive.google.com/thumbnail?id=root"],
      }),
    ).toBe(true);
  });

  it("blocks processing when current image is not the root/original", () => {
    expect(
      shouldProcessPhotoFromHistory({
        currentUrl: "https://drive.google.com/thumbnail?id=processed",
        urlHistory: [
          "https://drive.google.com/thumbnail?id=processed",
          "https://drive.google.com/thumbnail?id=root",
        ],
      }),
    ).toBe(false);
  });

  it("allows processing when user reset current image to root", () => {
    expect(
      shouldProcessPhotoFromHistory({
        currentUrl: "https://drive.google.com/thumbnail?id=root",
        urlHistory: [
          "https://drive.google.com/thumbnail?id=root",
          "https://drive.google.com/thumbnail?id=processed",
          "https://drive.google.com/thumbnail?id=root",
        ],
      }),
    ).toBe(true);
  });
});
