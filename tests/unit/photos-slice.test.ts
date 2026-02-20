import { describe, expect, it } from "vitest";
import { photos, select_photos, register_media_items, complete_upload } from "../../src/lib/photos-slice";

describe("photos slice", () => {
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

    const registered = photos(initial, register_media_items({ items: [item] }));
    const state = photos(registered, select_photos({ ids: ["photo-1"] }));

    expect(state.urlHistory["photo-1"]).toEqual([]);
    expect(state.selected[0].baseUrl).toContain("googleusercontent.com/ppa/");
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
    const withSelection = photos(registered, select_photos({ ids: ["photo-1"] }));

    const final = photos(
      withSelection,
      complete_upload({
        id: "photo-1",
        permanentUrl: "https://drive.google.com/thumbnail?id=drive-file-id",
        webViewLink: "https://drive.google.com/file/d/drive-file-id/view",
      }),
    );

    expect(final.urlHistory["photo-1"][0]).toContain("drive.google.com/thumbnail");
    expect(final.selected[0].baseUrl).toContain("drive.google.com/thumbnail");
  });
});

