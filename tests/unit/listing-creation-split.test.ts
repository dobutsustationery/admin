import { describe, expect, it } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import { rootReducer } from "$lib/store";
import { add_proposals, split_variant } from "$lib/listing-creation-slice";

describe("Listing Creation - Split Variant", () => {
  it("preserves photo group IDs when splitting a variant", () => {
    const store = configureStore({ reducer: rootReducer });
    const janCode = "JAN_A";
    const variantId = "item-B";
    const newHandle = "new-handle";

    // 1. Setup Proposal
    store.dispatch(add_proposals([{
      janCode,
      inventoryItemIds: ["item-A", variantId],
      photoGroupIds: ["JAN_A", "JAN_EXTRA"],
      title: "Product",
      bodyHtml: "",
      productCategory: "",
      vendor: "",
      tags: [],
      option1Name: "Opt",
      variants: [
          { itemId: "item-A", option1Value: "A" },
          { itemId: variantId, option1Value: "B" }
      ],
      status: 'draft'
    }]));

    // 2. Split
    store.dispatch(split_variant({ janCode, variantId, newHandle }));

    // 3. Verify New Proposal
    // The new proposal key is the variantId (as per current impl)
    const newProposal = store.getState().listingCreation.proposals[variantId];
    expect(newProposal).toBeDefined();
    
    // Check JAN Code matches key (it does currently)
    expect(newProposal.janCode).toBe(variantId);
    
    // CRITICAL: Check Photo Groups
    expect(newProposal.photoGroupIds).toContain("JAN_A");
    expect(newProposal.photoGroupIds).toContain("JAN_EXTRA");
  });
});
