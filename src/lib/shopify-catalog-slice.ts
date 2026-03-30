import { createAction, createReducer } from "@reduxjs/toolkit";

export interface ShopifyCatalogImage {
  id: string;
  url: string;
  position: number;
  altText: string;
}

export interface ShopifyCatalogVariant {
  id: string;
  sku: string;
  subtype: string;
  price: number;
  janCode: string;
  weight: number;
  inventoryQuantity: number;
  image: string;
}

export interface ShopifyCatalogListing {
  productId: string;
  handle: string;
  title: string;
  bodyHtml: string;
  vendor: string;
  productType: string;
  productCategory: string;
  tags: string[];
  status: "active" | "archived" | "draft";
  option1Name: string;
  updatedAtIso: string;
  updatedAtMs: number;
  images: ShopifyCatalogImage[];
  variants: ShopifyCatalogVariant[];
}

export interface ShopifyCatalogState {
  handleToListing: Record<string, ShopifyCatalogListing>;
  maxUpdatedAtMs: number;
  lastSyncMode: "" | "full" | "incremental";
  lastSyncRequestedAtMs: number;
  lastSyncCompletedAtMs: number;
  lastSyncFailedAtMs: number;
  lastSyncError: string;
  lastAppliedRequestId: string;
  lastFailedRequestId: string;
  hasCompletedFullSync: boolean;
  activeRequestId: string;
  stagingHandleToListing: Record<string, ShopifyCatalogListing> | null;
  stagingRequestId: string;
}

export const initialState: ShopifyCatalogState = {
  handleToListing: {},
  maxUpdatedAtMs: 0,
  lastSyncMode: "",
  lastSyncRequestedAtMs: 0,
  lastSyncCompletedAtMs: 0,
  lastSyncFailedAtMs: 0,
  lastSyncError: "",
  lastAppliedRequestId: "",
  lastFailedRequestId: "",
  hasCompletedFullSync: false,
  activeRequestId: "",
  stagingHandleToListing: null,
  stagingRequestId: "",
};

export const begin_shopify_catalog_sync = createAction<{
  requestId: string;
  mode: "full" | "incremental";
  requestedAtMs: number;
}>("shopifyCatalog/begin_sync");

export const apply_shopify_catalog_sync_chunk = createAction<{
  requestId: string;
  mode: "full" | "incremental";
  listings: ShopifyCatalogListing[];
}>("shopifyCatalog/apply_sync_chunk");

export const complete_shopify_catalog_sync = createAction<{
  requestId: string;
  mode: "full" | "incremental";
  syncedAtMs: number;
  maxUpdatedAtMs: number;
}>("shopifyCatalog/complete_sync");

export const fail_shopify_catalog_sync = createAction<{
  requestId: string;
  mode: "full" | "incremental";
  failedAtMs: number;
  errorMessage: string;
}>("shopifyCatalog/fail_sync");

export const reset_shopify_catalog_state = createAction(
  "shopifyCatalog/reset_state",
);

export const shopifyCatalog = createReducer(initialState, (builder) => {
  builder
    .addCase(begin_shopify_catalog_sync, (state, action) => {
      const { requestId, mode, requestedAtMs } = action.payload;
      state.lastSyncMode = mode;
      state.lastSyncRequestedAtMs = Math.max(
        Number(state.lastSyncRequestedAtMs || 0),
        Number(requestedAtMs || 0),
      );
      state.lastSyncError = "";
      state.activeRequestId = requestId;
      if (mode === "full") {
        state.stagingRequestId = requestId;
        state.stagingHandleToListing = {};
      }
    })
    .addCase(apply_shopify_catalog_sync_chunk, (state, action) => {
      const { requestId, mode, listings } = action.payload;
      const safeListings = Array.isArray(listings) ? listings : [];

      if (mode === "full" && state.stagingRequestId === requestId) {
        const target = state.stagingHandleToListing || {};
        safeListings.forEach((listing) => {
          if (!listing?.handle) return;
          target[listing.handle] = listing;
        });
        state.stagingHandleToListing = target;
        return;
      }

      safeListings.forEach((listing) => {
        if (!listing?.handle) return;
        state.handleToListing[listing.handle] = listing;
      });
    })
    .addCase(complete_shopify_catalog_sync, (state, action) => {
      const { requestId, mode, syncedAtMs, maxUpdatedAtMs } = action.payload;
      if (mode === "full" && state.stagingRequestId === requestId) {
        state.handleToListing = state.stagingHandleToListing || {};
        state.stagingHandleToListing = null;
        state.stagingRequestId = "";
        state.hasCompletedFullSync = true;
      }
      state.lastSyncMode = mode;
      state.lastAppliedRequestId = requestId;
      state.activeRequestId = "";
      state.lastSyncError = "";
      state.lastSyncCompletedAtMs = Math.max(
        Number(state.lastSyncCompletedAtMs || 0),
        Number(syncedAtMs || 0),
      );
      state.maxUpdatedAtMs = Math.max(
        Number(state.maxUpdatedAtMs || 0),
        Number(maxUpdatedAtMs || 0),
      );
    })
    .addCase(fail_shopify_catalog_sync, (state, action) => {
      const { requestId, failedAtMs, errorMessage } = action.payload;
      if (state.stagingRequestId === requestId) {
        state.stagingHandleToListing = null;
        state.stagingRequestId = "";
      }
      state.activeRequestId = "";
      state.lastFailedRequestId = requestId;
      state.lastSyncFailedAtMs = Math.max(
        Number(state.lastSyncFailedAtMs || 0),
        Number(failedAtMs || 0),
      );
      state.lastSyncError = String(errorMessage || "").trim();
    })
    .addCase(reset_shopify_catalog_state, () => initialState);
});
