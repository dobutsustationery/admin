import { describe, it, expect } from "vitest";
import { rootReducer } from "../../src/lib/root-reducer";
import {
  candidateFor,
  repairStatus,
  allImageTargets,
} from "../../src/lib/photo-repair";
const quiet = () => {};
const artifact = {
  driveFileId: "new-file",
  url: "new-url",
  webViewLink: "new-view",
  filename: "new.png",
  mimeType: "image/png",
};
function fixture() {
  let state = structuredClone(
    rootReducer(undefined, { type: "@@init" }, quiet),
  );
  const photo = {
    id: "old-photo",
    baseUrl: "old-url",
    productUrl: "old-view",
    filename: "original.heic",
    mimeType: "image/heic",
  };
  state.photos.registry[photo.id] = photo;
  state.photos.registry["alias-photo"] = { ...photo, id: "alias-photo" };
  state.photos.urlHistory["alias-photo"] = ["old-url"];
  state.photos.selected = [structuredClone(photo)];
  state.photos.janCodeToPhotos.JAN = [structuredClone(photo)];
  state.photos.urlHistory[photo.id] = ["old-url"];
  state.inventory.idToItem.item = {
    janCode: "JAN",
    image: "old-url",
    qty: 10,
    shipped: 2,
    imagePosition: 2,
  };
  state.listings.idToHandle.item = "product";
  state.listings.handleToListing.product = {
    handle: "product",
    status: "active",
    lastUpdated: 0,
    images: [
      {
        id: "local-listing-image",
        url: "old-url",
        position: 2,
        altText: "Keep this",
      },
    ],
  };
  state.listingCreation.proposals.JAN = {
    variants: [{ id: "variant", image: "old-url", photoGroupKey: "JAN" }],
    listingOnlyImages: [{ id: "draft-image", url: "old-url", position: 1 }],
    listingImageOrder: ["draft-image", "old-photo"],
  };
  const apply = (
    type: string,
    payload: any,
    id = type + JSON.stringify(payload),
  ) => {
    state = rootReducer(
      state,
      {
        type: `photoRepair/${type}`,
        payload,
        id,
        creator: "user",
        timestamp: 1000,
      },
      quiet,
    );
    return state;
  };
  apply("sourceAdded", {
    sourceId: "source",
    originalGoogleMediaId: "google-original",
  });
  const targets = allImageTargets(state);
  apply("entryAdded", {
    entryId: "entry",
    sourceId: "source",
    existingPhotoId: "old-photo",
    oldImageUrl: "old-url",
    targets,
    evidence: { kind: "bad_import", transferEventIds: ["bad-import"] },
  });
  apply("originalRequested", {
    sourceId: "source",
    importId: "import",
    requestId: "import-request",
    choice: {
      kind: "google_photos",
      mediaItemId: "google-original",
      filename: "original.heic",
    },
  });
  apply("originalImported", {
    sourceId: "source",
    importId: "import",
    requestId: "import-request",
    artifact,
  });
  return { get: () => state, apply, targets };
}
describe("photo repair identity and review", () => {
  it("keeps imported and processed candidates out of all existing product data until approval", () => {
    const f = fixture();
    f.apply("attemptStarted", {
      entryId: "entry",
      attemptId: "attempt",
      importId: "import",
      steps: [{ kind: "color_correct" }],
    });
    f.apply("stepRequested", {
      attemptId: "attempt",
      stepIndex: 0,
      requestId: "step",
    });
    f.apply("stepCompleted", {
      attemptId: "attempt",
      stepIndex: 0,
      requestId: "step",
      artifact,
    });
    const s = f.get();
    expect(allImageTargets(s).every((t) => t.beforeUrl === "old-url")).toBe(
      true,
    );
    expect(s.photos.registry["repair:entry:attempt"]).toBeUndefined();
    expect(repairStatus(s.photoRepair, s.photoRepair.entriesById.entry)).toBe(
      "Needs review",
    );
    f.apply("approved", {
      approvalId: "approval",
      entryId: "entry",
      attemptId: "attempt",
      targets: f.targets,
    });
    const done = f.get();
    expect(allImageTargets(done).every((t) => t.beforeUrl === "new-url")).toBe(
      true,
    );
    expect(done.photos.registry["old-photo"].id).toBe("old-photo");
    expect(done.photos.registry["old-photo"].mimeType).toBe("image/png");
    expect(done.listings.handleToListing.product.images[0]).toEqual({
      id: "local-listing-image",
      url: "new-url",
      position: 2,
      altText: "Keep this",
    });
    expect(done.inventory.idToItem.item.qty).toBe(10);
    expect(done.listingCreation.proposals.JAN.listingImageOrder).toEqual([
      "draft-image",
      "old-photo",
    ]);
    expect(done.photos.urlHistory["alias-photo"]).toEqual([
      "new-url",
      "old-url",
    ]);
    expect(done.photos.urlHistory["old-photo"]).toEqual(["new-url", "old-url"]);
    const snapshot = JSON.stringify(done);
    f.apply("approved", {
      approvalId: "approval",
      entryId: "entry",
      attemptId: "attempt",
      targets: f.targets,
    });
    expect(JSON.stringify(f.get())).toBe(snapshot);
  });
  it("applies none of an approval when a reference changed", () => {
    const f = fixture();
    f.apply("attemptStarted", {
      entryId: "entry",
      attemptId: "attempt",
      importId: "import",
      steps: [],
    });
    const targets = structuredClone(f.targets);
    targets[targets.length - 1].beforeUrl = "unexpected";
    f.apply("approved", {
      approvalId: "approval",
      entryId: "entry",
      attemptId: "attempt",
      targets,
    });
    expect(
      allImageTargets(f.get()).every((t) => t.beforeUrl === "old-url"),
    ).toBe(true);
    expect(f.get().photoRepair.approvalsById.approval.result).toBe(
      "references_changed",
    );
  });
  it("redo selects a new attempt and late old results cannot replace it", () => {
    const f = fixture();
    for (const attemptId of ["old", "new"]) {
      f.apply("attemptStarted", {
        entryId: "entry",
        attemptId,
        importId: "import",
        steps: [{ kind: "remove_bg" }],
      });
      f.apply("stepRequested", {
        attemptId,
        stepIndex: 0,
        requestId: attemptId,
      });
    }
    f.apply("stepCompleted", {
      attemptId: "old",
      stepIndex: 0,
      requestId: "old",
      artifact,
    });
    expect(
      candidateFor(f.get().photoRepair, f.get().photoRepair.entriesById.entry),
    ).toBeUndefined();
    f.apply("stepCompleted", {
      attemptId: "new",
      stepIndex: 0,
      requestId: "new",
      artifact: { ...artifact, url: "new-candidate" },
    });
    expect(
      candidateFor(f.get().photoRepair, f.get().photoRepair.entriesById.entry)
        ?.url,
    ).toBe("new-candidate");
  });
  it("reconstructs out-of-order worker results, and source reselection supersedes unapproved candidates", () => {
    const f = fixture();
    f.apply("stepCompleted", {
      attemptId: "attempt",
      stepIndex: 0,
      requestId: "step",
      artifact,
    });
    f.apply("attemptStarted", {
      entryId: "entry",
      attemptId: "attempt",
      importId: "import",
      steps: [{ kind: "remove_bg" }],
    });
    f.apply("stepRequested", {
      attemptId: "attempt",
      stepIndex: 0,
      requestId: "step",
    });
    expect(
      candidateFor(f.get().photoRepair, f.get().photoRepair.entriesById.entry)
        ?.url,
    ).toBe("new-url");
    f.apply("originalRequested", {
      sourceId: "source",
      importId: "reselected",
      requestId: "reselect",
      choice: { kind: "upload", filename: "fresh.png", mimeType: "image/png" },
    });
    expect(
      candidateFor(f.get().photoRepair, f.get().photoRepair.entriesById.entry),
    ).toBeUndefined();
    expect(Object.keys(f.get().photoRepair.pendingEventsById)).toHaveLength(0);
  });
  it("tracks Shopify failure and retry without undoing the approved local image", () => {
    const f = fixture();
    f.apply("attemptStarted", {
      entryId: "entry",
      attemptId: "attempt",
      importId: "import",
      steps: [],
    });
    f.apply("approved", {
      approvalId: "approval",
      entryId: "entry",
      attemptId: "attempt",
      targets: f.targets,
    });
    f.apply("publicationRequested", {
      publicationId: "pub",
      handle: "product",
      approvalIds: ["approval"],
      requestId: "req",
    });
    f.apply("publicationFinished", {
      publicationId: "pub",
      requestId: "req",
      outcome: "failed",
      syncEventId: "result",
    });
    expect(
      repairStatus(f.get().photoRepair, f.get().photoRepair.entriesById.entry),
    ).toBe("Sync failed");
    f.apply("publicationRequested", {
      publicationId: "pub2",
      handle: "product",
      approvalIds: ["approval"],
      requestId: "req2",
    });
    f.apply("publicationFinished", {
      publicationId: "pub2",
      requestId: "req2",
      outcome: "completed",
      syncEventId: "result2",
    });
    expect(
      repairStatus(f.get().photoRepair, f.get().photoRepair.entriesById.entry),
    ).toBe("Done");
    expect(f.get().inventory.idToItem.item.image).toBe("new-url");
  });
});
