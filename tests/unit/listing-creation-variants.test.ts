import { describe, expect, it } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import { rootReducer } from "../../src/lib/root-reducer";
import {
  set_proposal_handle_thunk,
  add_proposals_internal,
  add_variant_requested,
  remove_variant_requested,
  type ListingProposal,
} from "../../src/lib/listing-creation-slice";
import { bulk_import_items } from "../../src/lib/inventory";

describe("Listing Creation - Variants & Merging", () => {
  it("should merge two proposals when their handles are set to the same value", () => {
    const store = configureStore({ reducer: rootReducer });

    // 1. Setup two separate proposals
    const janA = "jan_a";
    const janB = "jan_b";

    const propA: ListingProposal = {
      janCode: janA,
      inventoryItemIds: [janA],
      photoGroupIds: [janA],
      title: "Product A",
      handle: "handle-a",
      variants: [{ id: "v-a", itemId: janA, option1Value: "Default", qty: 5 }],
      status: "draft",
      bodyHtml: "",
      productCategory: "",
      vendor: "",
      tags: [],
      option1Name: "Subtype",
    };

    const propB: ListingProposal = {
      janCode: janB,
      inventoryItemIds: [janB],
      photoGroupIds: [janB],
      title: "Product B",
      handle: "handle-b",
      variants: [{ id: "v-b", itemId: janB, option1Value: "Default", qty: 10 }],
      status: "draft",
      bodyHtml: "",
      productCategory: "",
      vendor: "",
      tags: [],
      option1Name: "Subtype",
    };

    store.dispatch(add_proposals_internal([propA, propB]));

    // 2. Set handle of B to match A
    store.dispatch(
      set_proposal_handle_thunk(janB, undefined, "handle-a") as any,
    );

    // 3. Verify they merged
    const state = store.getState().listingCreation;

    // Proposal B should be gone
    expect(state.proposals[janB]).toBeUndefined();

    // Proposal A should now have two variants
    expect(state.proposals[janA]).toBeDefined();
    expect(state.proposals[janA].variants.length).toBe(2);
    expect(state.proposals[janA].inventoryItemIds).toContain(janA);
    expect(state.proposals[janA].inventoryItemIds).toContain(janB);
  });

  it("should merge a proposal into another even if one doesn't have an explicit handle set", () => {
    const store = configureStore({ reducer: rootReducer });

    // 1. Setup two separate proposals
    const janA = "jan_a";
    const janB = "jan_b";

    // Proposal A has NO handle set, so it will use computed handle
    // generateHandle("Product A", "jan_a") -> "product-a-jan_a"
    const propA: ListingProposal = {
      janCode: janA,
      inventoryItemIds: [janA],
      photoGroupIds: [janA],
      title: "Product A",
      variants: [{ id: "v-a", itemId: janA, option1Value: "Default", qty: 5 }],
      status: "draft",
      bodyHtml: "",
      productCategory: "",
      vendor: "",
      tags: [],
      option1Name: "Subtype",
    };

    const propB: ListingProposal = {
      janCode: janB,
      inventoryItemIds: [janB],
      photoGroupIds: [janB],
      title: "Product B",
      handle: "handle-b",
      variants: [{ id: "v-b", itemId: janB, option1Value: "Default", qty: 10 }],
      status: "draft",
      bodyHtml: "",
      productCategory: "",
      vendor: "",
      tags: [],
      option1Name: "Subtype",
    };

    store.dispatch(add_proposals_internal([propA, propB]));

    // 2. Set handle of B to match A's computed handle
    store.dispatch(
      set_proposal_handle_thunk(janB, undefined, "product-a-jan_a") as any,
    );

    // 3. Verify they merged
    const state = store.getState().listingCreation;

    // Proposal B should be gone
    expect(state.proposals[janB]).toBeUndefined();

    // Proposal A should now have two variants
    expect(state.proposals[janA]).toBeDefined();
    expect(state.proposals[janA].variants.length).toBe(2);
  });

  it("should merge a single-variant proposal into a multi-variant proposal", () => {
    const store = configureStore({ reducer: rootReducer });

    const janA = "jan_a";
    const janB = "jan_b";

    const propA: ListingProposal = {
      janCode: janA,
      inventoryItemIds: [janA],
      photoGroupIds: [janA],
      title: "Product A",
      handle: "shared-handle",
      variants: [
        { id: "v-a1", itemId: janA, option1Value: "Red", qty: 5 },
        { id: "v-a2", itemId: janA, option1Value: "Blue", qty: 5 },
      ],
      status: "draft",
      bodyHtml: "",
      productCategory: "",
      vendor: "",
      tags: [],
      option1Name: "Subtype",
    };

    const propB: ListingProposal = {
      janCode: janB,
      inventoryItemIds: [janB],
      photoGroupIds: [janB],
      title: "Product B",
      handle: "handle-b",
      variants: [{ id: "v-b", itemId: janB, option1Value: "Default", qty: 10 }],
      status: "draft",
      bodyHtml: "",
      productCategory: "",
      vendor: "",
      tags: [],
      option1Name: "Subtype",
    };

    store.dispatch(add_proposals_internal([propA, propB]));

    // Set handle of B to match A
    store.dispatch(
      set_proposal_handle_thunk(janB, undefined, "shared-handle") as any,
    );

    const state = store.getState().listingCreation;

    // Proposal B should be gone
    expect(state.proposals[janB]).toBeUndefined();

    // Proposal A should now have three variants
    expect(state.proposals[janA]).toBeDefined();
    expect(state.proposals[janA].variants.length).toBe(3);
  });

  describe("Intent Actions (Add/Remove Requested)", () => {
    it("should add a new variant to the same JAN (splitting)", () => {
      const store = configureStore({ reducer: rootReducer });
      const jan = "jan_a";
      const variantId = "new-v-id";

      store.dispatch(
        add_proposals_internal([
          {
            janCode: jan,
            inventoryItemIds: ["item_a"],
            photoGroupIds: [jan],
            title: "Product A",
            handle: "handle-a",
            variants: [
              { id: "v-a", itemId: "item_a", option1Value: "Default", qty: 10 },
            ],
            status: "draft",
            bodyHtml: "",
            productCategory: "",
            vendor: "",
            tags: [],
            option1Name: "Subtype",
          },
        ]),
      );

      // Request adding variant to same JAN
      store.dispatch(
        add_variant_requested({ targetJan: jan, janCode: jan, variantId }),
      );

      const state = store.getState().listingCreation;
      expect(state.proposals[jan].variants.length).toBe(2);
      expect(state.proposals[jan].variants[1].id).toBe(variantId);
      expect(state.proposals[jan].variants[1].itemId).toBe("item_a");
    });

    it("should add a new variant from a different JAN (linking)", () => {
      const store = configureStore({ reducer: rootReducer });
      const janA = "jan_a";
      const janB = "jan_b";
      const variantId = "new-v-id";

      // 1. Setup inventory for JAN B (unlisted)
      store.dispatch(
        bulk_import_items({
          items: [
            {
              type: "new",
              id: "item_b",
              item: {
                janCode: janB,
                subtype: "Blue",
                qty: 5,
                description: "B",
                hsCode: "123",
                shipped: 0,
                pieces: 1,
                image: "",
                creationDate: "",
                timestamp: 0,
              },
            },
          ],
        }),
      );

      // 2. Setup proposal for JAN A
      store.dispatch(
        add_proposals_internal([
          {
            janCode: janA,
            inventoryItemIds: ["item_a"],
            photoGroupIds: [janA],
            title: "Product A",
            handle: "handle-a",
            variants: [
              { id: "v-a", itemId: "item_a", option1Value: "Red", qty: 10 },
            ],
            status: "draft",
            bodyHtml: "",
            productCategory: "",
            vendor: "",
            tags: [],
            option1Name: "Subtype",
          },
        ]),
      );

      // 3. Request adding variant from JAN B
      store.dispatch(
        add_variant_requested({ targetJan: janA, janCode: janB, variantId }),
      );

      const creationState = store.getState().listingCreation;
      const inventoryState = store.getState().inventory;

      // Proposal should have new variant
      expect(creationState.proposals[janA].variants.length).toBe(2);
      expect(creationState.proposals[janA].variants[1].itemId).toBe("item_b");
      expect(creationState.proposals[janA].inventoryItemIds).toContain(
        "item_b",
      );

      // Inventory item should now have the handle linked
      expect(inventoryState.idToItem["item_b"].handle).toBe("handle-a");
    });

    it("should remove a variant and clear inventory handle if no longer used", () => {
      const store = configureStore({ reducer: rootReducer });
      const janA = "jan_a";
      const janB = "jan_b";

      // 1. Setup inventory with items linked to handle-a
      store.dispatch(
        bulk_import_items({
          items: [
            {
              type: "new",
              id: "item_a",
              item: {
                janCode: janA,
                handle: "handle-a",
                qty: 5,
                description: "A",
                hsCode: "123",
                shipped: 0,
                pieces: 1,
                subtype: "Default",
                image: "",
                creationDate: "",
                timestamp: 0,
              },
            },
            {
              type: "new",
              id: "item_b",
              item: {
                janCode: janB,
                handle: "handle-a",
                qty: 5,
                description: "B",
                hsCode: "123",
                shipped: 0,
                pieces: 1,
                subtype: "Default",
                image: "",
                creationDate: "",
                timestamp: 0,
              },
            },
          ],
        }),
      );

      // 2. Setup proposal with two variants
      store.dispatch(
        add_proposals_internal([
          {
            janCode: janA,
            inventoryItemIds: ["item_a", "item_b"],
            photoGroupIds: [janA, janB],
            title: "Product A",
            handle: "handle-a",
            variants: [
              { id: "v-a", itemId: "item_a", option1Value: "A", qty: 5 },
              { id: "v-b", itemId: "item_b", option1Value: "B", qty: 5 },
            ],
            status: "draft",
            bodyHtml: "",
            productCategory: "",
            vendor: "",
            tags: [],
            option1Name: "Subtype",
          },
        ]),
      );

      // 3. Request removal of variant B
      store.dispatch(
        remove_variant_requested({ janCode: janA, variantId: "v-b" }),
      );

      const creationState = store.getState().listingCreation;
      const inventoryState = store.getState().inventory;

      // Proposal should only have variant A
      expect(creationState.proposals[janA].variants.length).toBe(1);
      expect(creationState.proposals[janA].variants[0].id).toBe("v-a");
      expect(creationState.proposals[janA].inventoryItemIds).not.toContain(
        "item_b",
      );

      // Inventory item B should have its handle cleared
      expect(inventoryState.idToItem["item_b"].handle).toBe("");
      // Inventory item A should still have its handle
      expect(inventoryState.idToItem["item_a"].handle).toBe("handle-a");
    });
  });
});
