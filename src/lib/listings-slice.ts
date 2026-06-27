import { createAction, createReducer } from "@reduxjs/toolkit";
import {
  update_item,
  update_field,
  bulk_import_items,
  retype_item,
  rename_subtype,
} from "./inventory";
import { generateHandle } from "./handle-utils";
import { withTimestamp } from "./timestamped-case-reducer";

export interface ListingImage {
  id: string;
  url: string;
  position: number;
  altText: string;
  isListingOnly?: boolean;
}

export interface Listing {
  handle: string;
  title: string;
  bodyHtml: string;
  productCategory: string;
  productType: string;
  vendor: string;
  tags: string[];
  status: "active" | "archived" | "draft";
  option1Name: string; // e.g., "Color" or "Style"
  variantOptionsByItemId?: Record<string, string>;
  images: ListingImage[];
  lastUpdated: number;
}

export interface ListingsState {
  handleToListing: Record<string, Listing>;
  // Map inventory ID (item key) to Listing Handle to support partial updates/renames
  idToHandle: Record<string, string>;
  knownCategories: string[];
  initialized: boolean;
}

export const initialState: ListingsState = {
  handleToListing: {},
  idToHandle: {},
  knownCategories: [],
  initialized: false,
};

function ensureCategory(state: ListingsState, category: string) {
  if (category && !state.knownCategories.includes(category)) {
    state.knownCategories.push(category);
    state.knownCategories.sort();
  }
}

const actionTimestampMs = (action: { _timestamp: number }): number =>
  action._timestamp;

const keepLatestTimestamp = (
  currentTimestampMs: number,
  nextTimestampMs: number,
): number =>
  Math.max(Number(currentTimestampMs || 0), Number(nextTimestampMs || 0));

// Actions
export const create_listing = createAction<{ listing: Listing }>(
  "create_listing",
);
export const update_listing = createAction<{
  handle: string;
  changes: Partial<Listing>;
}>("update_listing");
export const delete_listing = createAction<{ handle: string }>(
  "delete_listing",
);
export const add_listing_image = createAction<{
  handle: string;
  image: ListingImage;
}>("add_listing_image");
export const remove_listing_image = createAction<{
  handle: string;
  imageId: string;
}>("remove_listing_image");

// Reducer
export const listings = createReducer(initialState, (builder) => {
  builder
    .addCase(create_listing, (state, action) => {
      const { listing } = action.payload;
      state.handleToListing[listing.handle] = listing;
      ensureCategory(state, listing.productCategory);
    })
    .addCase(
      update_listing,
      withTimestamp((state, action) => {
        const { handle, changes } = action.payload;
        const existing = state.handleToListing[handle];
        if (existing) {
          state.handleToListing[handle] = {
            ...existing,
            ...changes,
            lastUpdated: keepLatestTimestamp(
              existing.lastUpdated,
              actionTimestampMs(action),
            ),
          };
          if (changes.productCategory)
            ensureCategory(state, changes.productCategory);
        }
      }),
    )
    .addCase(delete_listing, (state, action) => {
      const { handle } = action.payload;
      delete state.handleToListing[handle];
      // Clean up idToHandle
      for (const [id, h] of Object.entries(state.idToHandle)) {
        if (h === handle) delete state.idToHandle[id];
      }
    })
    .addCase(
      add_listing_image,
      withTimestamp((state, action) => {
        const { handle, image } = action.payload;
        const listing = state.handleToListing[handle];
        if (listing) {
          const exists = listing.images.some((img) => img.id === image.id);
          if (!exists) {
            listing.images.push(image);
            listing.lastUpdated = keepLatestTimestamp(
              listing.lastUpdated,
              actionTimestampMs(action),
            );
          }
        }
      }),
    )
    .addCase(
      remove_listing_image,
      withTimestamp((state, action) => {
        const { handle, imageId } = action.payload;
        const listing = state.handleToListing[handle];
        if (listing) {
          listing.images = listing.images.filter((img) => img.id !== imageId);
          listing.lastUpdated = keepLatestTimestamp(
            listing.lastUpdated,
            actionTimestampMs(action),
          );
        }
      }),
    )
    // Inventory actions may update or link existing listings, but they must
    // not synthesize listing rows. Listing rows are created by Shopify import,
    // explicit listing actions, or listing draft approval.
    .addCase(
      update_item,
      withTimestamp((state, action) => {
        handleLegacyUpdate(
          state,
          action.payload.id,
          action.payload.item,
          actionTimestampMs(action),
        );
      }),
    )
    .addCase(
      bulk_import_items,
      withTimestamp((state, action) => {
        for (const importItem of action.payload.items) {
          handleLegacyUpdate(
            state,
            importItem.id,
            importItem.item,
            actionTimestampMs(action),
          );
        }
      }),
    )
    .addCase(
      update_field,
      withTimestamp((state, action) => {
        const { id, field, to } = action.payload;
        const handle = state.idToHandle[id];

        // Map Item fields to Listing fields
        const fieldKey = field as string;
        if (fieldKey === "handle") {
          const newHandle = String(to);
          applyHandleUpdate(
            state,
            id,
            newHandle,
            handle,
            actionTimestampMs(action),
          );
          return;
        }

        if (!handle) return; // Can't update if we don't know the handle

        const listing = state.handleToListing[handle];
        if (!listing) return;

        if (fieldKey === "description") {
          listing.title = String(to);
        } else if (fieldKey === "bodyHtml") {
          // Legacy field support
          listing.bodyHtml = String(to);
        } else if (fieldKey === "productCategory") {
          // Legacy
          listing.productCategory = String(to);
          ensureCategory(state, listing.productCategory);
        }
      }),
    );
});

