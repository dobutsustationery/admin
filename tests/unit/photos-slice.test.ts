import { describe, expect, it } from "vitest";
import {
  photos,
  select_photos,
  register_media_items,
  complete_upload,
  set_processing_config,
  categorize_photo,
  rename_jan_group,
} from "../../src/lib/photos-slice";

describe("photos slice", () => {
  it("allows updating processing configuration", () => {
    const initial = photos(undefined, { type: "@@INIT" } as any);
    expect(initial.processingConfig.steps).toEqual([
      { type: "crop", enabled: false },
      { type: "color_correct", enabled: true },
      { type: "remove_background", enabled: true },
    ]);

    const next = photos(
      initial,
      set_processing_config({
        steps: [
          { type: "remove_background", enabled: true },
          { type: "crop", enabled: true },
          { type: "color_correct", enabled: false },
        ],
      }),
    );

    expect(next.processingConfig.steps).toEqual([
      { type: "remove_background", enabled: true },
      { type: "crop", enabled: true },
      { type: "color_correct", enabled: false },
    ]);
  });

  it("does not persist ephemeral googleusercontent URLs into history on initial selection", () => {
    const initial = photos(undefined, { type: "@@INIT" } as any);
    const item = {
      id: "photo-1",
      baseUrl: "https://lh3.googleusercontent.com/ppa/abc123",
      productUrl: "",
      mimeType: "image/jpeg",
      filename: "one.jpg",
      mediaMetadata: { creationTime: "", width: "1", height: "1" },
    };

    const next = photos(initial, select_photos({ ids: ["photo-1"] }));
    // Registry is empty, so select_photos should return empty selected
    expect(next.selected).toEqual([]);

    // Now register it
    const registered = photos(initial, register_media_items({ items: [item] }));
    expect(registered.registry["photo-1"]).toBeDefined();
    // history should remain empty for ephemeral URL
    expect(registered.urlHistory["photo-1"]).toEqual([]);

    const selected = photos(registered, select_photos({ ids: ["photo-1"] }));
    expect(selected.selected[0].id).toBe("photo-1");
  });

  it("stores durable upload URL as current history entry", () => {
    const initial = photos(undefined, { type: "@@INIT" } as any);
    const item = {
      id: "photo-1",
      baseUrl: "https://lh3.googleusercontent.com/ppa/abc123",
      productUrl: "",
      mimeType: "image/jpeg",
      filename: "one.jpg",
      mediaMetadata: { creationTime: "", width: "1", height: "1" },
    };

    const registered = photos(initial, register_media_items({ items: [item] }));
    const selected = photos(registered, select_photos({ ids: ["photo-1"] }));

    const final = photos(
      selected,
      complete_upload({
        id: "photo-1",
        permanentUrl: "https://drive.google.com/thumbnail?id=drive-file-id",
        webViewLink: "https://drive.google.com/file/d/drive-file-id/view",
      }),
    );

    expect(final.urlHistory["photo-1"][0]).toContain(
      "drive.google.com/thumbnail",
    );
    expect(final.selected[0].baseUrl).toContain("drive.google.com/thumbnail");
  });

  it("merges JAN groups when renaming into an existing JAN key", () => {
    const initial = photos(undefined, { type: "@@INIT" } as any);
    const photoA = {
      id: "photo-a",
      baseUrl: "https://drive.google.com/thumbnail?id=a",
      productUrl: "",
      mimeType: "image/jpeg",
      filename: "a.jpg",
      mediaMetadata: { creationTime: "", width: "1", height: "1" },
    };
    const photoB = {
      id: "photo-b",
      baseUrl: "https://drive.google.com/thumbnail?id=b",
      productUrl: "",
      mimeType: "image/jpeg",
      filename: "b.jpg",
      mediaMetadata: { creationTime: "", width: "1", height: "1" },
    };

    const withGroups = photos(
      photos(
        initial,
        categorize_photo({ janCode: "1111111111111", photo: photoA }),
      ),
      categorize_photo({ janCode: "2222222222222", photo: photoB }),
    );

    const renamed = photos(
      withGroups,
      rename_jan_group({
        oldJan: "1111111111111",
        newJan: "2222222222222",
      }),
    );

    expect(renamed.janCodeToPhotos["1111111111111"]).toBeUndefined();
    expect(
      renamed.janCodeToPhotos["2222222222222"].map((p) => p.id).sort(),
    ).toEqual(["photo-a", "photo-b"]);
  });
});
