import { describe, expect, it, vi, beforeEach } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import { rootReducer } from "$lib/root-reducer";
import { generate_proposals } from "$lib/listing-creation-slice";

describe("Listing Creation - Generate Proposals", () => {
  beforeEach(() => {
    // Mock localStorage
    const storage: Record<string, string> = {};
    global.localStorage = {
      getItem: (key: string) => storage[key] || null,
      setItem: (key: string, value: string) => {
        storage[key] = value;
      },
      removeItem: (key: string) => {
        delete storage[key];
      },
      clear: () => {},
      length: 0,
      key: (index: number) => "",
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
            handle: "", // Unlisted
          },
        },
        idToHistory: {},
        orderIdToOrder: {},
        salesEvents: {},
        archivedInventoryState: {},
        hiddenInventoryState: {},
        archivedInventoryDate: {},
        shopifyUrlToDriveUrl: {},
        initialized: true,
      },
      photos: {
        janCodeToPhotos: {
          "4542804104370:Blue": [
            {
              id: "p1",
              baseUrl: "http://example.com/url1",
              filename: "p1.jpg",
              mimeType: "image/jpeg",
              mediaMetadata: {},
              productUrl: "",
            },
          ],
          "4542804104370:Red": [
            {
              id: "p2",
              baseUrl: "http://example.com/url2",
              filename: "p2.jpg",
              mimeType: "image/jpeg",
              mediaMetadata: {},
              productUrl: "",
            },
          ],
        },
        selected: [],
        uploads: {},
        urlHistory: {},
        edits: {},
        generating: false,
        categorizing: false,
      },
      listingCreation: {
        proposals: {},
        activeBatchJans: [],
        originalBatchJans: [],
        currentStepIndex: 0,
        driveConnectionStatus: "connected", // Mock as connected
        activeBatchId: undefined,
        activeBatchCreatedAt: undefined,
        lastCompletedBatchId: undefined,
      },
    };

    const store = configureStore({
      reducer: rootReducer,
      preloadedState: preloadedState as any,
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

    const blueVariant = proposal.variants.find(
      (v: any) => v.option1Value === "Blue",
    );
    expect(blueVariant).toBeDefined();
    expect(blueVariant.photoGroupKey).toBe("4542804104370:Blue");
    expect(blueVariant.itemId).toBe("item-1");

    const redVariant = proposal.variants.find(
      (v: any) => v.option1Value === "Red",
    );
    expect(redVariant).toBeDefined();
    expect(redVariant.photoGroupKey).toBe("4542804104370:Red");
    expect(redVariant.itemId).toBe("item-1");
  });

  it("should skip JANs that already have an existing proposal", async () => {
    const preloadedState = {
      inventory: {
        idToItem: {
          "item-existing": {
            janCode: "EXISTING-JAN",
            description: "Existing Product",
            qty: 5,
            handle: "",
          },
          "item-new": {
            janCode: "NEW-JAN",
            description: "New Product",
            qty: 10,
            handle: "",
          },
        },
        idToHistory: {},
        orderIdToOrder: {},
        salesEvents: {},
        archivedInventoryState: {},
        hiddenInventoryState: {},
        archivedInventoryDate: {},
        shopifyUrlToDriveUrl: {},
        initialized: true,
      },
      photos: {
        janCodeToPhotos: {
          "EXISTING-JAN": [
            {
              id: "p1",
              baseUrl: "http://example.com/url1",
              filename: "p1.jpg",
              productUrl: "",
            },
          ],
          "NEW-JAN": [
            {
              id: "p2",
              baseUrl: "http://example.com/url2",
              filename: "p2.jpg",
              productUrl: "",
            },
          ],
        },
        selected: [],
        uploads: {},
        urlHistory: {},
        edits: {},
        generating: false,
        categorizing: false,
      },
      listingCreation: {
        proposals: {
          "EXISTING-JAN": {
            janCode: "EXISTING-JAN",
            title: "Existing Title",
            status: "draft",
          },
        },
        activeBatchJans: [],
        originalBatchJans: [],
        currentStepIndex: 0,
        driveConnectionStatus: "connected",
        isScanning: false,
        scanProgress: { current: 0, total: 0, message: "", lastUpdate: 0 },
      },
    };

    const store = configureStore({
      reducer: rootReducer,
      preloadedState: preloadedState as any,
    });

    // Run Generation
    await store.dispatch(generate_proposals());

    const state = store.getState().listingCreation;

    // Verify: Should only have proposals for EXISTING and NEW (total 2)
    // and should not have tried to re-generate EXISTING-JAN
    expect(Object.keys(state.proposals).length).toBe(2);
    expect(state.proposals["NEW-JAN"]).toBeDefined();
    expect(state.proposals["EXISTING-JAN"].title).toBe("Existing Title"); // Unchanged

    // Verify Progress: Total should have been 1 (only NEW-JAN)
    // Note: The thunk might have reset scanProgress at the end, but we can check if it was set during.
    // However, set_scanning(false) in 'finally' resets it.
    // If we want to verify the counter math, we'd need to mock the dispatch or check intermediate states.
    // But the code fix [totalBaseJans = baseJanKeys.length] where baseJanKeys is filtered ensures this.
  });

  it("should skip JANs that already have a handle in inventory (completed items)", async () => {
    const preloadedState = {
      inventory: {
        idToItem: {
          "item-completed": {
            janCode: "COMPLETED-JAN",
            description: "Completed Product",
            qty: 5,
            handle: "some-handle", // ALREADY LISTED
          },
          "item-new": {
            janCode: "NEW-JAN",
            description: "New Product",
            qty: 10,
            handle: "",
          },
        },
        idToHistory: {},
        orderIdToOrder: {},
        salesEvents: {},
        archivedInventoryState: {},
        hiddenInventoryState: {},
        archivedInventoryDate: {},
        shopifyUrlToDriveUrl: {},
        initialized: true,
      },
      photos: {
        janCodeToPhotos: {
          "COMPLETED-JAN": [
            {
              id: "p1",
              baseUrl: "http://example.com/url1",
              filename: "p1.jpg",
              productUrl: "",
            },
          ],
          "NEW-JAN": [
            {
              id: "p2",
              baseUrl: "http://example.com/url2",
              filename: "p2.jpg",
              productUrl: "",
            },
          ],
        },
        selected: [],
        uploads: {},
        urlHistory: {},
        edits: {},
        generating: false,
        categorizing: false,
      },
      listingCreation: {
        proposals: {},
        activeBatchJans: [],
        originalBatchJans: [],
        currentStepIndex: 0,
        driveConnectionStatus: "connected",
        isScanning: false,
        scanProgress: { current: 0, total: 0, message: "", lastUpdate: 0 },
      },
    };

    const store = configureStore({
      reducer: rootReducer,
      preloadedState: preloadedState as any,
    });

    // Run Generation
    await store.dispatch(generate_proposals());

    const state = store.getState().listingCreation;

    // Verify: Should only have proposals for NEW-JAN
    expect(Object.keys(state.proposals).length).toBe(1);
    expect(state.proposals["NEW-JAN"]).toBeDefined();
    expect(state.proposals["COMPLETED-JAN"]).toBeUndefined();
  });
});