// Helper to consolidate existing-listing updates between update_item and
// bulk_import_items. This intentionally never creates handleToListing rows.
function handleLegacyUpdate(
  state: ListingsState,
  id: string,
  itemPayload: any,
  timestampMs: number,
) {
  let handle = state.idToHandle[id];
  const explicitHandle = String(itemPayload.handle || "").trim();

  if (handle && !state.handleToListing[handle]) {
    delete state.idToHandle[id];
    handle = "";
  }

  if (!handle && explicitHandle && state.handleToListing[explicitHandle]) {
    handle = explicitHandle;
    state.idToHandle[id] = handle;
  }

  if (!handle && itemPayload.description && itemPayload.janCode) {
    const generatedHandle = generateHandle(
      itemPayload.description,
      itemPayload.janCode,
    );
    if (state.handleToListing[generatedHandle]) {
      handle = generatedHandle;
      state.idToHandle[id] = handle;
    }
  }

  if (!handle) return;

  let listing = state.handleToListing[handle];
  if (!listing) return;

  if (itemPayload.janCode) (listing as any).janCode = itemPayload.janCode;

  let targetHandle = handle;
  let newTitle = itemPayload.description || listing.title;

  if (explicitHandle) {
    targetHandle = explicitHandle;
  }

  if (targetHandle !== handle) {
    applyHandleUpdate(state, id, targetHandle, handle, timestampMs);
    const nextListing = state.handleToListing[targetHandle];
    if (nextListing) {
      listing = nextListing;
      listing.title = newTitle;
    }
    handle = targetHandle;
  } else {
    // Just update title
    listing.title = newTitle;
  }

  // Update other fields
  // Optimization: Only update if payload has data.
  // During merge (replay), we don't want a variant with empty body to wipe the main product's body.
  if (itemPayload.bodyHtml) listing.bodyHtml = itemPayload.bodyHtml;
  if (itemPayload.productCategory) {
    listing.productCategory = itemPayload.productCategory;
    ensureCategory(state, listing.productCategory);
  }

  // Handle Image
  // Shopify import can provide both a variant-specific image and a listing gallery image.
  // Prefer listingImage for listing gallery while preserving variant image on inventory item.
  const hasListingImageField = Object.prototype.hasOwnProperty.call(
    itemPayload,
    "listingImage",
  );
  const listingImageUrl = hasListingImageField
    ? itemPayload.listingImage || ""
    : itemPayload.image || "";
  if (listingImageUrl) {
    const hasImage = listing.images.some((img) => img.url === listingImageUrl);
    if (!hasImage) {
      listing.images.push({
        // Deterministic ID based on URL to ensure replay stability
        id: listingImageUrl,
        url: listingImageUrl,
        position: itemPayload.imagePosition || listing.images.length + 1,
        altText: itemPayload.imageAltText || itemPayload.description || "",
      });
      listing.lastUpdated = keepLatestTimestamp(
        listing.lastUpdated,
        timestampMs,
      );
    }
  }
}

function applyHandleUpdate(
  state: ListingsState,
  id: string,
  newHandle: string,
  previousHandle?: string,
  timestampMs = 0,
) {
  const priorHandle = previousHandle || state.idToHandle[id];
  const priorListing = priorHandle
    ? state.handleToListing[priorHandle]
    : undefined;
  const targetHandle = newHandle;
  const targetListing = targetHandle
    ? state.handleToListing[targetHandle]
    : undefined;
  if (priorHandle === targetHandle) return;
  const priorOption = priorListing?.variantOptionsByItemId?.[id];

  if (targetHandle && targetListing) {
    state.idToHandle[id] = targetHandle;
  } else {
    delete state.idToHandle[id];
  }

  if (targetListing && priorListing !== targetListing) {
    if (priorOption) {
      targetListing.variantOptionsByItemId = {
        ...(targetListing.variantOptionsByItemId || {}),
        [id]: priorOption,
      };
      targetListing.lastUpdated = keepLatestTimestamp(
        targetListing.lastUpdated,
        timestampMs,
      );
    }
  }
}
