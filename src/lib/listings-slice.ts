import { createAction, createReducer } from "@reduxjs/toolkit";
import { update_item, update_field, bulk_import_items } from "./inventory";
import { generateHandle } from "./handle-utils";

export interface ListingImage {
  id: string;
  url: string;
  position: number;
  altText: string;
}

export interface Listing {
  handle: string;
  title: string;
  bodyHtml: string;
  productCategory: string;
  productType: string;
  vendor: string;
  tags: string[];
  status: 'active' | 'archived' | 'draft';
  option1Name: string; // e.g., "Color" or "Style"
  images: ListingImage[];
  lastUpdated: number;
}

export interface ListingsState {
  handleToListing: Record<string, Listing>;
  // Map inventory ID (item key) to Listing Handle to support partial updates/renames
  idToHandle: Record<string, string>; 
  initialized: boolean;
}

export const initialState: ListingsState = {
  handleToListing: {},
  idToHandle: {},
  initialized: false,
};

// Actions
export const create_listing = createAction<{ listing: Listing }>("create_listing");
export const update_listing = createAction<{ handle: string; changes: Partial<Listing> }>("update_listing");
export const delete_listing = createAction<{ handle: string }>("delete_listing");
export const add_listing_image = createAction<{ handle: string; image: ListingImage }>("add_listing_image");
export const remove_listing_image = createAction<{ handle: string; imageId: string }>("remove_listing_image");

// Reducer
export const listings = createReducer(initialState, (builder) => {
  builder
    .addCase(create_listing, (state, action) => {
      const { listing } = action.payload;
      state.handleToListing[listing.handle] = listing;
    })
    .addCase(update_listing, (state, action) => {
      const { handle, changes } = action.payload;
      const existing = state.handleToListing[handle];
      if (existing) {
        state.handleToListing[handle] = {
           ...existing,
           ...changes,
           lastUpdated: Date.now()
        };
      }
    })
    .addCase(delete_listing, (state, action) => {
        const { handle } = action.payload;
        delete state.handleToListing[handle];
        // Clean up idToHandle
        for (const [id, h] of Object.entries(state.idToHandle)) {
            if (h === handle) delete state.idToHandle[id];
        }
    })
    .addCase(add_listing_image, (state, action) => {
        const { handle, image } = action.payload;
        const listing = state.handleToListing[handle];
        if (listing) {
            // Allow duplicates as requested
            listing.images.push(image);
            listing.lastUpdated = Date.now();
        }
    })
    .addCase(remove_listing_image, (state, action) => {
        const { handle, imageId } = action.payload;
        const listing = state.handleToListing[handle];
        if (listing) {
            listing.images = listing.images.filter(img => img.id !== imageId);
            listing.lastUpdated = Date.now();
        }
    })
    // Legacy Action Handling for Replay
    .addCase(update_item, (state, action) => {
        handleLegacyUpdate(state, action.payload.id, action.payload.item, (action as any).timestamp);
    })
    .addCase(bulk_import_items, (state, action) => {
        // Iterate over all items in the bulk import and process them
        for (const importItem of action.payload.items) {
           // We treat 'new' and 'update' similarly for listings: 
           // ensure listing exists and update fields if present.
           handleLegacyUpdate(state, importItem.id, importItem.item, (action as any).timestamp);
        }
    })
    .addCase(update_field, (state, action) => {
        const { id, field, to } = action.payload;
        const handle = state.idToHandle[id];
        
        if (!handle) return; // Can't update if we don't know the handle
        
        const listing = state.handleToListing[handle];
        if (!listing) return;
        
        // Map Item fields to Listing fields
        const fieldKey = field as string;
        if (fieldKey === 'description') {
            // Rename logic similar to above
            const newTitle = String(to);
            const janCode = (listing as any).janCode;
            if (janCode) {
                const newHandle = generateHandle(newTitle, janCode);
                 if (newHandle !== handle) {
                    const movedListing = { ...listing, handle: newHandle, title: newTitle };
                    delete state.handleToListing[handle];
                    state.handleToListing[newHandle] = movedListing;
                    state.idToHandle[id] = newHandle;
               } else {
                   listing.title = newTitle;
               }
            } else {
                listing.title = newTitle;
            }
        } else if (fieldKey === 'bodyHtml') { // Legacy field support
             listing.bodyHtml = String(to);
        } else if (fieldKey === 'productCategory') { // Legacy
             listing.productCategory = String(to);
        }
    });
});

