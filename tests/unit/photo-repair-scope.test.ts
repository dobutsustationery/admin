import { describe, it, expect } from "vitest";
import {
  stockedPhotoTasks,
  groupRepairPhotosByListing,
  taskAssessment,
  taskForEntry,
  photoNeedsWork,
  preferredStockEntry,
} from "../../src/lib/photo-repair-scope";
import { initialPhotoRepair } from "../../src/lib/photo-repair";
function fixture() {
  return {
    inventory: {
      idToItem: {
        bad: {
          janCode: "bad",
          description: "Small photo",
          qty: 5,
          shipped: 1,
          image: "https://example.com/bad",
        },
        good: {
          janCode: "good",
          description: "Fixed photo",
          qty: 2,
          image: "https://example.com/good",
        },
        missing: {
          janCode: "missing",
          description: "No photo",
          qty: 1,
          image: "",
        },
        sold: {
          janCode: "sold",
          qty: 1,
          shipped: 1,
          image: "https://example.com/sold",
        },
      },
    },
    listings: {
      idToHandle: {
        missing: "missing-product",
        bad: "product",
        good: "product",
      },
      handleToListing: {
        product: { title: "Product", images: [], status: "active" },
        "missing-product": {
          title: "Missing product",
          images: [],
          status: "active",
        },
      },
    },
    photos: {
      registry: {
        unused: { id: "unused", baseUrl: "https://example.com/unused" },
      },
      selected: [],
      janCodeToPhotos: {},
    },
    listingCreation: { proposals: {} },
    photoRepair: structuredClone(initialPhotoRepair),
  } as any;
}
describe("stocked current-photo work", () => {
  it("starts with positive stock and includes missing photos without creating library-only work", () => {
    const root = fixture();
    const tasks = stockedPhotoTasks(root);
    expect(tasks).toHaveLength(3);
    expect(
      tasks.some((t) => t.url.includes("sold") || t.url.includes("unused")),
    ).toBe(false);
    const missing = tasks.find((t) => t.missing)!;
    expect(missing.targets.map((t) => t.ref.kind)).toEqual([
      "inventory",
      "listing_new_image",
    ]);
    expect(taskAssessment(root, missing)).toBe("Missing photo");
  });
  it("excludes stocked inventory and library photos without a saved listing", () => {
    const root = fixture();
    root.inventory.idToItem.standalone = {
      qty: 10,
      image: "https://example.com/standalone",
      handle: "not-a-listing",
    };
    expect(
      stockedPhotoTasks(root).some((t) => t.url.includes("standalone")),
    ).toBe(false);
  });
  it("groups multiple photos into one listing row without counting its stock twice", () => {
    const root = fixture();
    const photos = stockedPhotoTasks(root).map((task) => ({ task }));
    const groups = groupRepairPhotosByListing(root, photos);
    const product = groups.find((g) => g.handle === "product")!;
    expect(product.photos).toHaveLength(2);
    expect(product.stock).toBe(6);
    expect(product.jans).toBe("bad, good");
    expect(groups).toHaveLength(2);
  });
  it("keeps historical listing repairs grouped but hides standalone history", () => {
    const root = fixture();
    const groups = groupRepairPhotosByListing(root, [
      {
        e: { targets: [{ ref: { kind: "inventory", itemKey: "bad" } }] } as any,
      },
      {
        e: {
          targets: [
            {
              ref: { kind: "listing_image", handle: "product", imageId: "old" },
            },
          ],
        } as any,
      },
      {
        e: {
          targets: [{ ref: { kind: "photo_registry", photoId: "unused" } }],
        } as any,
      },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].photos).toHaveLength(2);
  });
  it("shows a shared photo under each listing while retaining one repair task", () => {
    const root = fixture();
    root.listings.handleToListing.second = { title: "Second", images: [] };
    root.listings.idToHandle.good = "second";
    root.inventory.idToItem.good.image = root.inventory.idToItem.bad.image;
    const tasks = stockedPhotoTasks(root).filter((t) => !t.missing);
    expect(tasks).toHaveLength(1);
    const groups = groupRepairPhotosByListing(
      root,
      tasks.map((task) => ({ task })),
    );
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.stock)).toEqual([4, 2]);
    expect(groups[0].photos[0].task).toBe(groups[1].photos[0].task);
  });
  it("uses the current file measurement instead of the photo's past bad import", () => {
    const root = fixture();
    const tasks = stockedPhotoTasks(root);
    root.photoRepair.measurementsByKey = {
      "https://example.com/bad": { width: 300, height: 512 },
      "https://example.com/good": { width: 1600, height: 1200 },
    };
    expect(
      taskAssessment(root, tasks.find((t) => t.itemKeys.includes("good"))!),
    ).toBe("Good size");
    expect(
      photoNeedsWork(
        taskAssessment(root, tasks.find((t) => t.itemKeys.includes("good"))!),
      ),
    ).toBe(false);
    expect(
      taskAssessment(root, tasks.find((t) => t.itemKeys.includes("bad"))!),
    ).toBe("Small photo");
  });
  it("does not label unreadable or unchecked files as good", () => {
    const root = fixture();
    const task = stockedPhotoTasks(root).find((t) =>
      t.itemKeys.includes("bad"),
    )!;
    expect(taskAssessment(root, task)).toBe("Not checked");
    root.photoRepair.measurementsByKey = {
      [task.url]: { url: task.url, message: "could not load" },
    };
    expect(taskAssessment(root, task)).toBe("Needs a look");
  });
  it("remembers a visual decision for that file, but not for a later replacement", () => {
    const root = fixture();
    const task = stockedPhotoTasks(root).find((t) =>
      t.itemKeys.includes("bad"),
    )!;
    root.photoRepair.photoReviewsByKey = {
      [task.url]: { url: task.url, good: true },
    };
    expect(taskAssessment(root, task)).toBe("Photo is good");
    expect(
      taskAssessment(root, { ...task, url: "https://example.com/replaced" }),
    ).toBe("Not checked");
    root.photoRepair.photoReviewsByKey[task.url].good = false;
    expect(taskAssessment(root, task)).toBe("Needs a better photo");
  });
  it("rechecks a changed Shopify master version even when the filename stays the same", () => {
    const root = fixture();
    const task = stockedPhotoTasks(root).find((t) =>
      t.itemKeys.includes("bad"),
    )!;
    root.photoRepair.photoReviewsByKey = {
      "https://cdn.shopify.com/files/photo.png?v=1": {
        url: "https://cdn.shopify.com/files/photo.png?v=1",
        good: true,
      },
    };
    expect(
      taskAssessment(root, {
        ...task,
        url: "https://cdn.shopify.com/files/photo.png?v=1&width=200",
      }),
    ).toBe("Photo is good");
    expect(
      taskAssessment(root, {
        ...task,
        url: "https://cdn.shopify.com/files/photo.png?v=2",
      }),
    ).toBe("Not checked");
  });
  it("groups shared current uses once and deduplicates repeated photo-group members", () => {
    const root = fixture();
    root.listings.idToHandle.other = "product";
    root.inventory.idToItem.other = {
      janCode: "other",
      qty: 3,
      image: "https://example.com/bad",
    };
    root.photos.janCodeToPhotos.bad = [
      { id: "duplicate", baseUrl: "https://example.com/bad" },
      { id: "duplicate", baseUrl: "https://example.com/bad" },
    ];
    const task = stockedPhotoTasks(root).find(
      (t) => t.url === "https://example.com/bad",
    )!;
    expect(task.itemKeys).toEqual(["bad", "other"]);
    expect(task.stock).toBe(7);
    expect(
      task.targets.filter((t) => t.ref.kind === "photo_group"),
    ).toHaveLength(1);
  });
  it("keeps old discovery entries out when they no longer match current stock or photos", () => {
    const root = fixture();
    const tasks = stockedPhotoTasks(root);
    expect(
      taskForEntry(
        root,
        { oldImageUrl: "https://example.com/unused" } as any,
        tasks,
      ),
    ).toBeUndefined();
    expect(
      taskForEntry(
        root,
        { oldImageUrl: "https://example.com/sold" } as any,
        tasks,
      ),
    ).toBeUndefined();
  });
  it("reuses an existing attempt instead of making the user repair a shared file twice", () => {
    const root = fixture();
    const task = stockedPhotoTasks(root).find((t) =>
      t.itemKeys.includes("bad"),
    )!;
    root.photoRepair.entriesById = {
      first: {
        entryId: "first",
        sourceId: "source",
        oldImageUrl: task.url,
        targets: task.targets,
        fact: { atMs: 1 },
      },
      working: {
        entryId: "working",
        sourceId: "source",
        oldImageUrl: task.url,
        targets: task.targets,
        selectedAttemptId: "attempt",
        fact: { atMs: 2 },
      },
    };
    expect(preferredStockEntry(root, task)?.entryId).toBe("working");
  });
  it("uses an existing gallery fallback and preserves the blank variant reference to fill on approval", () => {
    const root = fixture();
    root.listings.handleToListing["missing-product"].images = [
      { id: "fallback", url: "https://example.com/gallery", position: 1 },
    ];
    const task = stockedPhotoTasks(root).find((t) =>
      t.itemKeys.includes("missing"),
    )!;
    expect(task.missing).toBe(false);
    expect(task.url).toBe("https://example.com/gallery");
    expect(
      task.targets.find((t) => t.ref.kind === "inventory")?.beforeUrl,
    ).toBe("");
  });
});
