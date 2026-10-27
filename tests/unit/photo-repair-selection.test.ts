import { describe, expect, it } from "vitest";
import { rootReducer } from "../../src/lib/root-reducer";
import { stockedPhotoTasks } from "../../src/lib/photo-repair-scope";
import {
  repairSelectionSources,
  matchRepairSelections,
} from "../../src/lib/photo-repair-selection";
import type { MediaItem } from "../../src/lib/google-photos";

function fixture() {
  const root: any = structuredClone(
    rootReducer(undefined, { type: "@@init" }, () => {}),
  );
  root.inventory.idToItem.item = {
    qty: 10,
    image: "old-one",
    handle: "listing",
  };
  root.listings.handleToListing.listing = {
    title: "Listing",
    images: [
      { id: "one", url: "old-one" },
      { id: "two", url: "old-two" },
    ],
  };
  for (const name of ["one", "two"]) {
    root.photos.registry[name] = {
      id: name,
      filename: `${name}.HEIC`,
      mediaMetadata: { creationTime: "2026-05-03T12:00:00Z" },
    };
    root.photoRepair.sourcesById[name] = {
      sourceId: name,
      originalGoogleMediaId: `google-${name}`,
      importsById: {},
    };
    root.photoRepair.entriesById[name] = {
      entryId: name,
      sourceId: name,
      existingPhotoId: name,
      oldImageUrl: `old-${name}`,
      targets: [],
      attemptIds: [],
      fact: { atMs: 1 },
    };
  }
  return root;
}
function selected(id: string): MediaItem {
  return {
    id,
    filename: "same-filename.HEIC",
    baseUrl: `fresh-${id}`,
    mimeType: "image/jpeg",
    productUrl: "",
  };
}
describe("selection before photo repair", () => {
  it("groups the needed originals by capture date and keeps their reference images", () => {
    const root = fixture();
    const sources = repairSelectionSources(root, stockedPhotoTasks(root));
    expect(
      sources.map((s) => [s.mediaItemId, s.filename, s.date, s.url]),
    ).toEqual([
      ["google-one", "one.HEIC", "2026-05-03", "old-one"],
      ["google-two", "two.HEIC", "2026-05-03", "old-two"],
    ]);
  });
  it("matches by persistent ID, deduplicates picker results and leaves extra photos unassigned", () => {
    const root = fixture();
    const sources = repairSelectionSources(root, stockedPhotoTasks(root));
    const result = matchRepairSelections(sources, [
      selected("extra"),
      selected("google-two"),
      selected("google-one"),
      selected("google-one"),
    ]);
    expect(
      result.matches.map((m) => [m.source.entry.entryId, m.photo.id]),
    ).toEqual([
      ["one", "google-one"],
      ["two", "google-two"],
    ]);
    expect(result.unmatched.map((p) => p.id)).toEqual(["extra"]);
  });
  it("does not reimport an existing original and leaves in-flight imports alone", () => {
    const root = fixture();
    root.photoRepair.sourcesById.one.currentImportId = "import";
    root.photoRepair.sourcesById.one.importsById.import = {
      result: { artifact: { url: "durable-original" } },
    };
    root.photoRepair.sourcesById.two.currentImportId = "import";
    root.photoRepair.sourcesById.two.importsById.import = {};
    const sources = repairSelectionSources(root, stockedPhotoTasks(root));
    expect(sources.map((s) => s.entry.entryId)).toEqual(["two"]);
    expect(sources[0].importing).toBe(true);
    const all = repairSelectionSources(
      root,
      stockedPhotoTasks(root),
      undefined,
      true,
    );
    expect(all.find((s) => s.entry.entryId === "one")?.imported).toBe(true);
    expect(all.find((s) => s.entry.entryId === "two")?.importing).toBe(true);
    expect(
      matchRepairSelections(all, [
        selected("google-one"),
        selected("google-two"),
      ]).matches,
    ).toHaveLength(0);

    expect(
      matchRepairSelections(sources, [
        selected("google-one"),
        selected("google-two"),
      ]).matches,
    ).toHaveLength(0);
  });
  it("allows fresh selection after an import fails and excludes good and unlisted images", () => {
    const root = fixture();
    root.photoRepair.sourcesById.one.currentImportId = "failed";
    root.photoRepair.sourcesById.one.importsById.failed = {
      result: { message: "expired" },
    };
    root.photoRepair.photoReviewsByKey = { "old-two": { good: true } };
    const sources = repairSelectionSources(root, stockedPhotoTasks(root));
    expect(
      matchRepairSelections(sources, [selected("google-one")]).matches,
    ).toHaveLength(1);
    root.listings.handleToListing = {};
    expect(repairSelectionSources(root, stockedPhotoTasks(root))).toHaveLength(
      0,
    );
  });
});