// Helper to consolidate logic between update_item and bulk_import_items
function handleLegacyUpdate(state: ListingsState, id: string, itemPayload: any, timestamp: number | undefined) {
      // 1. Resolve Handle
      let handle = state.idToHandle[id];
      
      // If no handle mapped, try to generate from payload (Creation scenario)
      if (!handle) {
          if (itemPayload.handle) handle = itemPayload.handle;
          else if (itemPayload.description && itemPayload.janCode) {
              handle = generateHandle(itemPayload.description, itemPayload.janCode);
          } else {
              if (!itemPayload.janCode) return; 
              handle = generateHandle(itemPayload.description || "Untitled", itemPayload.janCode);
          }
          state.idToHandle[id] = handle;
      }

      // 2. Get Existing Listing or Create New
      let listing = state.handleToListing[handle];

      if (!listing) {
          // Creation Scenario
          listing = {
              handle,
              title: itemPayload.description || "Untitled",
              bodyHtml: itemPayload.bodyHtml || "",
              productCategory: itemPayload.productCategory || "",
              productType: "",
              vendor: "SPNSS Ltd.",
              tags: [],
              status: "active",
              option1Name: "Subtype",
              images: [],
              lastUpdated: timestamp || Date.now(),
              // Store janCode for future re-generation/validation if needed?
              // Not strictly in Listing interface but useful. 
              // We rely on idToHandle map + payload updates.
          } as Listing; // Cast to force verify or allow extra props if needed
          
          // Inject janCode property directly if flexible, or rely only on payload
           (listing as any).janCode = itemPayload.janCode;

          state.handleToListing[handle] = listing;
      }

      // 3. Handle Updates & Renames
      const currentJanCode = (listing as any).janCode || itemPayload.janCode; 
      if (itemPayload.janCode) (listing as any).janCode = itemPayload.janCode;

      // Check if payload provides an explicit handle (e.g. from Shopify Import)
      // or if we need to regenerate due to title/jan change.
      let targetHandle = handle;
      let newTitle = itemPayload.description || listing.title;

      if (itemPayload.handle) {
          targetHandle = itemPayload.handle;
      } 
      // REVISED (2025-12-22): 
      // Do NOT regenerate handle implicitly on title/jan change. 
      // Handles should be sticky (like Shopify). Only update if explicit handle provided.
      // This preserves custom handles (e.g. from bulk import) even if legacy update_item actions come in.
      
      /*
      else if (itemPayload.description || itemPayload.janCode) {
           const newTitle = itemPayload.description || listing.title;
           const newJan = itemPayload.janCode || (listing as any).janCode;
           
           // Only regenerate handle if the data actually changed.
           // This prevents legacy update_item actions (merged from inventory) from
           // clobbering a custom handle set by bulk_import_items if the description is the same.
           const titleChanged = itemPayload.description && itemPayload.description !== listing.title;
           const janChanged = itemPayload.janCode && itemPayload.janCode !== (listing as any).janCode;

           if ((titleChanged || janChanged) && newJan) {
               if (newTitle.toLowerCase().includes('zebra')) {
                   console.log(`[Slice Debug] Regenerating handle for ${newTitle}. Old: ${handle}. TitleChanged: ${titleChanged} ('${listing.title}' vs '${itemPayload.description}'). JanChanged: ${janChanged}`);
               }
               targetHandle = generateHandle(newTitle, newJan);
           }
      }
      */

      if (targetHandle !== handle) {
           // Move Listing / Remap ID
           // NOTE: If targetHandle already exists (e.g. merging into a group),
           // we should merge, not overwrite blindly?
           // The current logic was "delete old, set new".
           // If targetHandle exists, we want to point this ID to it.
           
           state.idToHandle[id] = targetHandle;
           
           const existingTarget = state.handleToListing[targetHandle];
           
           if (existingTarget) {
               // Merge into existing listing
               // We don't need to move the old listing, we just re-point the ID.
               // BUT, if the old listing has no other IDs pointing to it, we might want to delete it?
               // For safety/simplicity, let's just update the ID mapping.
               // And ensure the existing target gets any new data.
               listing = existingTarget;
               listing.title = newTitle; // Update title of target? Conflicting updates...
               // For import, last write wins or specific merge logic. Let's assume update.
           } else {
               // Move the listing object to the new handle
               const movedListing = { ...listing, handle: targetHandle, title: newTitle };
               // Only delete if we are "renaming" and not "merging" 
               // Actually, if we are moving this ID, and assuming 1:1, we move the listing.
               delete state.handleToListing[handle];
               state.handleToListing[targetHandle] = movedListing;
               listing = movedListing;
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
      if (itemPayload.productCategory) listing.productCategory = itemPayload.productCategory;
      
      // Handle Image
      if (itemPayload.image) {
            listing.images.push({
                  id: crypto.randomUUID(),
                  url: itemPayload.image,
                  position: itemPayload.imagePosition || listing.images.length + 1,
                  altText: itemPayload.imageAltText || itemPayload.description || ""
            });
            listing.lastUpdated = Date.now();
      }
}
