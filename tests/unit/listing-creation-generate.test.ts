import { describe, expect, it, vi, beforeEach } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import { rootReducer } from "$lib/store";
import { generate_proposals } from "$lib/listing-creation-slice";

describe("Listing Creation - Generate Proposals", () => {
  beforeEach(() => {
      // Mock localStorage
      const storage: Record<string, string> = {};
      global.localStorage = {
          getItem: (key: string) => storage[key] || null,
          setItem: (key: string, value: string) => { storage[key] = value; },
          removeItem: (key: string) => { delete storage[key]; },
          clear: () => {},
          length: 0,
          key: (index: number) => ""
      };
  });

  it("should generate proposals for JAN:Subtype keys using base inventory items", async () => {
    const preloadedState = {
        inventory: {
            idToItem: {
                "item-1": {
                    janCode: "4542804104370",
                    description: "Stickers",
                    qty: 10,
                    handle: "" // Unlisted
                }
            },
            idToHistory: {},
            orderIdToOrder: {},
            salesEvents: {},
            archivedInventoryState: {},
            hiddenInventoryState: {},
            archivedInventoryDate: {},
            shopifyUrlToDriveUrl: {},
            initialized: true
        },
        photos: {
            janCodeToPhotos: {
                "4542804104370:Blue": [{ id: "p1", baseUrl: "url1", filename: "p1.jpg", mimeType: "image/jpeg", mediaMetadata: {}, productUrl: "" }],
                "4542804104370:Red": [{ id: "p2", baseUrl: "url2", filename: "p2.jpg", mimeType: "image/jpeg", mediaMetadata: {}, productUrl: "" }]
            },
            selected: [],
            uploads: {},
            urlHistory: {},
            edits: {},
            generating: false,
            categorizing: false
        },
        listingCreation: {
            proposals: {},
            activeBatchJans: [],
            originalBatchJans: [],
            currentStepIndex: 0,
            driveConnectionStatus: 'connected', // Mock as connected
            activeBatchId: undefined,
            activeBatchCreatedAt: undefined,
            lastCompletedBatchId: undefined
        }
    };

    const store = configureStore({ 
        reducer: rootReducer,
        preloadedState: preloadedState as any 
    });

    // 3. Run Generation
    await store.dispatch(generate_proposals());

    // 4. Verify
    const state = store.getState().listingCreation;
    const proposals = Object.values(state.proposals) as any[];
    
    // Should have ONE proposal for the Base JAN
    expect(proposals.length).toBe(1);
    
    const proposal = proposals[0];
    expect(proposal.janCode).toBe("4542804104370");
    expect(proposal.inventoryItemIds).toContain("item-1");
    
    // Should have TWO variants
    expect(proposal.variants.length).toBe(2);
    
    const blueVariant = proposal.variants.find((v: any) => v.option1Value === "Blue");
    expect(blueVariant).toBeDefined();
    expect(blueVariant.photoGroupKey).toBe("4542804104370:Blue");
    expect(blueVariant.itemId).toBe("4542804104370Blue");

    const redVariant = proposal.variants.find((v: any) => v.option1Value === "Red");
    expect(redVariant).toBeDefined();
    expect(redVariant.photoGroupKey).toBe("4542804104370:Red");
    expect(redVariant.itemId).toBe("4542804104370Red");
  });
});
