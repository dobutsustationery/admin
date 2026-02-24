import { describe, it, expect } from "vitest";
import {
  stripGoogleSizeSuffix,
  applyGoogleSizeSuffix,
  SIZE_SUFFIXES,
  extractGoogleDriveFileId,
  toGoogleDrivePublicImageUrl,
} from "../../src/lib/drive-url";

describe("SIZE_SUFFIXES", () => {
  it("maps thumbnail to =s200", () => {
    expect(SIZE_SUFFIXES.thumbnail).toBe("=s200");
  });
  it("maps preview to =s800", () => {
    expect(SIZE_SUFFIXES.preview).toBe("=s800");
  });
  it("maps full to =s0", () => {
    expect(SIZE_SUFFIXES.full).toBe("=s0");
  });
});

describe("stripGoogleSizeSuffix", () => {
  it("strips =s0", () => {
    expect(
      stripGoogleSizeSuffix("https://lh3.googleusercontent.com/d/FILE_ID=s0"),
    ).toBe("https://lh3.googleusercontent.com/d/FILE_ID");
  });

  it("strips =s200", () => {
    expect(
      stripGoogleSizeSuffix("https://lh3.googleusercontent.com/d/FILE_ID=s200"),
    ).toBe("https://lh3.googleusercontent.com/d/FILE_ID");
  });

  it("strips =s800", () => {
    expect(
      stripGoogleSizeSuffix("https://lh3.googleusercontent.com/d/FILE_ID=s800"),
    ).toBe("https://lh3.googleusercontent.com/d/FILE_ID");
  });

  it("strips compound suffixes like =w400-h300-c", () => {
    expect(
      stripGoogleSizeSuffix(
        "https://lh3.googleusercontent.com/photo/ID=w400-h300-c",
      ),
    ).toBe("https://lh3.googleusercontent.com/photo/ID");
  });

  it("strips =d suffix", () => {
    expect(
      stripGoogleSizeSuffix("https://lh3.googleusercontent.com/d/FILE_ID=d"),
    ).toBe("https://lh3.googleusercontent.com/d/FILE_ID");
  });

  it("returns URL unchanged when no suffix present", () => {
    const url = "https://lh3.googleusercontent.com/d/FILE_ID";
    expect(stripGoogleSizeSuffix(url)).toBe(url);
  });

  it("leaves a URL with no trailing =suffix unchanged", () => {
    // A plain URL with no =[...] suffix at the end is returned as-is
    const url = "https://lh3.googleusercontent.com/d/FILE_ID";
    expect(stripGoogleSizeSuffix(url)).toBe(url);
  });
});

describe("applyGoogleSizeSuffix", () => {
  it("replaces existing =s0 with thumbnail suffix", () => {
    expect(
      applyGoogleSizeSuffix(
        "https://lh3.googleusercontent.com/d/FILE_ID=s0",
        "thumbnail",
      ),
    ).toBe("https://lh3.googleusercontent.com/d/FILE_ID=s200");
  });

  it("replaces existing =s200 with preview suffix", () => {
    expect(
      applyGoogleSizeSuffix(
        "https://lh3.googleusercontent.com/d/FILE_ID=s200",
        "preview",
      ),
    ).toBe("https://lh3.googleusercontent.com/d/FILE_ID=s800");
  });

  it("replaces existing compound suffix with full", () => {
    expect(
      applyGoogleSizeSuffix(
        "https://lh3.googleusercontent.com/photo/ID=w400-h300-c",
        "full",
      ),
    ).toBe("https://lh3.googleusercontent.com/photo/ID=s0");
  });

  it("appends thumbnail suffix when no suffix present", () => {
    expect(
      applyGoogleSizeSuffix(
        "https://lh3.googleusercontent.com/d/FILE_ID",
        "thumbnail",
      ),
    ).toBe("https://lh3.googleusercontent.com/d/FILE_ID=s200");
  });

  it("leaves non-Google URLs unchanged for all sizes", () => {
    const url = "https://cdn.shopify.com/products/image.jpg";
    expect(applyGoogleSizeSuffix(url, "thumbnail")).toBe(url);
    expect(applyGoogleSizeSuffix(url, "preview")).toBe(url);
    expect(applyGoogleSizeSuffix(url, "full")).toBe(url);
  });

  it("leaves non-Google http URLs unchanged", () => {
    const url = "https://example.com/image.jpg";
    expect(applyGoogleSizeSuffix(url, "full")).toBe(url);
  });
});

describe("extractGoogleDriveFileId", () => {
  it("extracts file ID from lh3 Drive URL with size suffix", () => {
    expect(
      extractGoogleDriveFileId(
        "https://lh3.googleusercontent.com/d/FILE_ID_abc123=s200",
      ),
    ).toBe("FILE_ID_abc123");
  });

  it("extracts file ID from drive.google.com/file/d/ URL", () => {
    expect(
      extractGoogleDriveFileId(
        "https://drive.google.com/file/d/FILE_ID_abc123/view",
      ),
    ).toBe("FILE_ID_abc123");
  });
});

describe("toGoogleDrivePublicImageUrl", () => {
  it("produces a full-size =s0 URL from a Drive share link", () => {
    expect(
      toGoogleDrivePublicImageUrl(
        "https://drive.google.com/file/d/FILE_ID_abc/view",
      ),
    ).toBe("https://lh3.googleusercontent.com/d/FILE_ID_abc=s0");
  });

  it("returns non-Drive URLs unchanged", () => {
    const url = "https://cdn.shopify.com/products/image.jpg";
    expect(toGoogleDrivePublicImageUrl(url)).toBe(url);
  });
});
