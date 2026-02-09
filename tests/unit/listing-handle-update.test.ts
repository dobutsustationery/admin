import { describe, expect, it } from "vitest";
import { rootReducer } from "$lib/root-reducer";
import { update_item, update_field, type Item } from "$lib/inventory";

describe("listing handle update logic", () => {
  it("does not delete listing if other items still reference the old handle", () => {
    const itemA: Item = {
      janCode: "123",
      subtype: "A",
      description: "Item A",
      handle: "H1",
      qty: 1, price: 100, shipped: 0, pieces: 1, creationDate: "", timestamp: 0, hsCode: "", image: ""
    };
    const itemB: Item = { ...itemA, subtype: "B", description: "Item B" };
    const idA = "123A";
    const idB = "123B";

    let state = rootReducer(undefined as any, { type: "@@INIT" });
    state = rootReducer(state, update_item({ id: idA, item: itemA }));
    state = rootReducer(state, update_item({ id: idB, item: itemB }));

    // Both point to H1
    expect(state.listings.handleToListing["H1"]).toBeDefined();
    expect(state.listings.idToHandle[idA]).toBe("H1");
    expect(state.listings.idToHandle[idB]).toBe("H1");

    // Move A to H2
    state = rootReducer(
      state,
      update_field({ id: idA, field: "handle", from: "H1", to: "H2" })
    );

    // H1 should STILL exist because B is there
    expect(state.listings.handleToListing["H1"]).toBeDefined();
    expect(state.listings.handleToListing["H2"]).toBeDefined();

    // Move B to H2
    state = rootReducer(
      state,
      update_field({ id: idB, field: "handle", from: "H1", to: "H2" })
    );

    // H1 should be gone now
    expect(state.listings.handleToListing["H1"]).toBeUndefined();
    expect(state.listings.handleToListing["H2"]).toBeDefined();
  });
});
