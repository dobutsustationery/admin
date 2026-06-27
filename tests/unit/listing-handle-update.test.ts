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
import { update_item, update_field, type Item } from "$lib/inventory";
import {
  create_listing,
  rename_listing_handle,
  type Listing,
} from "$lib/listings-slice";

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

describe("listing handle update logic", () => {
  it("keeps an existing linked handle stable when the item description changes", () => {
    const baseItem: Item = {
      janCode: "4542804116380",
      subtype: "Blue",
      description: "Sticky Notes Film Round",
      handle: "amifa-aurora-clear-sticky-notes-4542804116380",
      qty: 1,
      price: 100,
      shipped: 0,
      pieces: 1,
      creationDate: "",
      timestamp: 0,
      hsCode: "",
      image: "",
    };
    const idBlue = "4542804116380Blue";
    const idPurple = "4542804116380Purple";

    let state = rootReducer(undefined as any, { type: "@@INIT" });
    state = rootReducer(
      state,
      create_listing({
        listing: makeListing(
          baseItem.handle || "",
          baseItem.description,
          baseItem.janCode,
        ),
      }),
    );
    state = rootReducer(state, update_item({ id: idBlue, item: baseItem }));
    state = rootReducer(
      state,
      update_item({
        id: idPurple,
        item: { ...baseItem, subtype: "Purple" },
      }),
    );

    state = rootReducer(
      state,
      update_field({
        id: idPurple,
        field: "description",
        from: "Sticky Notes Film Round",
        to: "Amifa Aurora Clear Sticky Notes (75)",
      }),
    );

    const handle = "amifa-aurora-clear-sticky-notes-4542804116380";
    expect(state.listings.handleToListing[handle]).toBeDefined();
    expect(
      state.listings.handleToListing[
        "amifa-aurora-clear-sticky-notes-75-4542804116380"
      ],
    ).toBeUndefined();
    expect(state.listings.idToHandle[idBlue]).toBe(handle);
    expect(state.listings.idToHandle[idPurple]).toBe(handle);
    expect(state.listings.handleToListing[handle].title).toBe(
      "Amifa Aurora Clear Sticky Notes (75)",
    );
  });

  it("does not delete listing if other items still reference the old handle", () => {
    const itemA: Item = {
      janCode: "123",
      subtype: "A",
      description: "Item A",
      handle: "H1",
      qty: 1,
      price: 100,
      shipped: 0,
      pieces: 1,
      creationDate: "",
      timestamp: 0,
      hsCode: "",
      image: "",
    };
    const itemB: Item = { ...itemA, subtype: "B", description: "Item B" };
    const idA = "123A";
    const idB = "123B";

    let state = rootReducer(undefined as any, { type: "@@INIT" });
    state = rootReducer(
      state,
      create_listing({
        listing: makeListing("H1", itemA.description, itemA.janCode),
      }),
    );
    state = rootReducer(state, update_item({ id: idA, item: itemA }));
    state = rootReducer(state, update_item({ id: idB, item: itemB }));

    // Both point to H1
    expect(state.listings.handleToListing["H1"]).toBeDefined();
    expect(state.listings.idToHandle[idA]).toBe("H1");
    expect(state.listings.idToHandle[idB]).toBe("H1");

    // Set A to a missing handle. This unlinks A from H1 but does not create H2.
    state = rootReducer(
      state,
      update_field({ id: idA, field: "handle", from: "H1", to: "H2" }),
    );

    // H1 should STILL exist because B is there
    expect(state.listings.handleToListing["H1"]).toBeDefined();
    expect(state.listings.idToHandle[idA]).toBeUndefined();
    expect(state.listings.handleToListing["H2"]).toBeUndefined();

    // Set B to the same missing handle. This unlinks B, but handle edits do
    // not delete listing rows.
    state = rootReducer(
      state,
      update_field({ id: idB, field: "handle", from: "H1", to: "H2" }),
    );

    expect(state.listings.handleToListing["H1"]).toBeDefined();
    expect(state.listings.idToHandle[idA]).toBeUndefined();
    expect(state.listings.idToHandle[idB]).toBeUndefined();
    expect(state.listings.handleToListing["H2"]).toBeUndefined();
  });

  it("does not create a generated-default listing when clearing a shared handle", () => {
    const itemA: Item = {
      janCode: "123",
      subtype: "A",
      description: "Default Product",
      handle: "shared-handle",
      qty: 1,
      price: 100,
      shipped: 0,
      pieces: 1,
      creationDate: "",
      timestamp: 0,
      hsCode: "",
      image: "",
    };
    const itemB: Item = { ...itemA, subtype: "B" };
    const idA = "123A";
    const idB = "123B";
    const generatedHandle = "default-product-123";

    let state = rootReducer(undefined as any, { type: "@@INIT" });
    state = rootReducer(
      state,
      create_listing({
        listing: makeListing("shared-handle", itemA.description, itemA.janCode),
      }),
    );
    state = rootReducer(state, update_item({ id: idA, item: itemA }));
    state = rootReducer(state, update_item({ id: idB, item: itemB }));

    expect(state.listings.idToHandle[idA]).toBe("shared-handle");
    expect(state.listings.idToHandle[idB]).toBe("shared-handle");

    state = rootReducer(
      state,
      update_field({
        id: idA,
        field: "handle",
        from: "shared-handle",
        to: "",
      }),
    );

    expect(state.inventory.idToItem[idA].handle).toBe("");
    expect(state.listings.idToHandle[idA]).toBeUndefined();
    expect(state.listings.idToHandle[idB]).toBe("shared-handle");
    expect(state.listings.handleToListing["shared-handle"]).toBeDefined();
    expect(state.listings.handleToListing[generatedHandle]).toBeUndefined();
  });

  it("does not link to a generated-default listing when clearing a handle", () => {
    const item: Item = {
      janCode: "123",
      subtype: "A",
      description: "Default Product",
      handle: "old-handle",
      qty: 1,
      price: 100,
      shipped: 0,
      pieces: 1,
      creationDate: "",
      timestamp: 0,
      hsCode: "",
      image: "",
    };
    const id = "123A";
    const generatedHandle = "default-product-123";

    let state = rootReducer(undefined as any, { type: "@@INIT" });
    state = rootReducer(
      state,
      create_listing({
        listing: makeListing("old-handle", item.description, item.janCode),
      }),
    );
    state = rootReducer(state, update_item({ id, item }));
    state = {
      ...state,
      listings: {
        ...state.listings,
        handleToListing: {
          ...state.listings.handleToListing,
          [generatedHandle]: {
            ...state.listings.handleToListing["old-handle"],
            handle: generatedHandle,
          },
        },
      },
    };

    state = rootReducer(
      state,
      update_field({
        id,
        field: "handle",
        from: "old-handle",
        to: "",
      }),
    );

    expect(state.inventory.idToItem[id].handle).toBe("");
    expect(state.listings.idToHandle[id]).toBeUndefined();
    expect(state.listings.handleToListing[generatedHandle]).toBeDefined();
    expect(state.listings.handleToListing["old-handle"]).toBeDefined();
  });

  it("renames a listing handle and updates all linked inventory references", () => {
    const itemA: Item = {
      janCode: "4969757171813",
      subtype: "Pomeranian",
      description: "Love Fur Sticky Notes",
      handle: "old-handle",
      qty: 12,
      price: 4,
      shipped: 1,
      pieces: 1,
      creationDate: "",
      timestamp: 0,
      hsCode: "",
      image: "",
    };
    const itemB: Item = {
      ...itemA,
      subtype: "Poodle",
      shipped: 2,
    };
    const idA = "4969757171813Pomeranian";
    const idB = "4969757171813Poodle";

    let state = rootReducer(undefined as any, { type: "@@INIT" });
    state = rootReducer(
      state,
      create_listing({
        listing: {
          ...makeListing("old-handle", itemA.description, itemA.janCode),
          variantOptionsByItemId: {
            [idA]: "Pomeranian",
            [idB]: "Poodle",
          },
        },
      }),
    );
    state = rootReducer(state, update_item({ id: idA, item: itemA }));
    state = rootReducer(state, update_item({ id: idB, item: itemB }));

    state = rootReducer(
      state,
      rename_listing_handle({ from: "old-handle", to: "new-handle" }),
    );

    expect(state.listings.handleToListing["old-handle"]).toBeUndefined();
    expect(state.listings.handleToListing["new-handle"]).toMatchObject({
      handle: "new-handle",
      title: itemA.description,
      variantOptionsByItemId: {
        [idA]: "Pomeranian",
        [idB]: "Poodle",
      },
    });
    expect(state.listings.idToHandle[idA]).toBe("new-handle");
    expect(state.listings.idToHandle[idB]).toBe("new-handle");
    expect(state.inventory.idToItem[idA].handle).toBe("new-handle");
    expect(state.inventory.idToItem[idB].handle).toBe("new-handle");
    expect(
      state.inventory.idToHistory[idA].some((entry: any) =>
        String(entry.desc).includes(
          "handle changed from old-handle to new-handle",
        ),
      ),
    ).toBe(true);
  });

  it("does not rename or relink when the target handle already exists", () => {
    const item: Item = {
      janCode: "123",
      subtype: "A",
      description: "Item A",
      handle: "old-handle",
      qty: 1,
      price: 100,
      shipped: 0,
      pieces: 1,
      creationDate: "",
      timestamp: 0,
      hsCode: "",
      image: "",
    };
    const id = "123A";

    let state = rootReducer(undefined as any, { type: "@@INIT" });
    state = rootReducer(
      state,
      create_listing({
        listing: makeListing("old-handle", item.description, item.janCode),
      }),
    );
    state = rootReducer(
      state,
      create_listing({
        listing: makeListing("new-handle", "Existing listing", item.janCode),
      }),
    );
    state = rootReducer(state, update_item({ id, item }));

    state = rootReducer(
      state,
      rename_listing_handle({ from: "old-handle", to: "new-handle" }),
    );

    expect(state.listings.handleToListing["old-handle"]).toBeDefined();
    expect(state.listings.handleToListing["new-handle"].title).toBe(
      "Existing listing",
    );
    expect(state.listings.idToHandle[id]).toBe("old-handle");
    expect(state.inventory.idToItem[id].handle).toBe("old-handle");
  });
});
