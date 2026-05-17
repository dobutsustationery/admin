import { describe, expect, it, vi } from "vitest";
import { configureStore } from "@reduxjs/toolkit";
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
import {
  approve_proposal_thunk,
  add_proposals_internal,
} from "$lib/listing-creation-slice";
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
      image: "",
    };
    store.dispatch(update_item({ id: itemId, item }));

    // 3. Setup Photos (Categorized)
    const photo: MediaItem = {
      id: "photo-1",
      baseUrl: "https://lh3.googleusercontent.com/photo-1",
      productUrl: "https://photos.google.com/photo-1",
      mimeType: "image/jpeg",
      filename: "photo.jpg",
      mediaMetadata: {
        creationTime: "2024-01-01",
        width: "100",
        height: "100",
      },
    };
    // We need to inject this into janCodeToPhotos.
    // categorize_photo action does exactly this.
    store.dispatch(categorize_photo({ janCode, photo }));

    // 4. Setup Proposal
    store.dispatch(
      add_proposals_internal([
        {
          janCode,
          inventoryItemIds: [itemId],
          photoGroupIds: [janCode],
          title: "New Product Title",
          handle: "explicit-handle-1", // Explicit handle
          bodyHtml: "<p>Description</p>",
          productCategory: "Stationery",
          vendor: "Dobutsu",
          tags: ["tag1"],
          option1Name: "Subtype",
          variants: [{ id: "v1", itemId, option1Value: "Red" }],
          status: "draft",
          price: 1500,
        },
      ]),
    );

    // 5. Execute Approve Thunk
    store.dispatch(approve_proposal_thunk(janCode) as any);

    // 6. Verify State
    const state = store.getState();
    const listing = state.listings.handleToListing["explicit-handle-1"];

    expect(listing).toBeDefined();
    expect(listing.title).toBe("New Product Title");

    // CRITICAL CHECK: Images
    expect(listing.images.length).toBe(1);
    expect(listing.images[0].url).toBe(
      "https://lh3.googleusercontent.com/photo-1",
    ); // Should be baseUrl
    expect(listing.images[0].altText).toBe("photo.jpg");
  });

  it("should aggregate photos from all sibling proposals when approving a merged group", () => {
    const store = configureStore({ reducer: rootReducer });
    const janA = "JAN_A";
    const janB = "JAN_B";
    const handle = "merged-handle";

    // 1. Setup Inventory
    store.dispatch(
      update_item({
        id: "item-A",
        item: {
          janCode: janA,
          handle,
          image: "",
          subtype: "A",
          description: "A",
          qty: 1,
          price: 100,
          shipped: 0,
          pieces: 1,
          creationDate: "",
          timestamp: 0,
          hsCode: "",
        },
      }),
    );
    store.dispatch(
      update_item({
        id: "item-B",
        item: {
          janCode: janB,
          handle,
          image: "",
          subtype: "B",
          description: "B",
          qty: 1,
          price: 100,
          shipped: 0,
          pieces: 1,
          creationDate: "",
          timestamp: 0,
          hsCode: "",
        },
      }),
    );

    // 2. Setup Photos
    store.dispatch(
      categorize_photo({
        janCode: janA,
        photo: {
          id: "p1",
          baseUrl: "url-A",
          filename: "A.jpg",
          productUrl: "",
          mimeType: "",
          mediaMetadata: { creationTime: "1", width: "1", height: "1" },
        },
      }),
    );
    store.dispatch(
      categorize_photo({
        janCode: janB,
        photo: {
          id: "p2",
          baseUrl: "url-B",
          filename: "B.jpg",
          productUrl: "",
          mimeType: "",
          mediaMetadata: { creationTime: "2", width: "1", height: "1" },
        },
      }),
    );

    // 3. Setup Proposals (Merged via handle)
    const baseProp = {
      bodyHtml: "",
      productCategory: "",
      vendor: "",
      tags: [],
      option1Name: "Type",
      variants: [],
      status: "draft" as const,
    };
    store.dispatch(
      add_proposals_internal([
        {
          ...baseProp,
          janCode: janA,
          inventoryItemIds: ["item-A"],
          photoGroupIds: [janA],
          title: "Product",
          handle,
          variants: [{ id: "vA", itemId: "item-A", option1Value: "A" }],
        },
        {
          ...baseProp,
          janCode: janB,
          inventoryItemIds: ["item-B"],
          photoGroupIds: [janB],
          title: "Product",
          handle,
          variants: [{ id: "vB", itemId: "item-B", option1Value: "B" }],
        },
      ]),
    );

    // 4. Approve JAN_A
    store.dispatch(approve_proposal_thunk(janA) as any);

    // 5. Verify Listing has BOTH photos
    const listing = store.getState().listings.handleToListing[handle];
    expect(listing).toBeDefined();
    expect(listing.images.length).toBe(2);
    expect(listing.images.map((i: any) => i.url)).toContain("url-A");
    expect(listing.images.map((i: any) => i.url)).toContain("url-B");
  });
});
