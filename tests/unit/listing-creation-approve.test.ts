import { describe, expect, it, vi } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
import { rootReducer } from "$lib/store";
import { approve_proposal_thunk, add_proposals } from "$lib/listing-creation-slice";
import { update_item, type Item } from "$lib/inventory";
import { categorize_photo } from "$lib/photos-slice";
import type { MediaItem } from "$lib/google-photos";

describe("Listing Creation - Approve Proposal", () => {
  it("should create listing with valid image URLs from MediaItems", () => {
    // 1. Setup Store
    const store = configureStore({ reducer: rootReducer });
    const janCode = "4901234567890";
    const itemId = "item-123";

    // 2. Setup Inventory
    const item: Item = {
      janCode,
      subtype: "Default",
      description: "Test Product",
      qty: 10,
      price: 100,
      handle: "",
      shipped: 0,
      pieces: 1,
      creationDate: "2024-01-01",
      timestamp: Date.now(),
      hsCode: "1234.56",
      image: ""
    };
    store.dispatch(update_item({ id: itemId, item }));

    // 3. Setup Photos (Categorized)
    const photo: MediaItem = {
      id: "photo-1",
      baseUrl: "https://lh3.googleusercontent.com/photo-1",
      productUrl: "https://photos.google.com/photo-1",
      mimeType: "image/jpeg",
      filename: "photo.jpg",
      mediaMetadata: { creationTime: "2024-01-01", width: "100", height: "100" }
    };
    // We need to inject this into janCodeToPhotos. 
    // categorize_photo action does exactly this.
    store.dispatch(categorize_photo({ janCode, photo }));

    // 4. Setup Proposal
    store.dispatch(add_proposals([{
      janCode,
      inventoryItemIds: [itemId],
      photoGroupIds: [janCode],
      title: "New Product Title",
      handle: "explicit-handle-1", // Explicit handle
      bodyHtml: "<p>Description</p>",
      productCategory: "Stationery",
      vendor: "Dobutsu",
      tags: ["tag1"],
      option1Name: "Color",
      variants: [{ itemId, option1Value: "Red" }],
      status: 'draft',
      price: 1500
    }]));

    // 5. Execute Approve Thunk
    store.dispatch(approve_proposal_thunk(janCode) as any);

    // 6. Verify State
    const state = store.getState();
    const listing = state.listings.handleToListing["explicit-handle-1"];

    expect(listing).toBeDefined();
    expect(listing.title).toBe("New Product Title");
    
    // CRITICAL CHECK: Images
    expect(listing.images.length).toBe(1);
    expect(listing.images[0].url).toBe("https://lh3.googleusercontent.com/photo-1"); // Should be baseUrl
    expect(listing.images[0].altText).toBe("photo.jpg");
  });
});
