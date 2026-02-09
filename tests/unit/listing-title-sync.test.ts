import { describe, expect, it } from "vitest";
import { rootReducer } from "$lib/root-reducer";
import { update_field, update_item } from "$lib/inventory";
import { create_listing, update_listing } from "$lib/listings-slice";

describe("Listing Title Sync", () => {
  it("synchronizes item description with listing title on link and updates", () => {
    // 1. Setup
    let state = rootReducer(undefined, { type: "INIT" });
    
    // Create Item A
    const itemA = {
        janCode: "123",
        description: "Desc A",
        qty: 1,
        subtype: "A"
    };
    state = rootReducer(state, update_item({ id: "item-a", item: itemA as any }));
    
    // Create Listing L
    const listingL = {
        handle: "listing-l",
        title: "Title L",
        bodyHtml: "",
        images: [],
        productCategory: "",
        vendor: "",
        tags: [],
        option1Name: ""
    };
    state = rootReducer(state, create_listing({ listing: listingL as any }));
    
    // Verify Initial State
    expect(state.inventory.idToItem["item-a"].description).toBe("Desc A");
    expect(state.listings.handleToListing["listing-l"].title).toBe("Title L");
    
    // 2. Link Item A to Listing L
    // This should trigger the sync: Item Desc -> Listing Title
    state = rootReducer(state, update_field({ id: "item-a", field: "handle", from: "", to: "listing-l" }));
    
    // 3. Verify Sync (Link)
    expect(state.inventory.idToItem["item-a"].handle).toBe("listing-l");
    expect(state.inventory.idToItem["item-a"].description).toBe("Title L"); // FAIL expected
    
    // 4. Update Listing Title
    state = rootReducer(state, update_listing({ handle: "listing-l", changes: { title: "New Title" } }));
    
    // 5. Verify Propagation (Listing -> Item)
    expect(state.listings.handleToListing["listing-l"].title).toBe("New Title");
    expect(state.inventory.idToItem["item-a"].description).toBe("New Title"); // FAIL expected
    
    // 6. Add Sibling Item B
    const itemB = {
        janCode: "123",
        description: "Desc B",
        qty: 1,
        subtype: "B"
    };
    state = rootReducer(state, update_item({ id: "item-b", item: itemB as any }));
    state = rootReducer(state, update_field({ id: "item-b", field: "handle", from: "", to: "listing-l" }));
    
    // Verify Sibling Sync
    expect(state.inventory.idToItem["item-b"].description).toBe("New Title"); // FAIL expected
    
    // 7. Update Item A Description
    state = rootReducer(state, update_field({ id: "item-a", field: "description", from: "New Title", to: "Changed Title" }));
    
    // 8. Verify Propagation (Item -> Listing -> Sibling)
    expect(state.inventory.idToItem["item-a"].description).toBe("Changed Title");
    expect(state.listings.handleToListing["listing-l"].title).toBe("Changed Title"); // FAIL expected
    expect(state.inventory.idToItem["item-b"].description).toBe("Changed Title"); // FAIL expected
  });
});
