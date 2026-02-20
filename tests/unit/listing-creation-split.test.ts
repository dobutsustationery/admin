import { describe, expect, it } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import { rootReducer } from "../../src/lib/root-reducer";
import { approve_proposal_thunk, add_proposals_internal } from "../../src/lib/listing-creation-slice";
import { update_item, type Item } from "../../src/lib/inventory";

describe("Listing Creation - Split Inventory", () => {
  it("should remove source item when split into variants", () => {
    const store = configureStore({ reducer: rootReducer });
    const janCode = "4542804117844";
    const itemId = janCode;

    // 1. Setup Inventory (Source Item)
    const item: Item = {
      janCode,
      subtype: "",
      description: "Source Product",
      qty: 20,
      price: 0,
      handle: "",
      shipped: 0,
      pieces: 1,
      creationDate: "2024-01-01",
      timestamp: Date.now(),
      hsCode: "1234.56",
      image: ""
    };
    store.dispatch(update_item({ id: itemId, item }));

    // 2. Setup Proposal with multiple variants for the SAME itemId
    store.dispatch(add_proposals_internal([{
      janCode,
      inventoryItemIds: [itemId],
      photoGroupIds: [janCode],
      title: "Split Product",
      handle: "split-handle",
      bodyHtml: "<p>Description</p>",
      productCategory: "Stationery",
      vendor: "Dobutsu",
      tags: ["tag1"],
      option1Name: "Subtype",
      variants: [
          { id: "v-blue", itemId, option1Value: "Blue", qty: 10 },
          { id: "v-brown", itemId, option1Value: "Brown", qty: 10 }
      ],
      status: 'draft',
      price: 1500
    }]));

    // 3. Approve
    store.dispatch(approve_proposal_thunk(janCode) as any);

    // 4. Verify Inventory
    const state = store.getState().inventory;
    
    // New items should exist
    expect(state.idToItem[janCode + "Blue"]).toBeDefined();
    expect(state.idToItem[janCode + "Brown"]).toBeDefined();
    expect(state.idToItem[janCode + "Blue"].qty).toBe(10);
    expect(state.idToItem[janCode + "Brown"].qty).toBe(10);

    // Original item should be gone
    expect(state.idToItem[itemId]).toBeUndefined();
  });
});
