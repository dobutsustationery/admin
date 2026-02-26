import { describe, expect, it } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import { rootReducer } from "../../src/lib/root-reducer";
import {
  set_proposal_handle_thunk,
  add_proposals_internal,
  type ListingProposal,
} from "../../src/lib/listing-creation-slice";

describe("Listing Creation - Merge Proposals", () => {
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
});
