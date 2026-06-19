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
import { update_field, update_item, type Item } from "$lib/inventory";

describe("inventory handle updates sync to listings", () => {
  it("keeps listings.idToHandle and handleToListing aligned when handle changes via update_field", () => {
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
    expect(state.listings.idToHandle[id]).toBe("new-handle");
    expect(state.listings.handleToListing["new-handle"]).toBeDefined();
    expect(state.listings.handleToListing["old-handle"]).toBeUndefined();
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
    expect(state.listings.handleToListing["handle-a"]).toBeUndefined();
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
});
