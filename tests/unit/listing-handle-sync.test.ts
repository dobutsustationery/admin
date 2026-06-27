import { describe, expect, it } from "vitest";
import { rootReducer as _rootReducer } from "$lib/root-reducer";
// Fixtures omit the per-action timestamp that every replayed action
// carries in production; stamp one (deriveCreationTimestampMs fails
// loudly on a missing timestamp).
const rootReducer = (s: any, a: any) =>
  _rootReducer(
    s,
    a && typeof a === "object" && a.type && !("timestamp" in a)
      ? { ...a, timestamp: { _seconds: 1_700_000_000, _nanoseconds: 0 } }
      : a,
  );
import {
  replace_subtype,
  update_field,
  update_item,
  type Item,
} from "$lib/inventory";
import { create_listing, type Listing } from "$lib/listings-slice";

const makeListing = (handle: string, title: string, janCode = "123"): Listing =>
  ({
    handle,
    title,
    bodyHtml: "",
    productCategory: "",
    productType: "",
    vendor: "SPNSS Ltd.",
    tags: [],
    status: "active",
    option1Name: "Subtype",
    images: [],
    lastUpdated: 0,
    janCode,
  }) as Listing;

describe("inventory handle updates sync to listings", () => {
  it("does not create a listing when handle changes to a missing explicit handle", () => {
    const item: Item = {
      janCode: "4901234567890",
      subtype: "Red",
      description: "Test Item",
      hsCode: "49090000",
      image: "http://example.com/image.jpg",
      qty: 1,
      pieces: 1,
      shipped: 0,
      creationDate: "2024-01-01",
      timestamp: 0,
      handle: "old-handle",
    };
    const id = `${item.janCode}${item.subtype}`;

    let state = rootReducer(undefined as any, { type: "@@INIT" });
    state = rootReducer(
      state,
      create_listing({
        listing: makeListing("old-handle", item.description, item.janCode),
      }),
    );
    state = rootReducer(state, update_item({ id, item }));

    expect(state.listings.idToHandle[id]).toBe("old-handle");
    expect(state.listings.handleToListing["old-handle"]).toBeDefined();

    state = rootReducer(
      state,
      update_field({
        id,
        field: "handle",
        from: "old-handle",
        to: "new-handle",
      }),
    );

    expect(state.inventory.idToItem[id].handle).toBe("new-handle");
    expect(state.listings.idToHandle[id]).toBeUndefined();
    expect(state.listings.handleToListing["new-handle"]).toBeUndefined();
    expect(state.listings.handleToListing["old-handle"]).toBeDefined();
  });

  it("merges into existing listing when handle changes to an existing handle", () => {
    const itemA: Item = {
      janCode: "4901234567890",
      subtype: "Red",
      description: "Item A",
      hsCode: "49090000",
      image: "http://example.com/image-a.jpg",
      qty: 1,
      pieces: 1,
      shipped: 0,
      creationDate: "2024-01-01",
      timestamp: 0,
      handle: "handle-a",
    };
    const itemB: Item = {
      janCode: "4901234567890",
      subtype: "Blue",
      description: "Item B",
      hsCode: "49090000",
      image: "http://example.com/image-b.jpg",
      qty: 1,
      pieces: 1,
      shipped: 0,
      creationDate: "2024-01-01",
      timestamp: 0,
      handle: "handle-b",
    };
    const idA = `${itemA.janCode}${itemA.subtype}`;
    const idB = `${itemB.janCode}${itemB.subtype}`;

    let state = rootReducer(undefined as any, { type: "@@INIT" });
    state = rootReducer(
      state,
      create_listing({
        listing: makeListing("handle-a", itemA.description, itemA.janCode),
      }),
    );
    state = rootReducer(
      state,
      create_listing({
        listing: makeListing("handle-b", itemB.description, itemB.janCode),
      }),
    );
    state = rootReducer(state, update_item({ id: idA, item: itemA }));
    state = rootReducer(state, update_item({ id: idB, item: itemB }));

    expect(state.listings.handleToListing["handle-a"]).toBeDefined();
    expect(state.listings.handleToListing["handle-b"]).toBeDefined();

    state = rootReducer(
      state,
      update_field({
        id: idA,
        field: "handle",
        from: "handle-a",
        to: "handle-b",
      }),
    );

    expect(state.listings.idToHandle[idA]).toBe("handle-b");
    expect(state.listings.idToHandle[idB]).toBe("handle-b");
    expect(state.listings.handleToListing["handle-b"]).toBeDefined();
    expect(state.listings.handleToListing["handle-a"]).toBeDefined();
  });

  it("preserves a listing option label when a listed subtyped item normalizes to bare JAN", () => {
    const handle = "seal-do-washi-tape-neko-cats-kawaii-4582608265532";
    const item: Item = {
      janCode: "4582608265532",
      subtype: "Pink",
      description: "Seal Do Washi Tape",
      hsCode: "48114190",
      image: "http://example.com/pink.jpg",
      qty: 10,
      pieces: 1,
      shipped: 0,
      creationDate: "2025-01-25",
      timestamp: 0,
      handle,
    };
    const oldId = `${item.janCode}${item.subtype}`;

    let state = rootReducer(undefined as any, { type: "@@INIT" });
    state = rootReducer(
      state,
      create_listing({
        listing: makeListing(handle, item.description, item.janCode),
      }),
    );
    state = rootReducer(state, update_item({ id: oldId, item }));

    expect(state.listings.idToHandle[oldId]).toBe(handle);
    expect(
      state.listings.handleToListing[handle].variantOptionsByItemId,
    ).toBeUndefined();

    state = rootReducer(
      state,
      update_field({
        id: oldId,
        field: "subtype",
        from: "Pink",
        to: "",
      }),
    );

    const bareId = item.janCode;
    expect(state.inventory.idToItem[oldId]).toBeUndefined();
    expect(state.inventory.idToItem[bareId].subtype).toBe("");
    expect(state.listings.idToHandle[oldId]).toBeUndefined();
    expect(state.listings.idToHandle[bareId]).toBe(handle);
    expect(
      state.listings.handleToListing[handle].variantOptionsByItemId,
    ).toEqual({
      [bareId]: "Pink",
    });
  });

  it("updates a listing option label when it only reflected the old subtype", () => {
    const handle = "amifa-animal-flake-stickers-100-4542804141160";
    const item: Item = {
      janCode: "4542804141160",
      subtype: "Bunny",
      description: "Amifa Kawaii Mini Animal Flake Stickers (100)",
      hsCode: "48211010",
      image: "http://example.com/bunny.jpg",
      qty: 12,
      pieces: 1,
      shipped: 0,
      creationDate: "2026-03-10",
      timestamp: 0,
      handle,
    };
    const oldId = `${item.janCode}${item.subtype}`;

    let state = rootReducer(undefined as any, { type: "@@INIT" });
    state = rootReducer(
      state,
      create_listing({
        listing: makeListing(handle, item.description, item.janCode),
      }),
    );
    state = rootReducer(state, update_item({ id: oldId, item }));
    state = {
      ...state,
      listings: {
        ...state.listings,
        handleToListing: {
          ...state.listings.handleToListing,
          [handle]: {
            ...state.listings.handleToListing[handle],
            variantOptionsByItemId: {
              [oldId]: "Bunny",
            },
          },
        },
      },
    };

    state = rootReducer(
      state,
      update_field({
        id: oldId,
        field: "subtype",
        from: "Bunny",
        to: "Rabbit",
      }),
    );

    const newId = "4542804141160Rabbit";
    expect(state.inventory.idToItem[oldId]).toBeUndefined();
    expect(state.inventory.idToItem[newId].subtype).toBe("Rabbit");
    expect(
      state.listings.handleToListing[handle].variantOptionsByItemId,
    ).toEqual({
      [newId]: "Rabbit",
    });
  });

  it("updates a stale target-key listing option when it still reflected the old subtype", () => {
    const handle = "furukawa-mini-washi-paper-letter-set";
    const item: Item = {
      janCode: "4952270302420",
      subtype: "Cat/Flower",
      description: "Furukawa Mini Washi Paper Letter Set",
      hsCode: "48173000",
      image: "http://example.com/cat-flower.jpg",
      qty: 10,
      pieces: 1,
      shipped: 0,
      creationDate: "2026-03-17",
      timestamp: 0,
      handle,
    };
    const oldId = `${item.janCode}${item.subtype}`;
    const newId = `${item.janCode}Cat`;

    let state = rootReducer(undefined as any, { type: "@@INIT" });
    state = rootReducer(
      state,
      create_listing({
        listing: makeListing(handle, item.description, item.janCode),
      }),
    );
    state = rootReducer(state, update_item({ id: oldId, item }));
    state = {
      ...state,
      listings: {
        ...state.listings,
        idToHandle: {
          ...state.listings.idToHandle,
          [newId]: handle,
        },
        handleToListing: {
          ...state.listings.handleToListing,
          [handle]: {
            ...state.listings.handleToListing[handle],
            variantOptionsByItemId: {
              [newId]: "Cat/Flower",
            },
          },
        },
      },
    };

    state = rootReducer(
      state,
      update_field({
        id: oldId,
        field: "subtype",
        from: "Cat/Flower",
        to: "Cat",
      }),
    );

    expect(state.inventory.idToItem[oldId]).toBeUndefined();
    expect(state.inventory.idToItem[newId].subtype).toBe("Cat");
    expect(
      state.listings.handleToListing[handle].variantOptionsByItemId,
    ).toEqual({
      [newId]: "Cat",
    });
  });

  it("does not overwrite the target listing handle when replacing one subtype with another existing subtype", () => {
    const janCode = "4542804155181";
    const sourceHandle = "stale-a5-zipper-case-4542804155181";
    const targetHandle = "canonical-a5-zipper-case-4542804155181";
    const sourceId = `${janCode}Blue`;
    const targetId = `${janCode}Green`;

    const sourceItem: Item = {
      janCode,
      subtype: "Blue",
      description: "A5 Two Zipper Case",
      hsCode: "42023290",
      image: "http://example.com/blue.jpg",
      qty: 0,
      pieces: 1,
      shipped: 0,
      creationDate: "2026-06-01",
      timestamp: 0,
      handle: sourceHandle,
    };
    const targetItem: Item = {
      ...sourceItem,
      subtype: "Green",
      image: "http://example.com/green.jpg",
      qty: 6,
      handle: targetHandle,
    };

    let state = rootReducer(undefined as any, { type: "@@INIT" });
    state = rootReducer(
      state,
      create_listing({
        listing: makeListing(sourceHandle, sourceItem.description, janCode),
      }),
    );
    state = rootReducer(
      state,
      create_listing({
        listing: makeListing(targetHandle, targetItem.description, janCode),
      }),
    );
    state = rootReducer(state, update_item({ id: sourceId, item: sourceItem }));
    state = rootReducer(state, update_item({ id: targetId, item: targetItem }));
    state = {
      ...state,
      listings: {
        ...state.listings,
        handleToListing: {
          ...state.listings.handleToListing,
          [sourceHandle]: {
            ...state.listings.handleToListing[sourceHandle],
            variantOptionsByItemId: {
              [sourceId]: "Blue",
            },
          },
          [targetHandle]: {
            ...state.listings.handleToListing[targetHandle],
            variantOptionsByItemId: {
              [targetId]: "Green",
            },
          },
        },
      },
    };

    state = rootReducer(
      state,
      replace_subtype({
        sourceKey: sourceId as any,
        targetKey: targetId as any,
        reason: "Blue was created by mistake; Green is correct",
      }),
    );

    expect(state.inventory.idToItem[sourceId]).toBeUndefined();
    expect(state.inventory.idToItem[targetId]).toBeDefined();
    expect(state.listings.idToHandle[sourceId]).toBeUndefined();
    expect(state.listings.idToHandle[targetId]).toBe(targetHandle);
    expect(
      state.listings.handleToListing[sourceHandle].variantOptionsByItemId,
    ).toEqual({});
    expect(
      state.listings.handleToListing[targetHandle].variantOptionsByItemId,
    ).toEqual({
      [targetId]: "Green",
    });
  });
});
