import { combineReducers } from "@reduxjs/toolkit";
import { history } from "./history";
import {
  inventory,
  bulk_import_items,
  type BulkImportItem,
  type Item,
  update_field,
  split_inventory_item
} from "./inventory";
import { names } from "./names";
import { photos, rename_jan_group } from "./photos-slice";
import {
  orderImport,
  computeOrderImportBatch,
  mark_items_done as markOrderDone,
} from "./order-import-slice";
import {
  shopifyImport,
  computeShopifyImportBatch,
  mark_items_done as markShopifyDone,
} from "./shopify-import-slice";
import { listings, add_listing_image, create_listing, update_listing } from "./listings-slice";
import listingCreation, { 
  add_variants_internal,
  add_proposals_internal,
  update_variant_value,
  set_variant_photo_group,
  remove_proposal,
  complete_batch
} from "./listing-creation-slice";
import { ui } from "./ui-slice";
import { logAction } from "./devtools-middleware";
import { generateHandle } from "./handle-utils";
import { buildDraftListingImages } from "./listing-image-logic";

const reducerObject = {
  names,
  inventory,
  history,
  photos,
  orderImport,
  shopifyImport,
  listings,
  listingCreation,
  ui,
};
const combinedReducer = combineReducers(reducerObject);

// Helper to map Order Import Item to Inventory Item
const mapOrderToInventory = (importItem: any): Item => {
  return {
    janCode: importItem.janCode,
    subtype: "", 
    description: importItem.description,
    hsCode: importItem.hsCode || "",
    image: "",
    qty: importItem.qty,
    pieces: 1,
    shipped: 0,
    creationDate: "Unknown",
    timestamp: 0,
    price: importItem.price,
    weight: importItem.weight,
    countryOfOrigin: importItem.countryOfOrigin,
  };
};

// Helper to map Shopify Import Item to Inventory Item
const mapShopifyToInventory = (importItem: any): Item => {
  return {
    janCode: importItem.janCode,
    subtype: "",
    description: importItem.description,
    hsCode: "",
    image: importItem.image || "",
    qty: importItem.qty,
    pieces: 1,
    shipped: 0,
    creationDate: "Unknown",
    timestamp: 0,
    price: importItem.price,
    weight: importItem.weight,
    handle: importItem.handle,
    ...importItem,
  } as Item;
};

// Root reducer to handle full state hydration and Event Sourcing Orchestration
export const rootReducer = (state: any, action: any, logger = logAction) => {
  if (action.type === "HYDRATE") {
    return { ...state, ...action.payload };
  }

  // 1. Standard Reducer Execution
  let nextState = combinedReducer(state, action);

  // 2. Interception & Composition

  // Synchronize Listings idToHandle and Photo Groups when item keys change
  const isRetype = action.type === "retype_item";
  const isRename = action.type === "rename_subtype";
  const isSubtypeUpdate = action.type === "update_field" && action.payload.field === 'subtype';
  const isVariantValueUpdate = action.type === "listingCreation/update_variant_value";

  if (isRetype || isRename || isSubtypeUpdate || isVariantValueUpdate) {
      let oldItemId = "";
      let newItemId = "";
      let oldBaseJan = "";
      let newBaseJan = "";
      let oldSubtype = "";
      let newSubtype = "";

      if (isRetype) {
          const { itemKey, janCode, subtype } = action.payload;
          oldItemId = itemKey;
          newBaseJan = janCode;
          newSubtype = subtype?.trim() || "";
          newItemId = `${newBaseJan}${newSubtype}`;
          const oldItem = state.inventory.idToItem[oldItemId];
          if (oldItem) {
              oldBaseJan = oldItem.janCode;
              oldSubtype = oldItem.subtype;
          }
      } else if (isRename) {
          const { itemKey, subtype } = action.payload;
          oldItemId = itemKey;
          newSubtype = subtype?.trim() || "";
          const oldItem = state.inventory.idToItem[oldItemId];
          if (oldItem) {
              oldBaseJan = oldItem.janCode;
              newBaseJan = oldBaseJan;
              oldSubtype = oldItem.subtype;
              newItemId = `${newBaseJan}${newSubtype}`;
          }
      } else if (isSubtypeUpdate) {
          const { id: itemKey, to: subtype } = action.payload;
          oldItemId = itemKey;
          newSubtype = (subtype as string)?.trim() || "";
          const oldItem = state.inventory.idToItem[oldItemId];
          if (oldItem) {
              oldBaseJan = oldItem.janCode;
              newBaseJan = oldBaseJan;
              oldSubtype = oldItem.subtype;
              newItemId = `${newBaseJan}${newSubtype}`;
          }
      }

      if (oldItemId && newItemId && oldItemId !== newItemId) {
          // 1. Sync idToHandle (Listings)
          const handle = state.listings.idToHandle[oldItemId];
          if (handle) {
              const listingState = nextState.listings;
              const nextIdToHandle = { ...listingState.idToHandle, [newItemId]: handle };
              delete nextIdToHandle[oldItemId];
              nextState = {
                  ...nextState,
                  listings: { ...listingState, idToHandle: nextIdToHandle }
              };
          }

          // 2. Sync Photo Groups (Photos)
          // Try OldItemID first, then OldBaseJan:OldSubtype
          const candidates = [oldItemId, `${oldBaseJan}:${oldSubtype}`];
          const found = candidates.find(c => state.photos.janCodeToPhotos[c]);
          if (found) {
              const newPhotoKey = newSubtype ? `${newBaseJan}:${newSubtype}` : newBaseJan;
              if (found !== newPhotoKey) {
                  console.log(`[RootReducer] Orchestrating photo group rename: ${found} -> ${newPhotoKey}`);
                  
                  // Update Photos State immutably
                  const photosState = nextState.photos;
                  const nextJanCodeToPhotos = { ...photosState.janCodeToPhotos };
                  const groupPhotos = nextJanCodeToPhotos[found] || [];
                  
                  if (groupPhotos.length > 0) {
                      if (!nextJanCodeToPhotos[newPhotoKey]) {
                          nextJanCodeToPhotos[newPhotoKey] = [];
                      }
                      nextJanCodeToPhotos[newPhotoKey] = [...nextJanCodeToPhotos[newPhotoKey], ...groupPhotos];
                      delete nextJanCodeToPhotos[found];
                      
                      nextState = {
                          ...nextState,
                          photos: {
                              ...photosState,
                              janCodeToPhotos: nextJanCodeToPhotos
                          }
                      };
                      
                      // Log a synthetic action for clarity in devtools
                      logger({ type: 'photos/rename_jan_group (synthetic)', payload: { oldJan: found, newJan: newPhotoKey }, _ephemeral: true }, nextState, action._timestamp);
                  }
              }
          }
      }

      // Handle variant value update separately (Listing Creation)
      if (isVariantValueUpdate) {
          const { janCode, variantId, value } = action.payload;
          const proposal = state.listingCreation.proposals[janCode];
          if (proposal) {
              const variant = proposal.variants.find((v: any) => v.id === variantId || v.itemId === variantId);
              if (variant && variant.photoGroupKey) {
                  const oldPhotoKey = variant.photoGroupKey;
                  const cleanSubtype = value?.trim() || "";
                  // Use the JAN from the OLD photo key to support merged proposals with multiple JANs
                  const baseJan = oldPhotoKey.split(':')[0];
                  const newPhotoKey = cleanSubtype ? `${baseJan}:${cleanSubtype}` : baseJan;
                  
                  if (state.photos.janCodeToPhotos[oldPhotoKey] && oldPhotoKey !== newPhotoKey) {
                      // 1. Rename the actual photo group
                      const photosState = nextState.photos;
                      const nextJanCodeToPhotos = { ...photosState.janCodeToPhotos };
                      const groupPhotos = nextJanCodeToPhotos[oldPhotoKey] || [];
                      
                      if (groupPhotos.length > 0) {
                          if (!nextJanCodeToPhotos[newPhotoKey]) {
                              nextJanCodeToPhotos[newPhotoKey] = [];
                          }
                          nextJanCodeToPhotos[newPhotoKey] = [...nextJanCodeToPhotos[newPhotoKey], ...groupPhotos];
                          delete nextJanCodeToPhotos[oldPhotoKey];
                          
                          nextState = {
                              ...nextState,
                              photos: {
                                  ...photosState,
                                  janCodeToPhotos: nextJanCodeToPhotos
                              }
                          };
                          logger({ type: 'photos/rename_jan_group (synthetic)', payload: { oldJan: oldPhotoKey, newJan: newPhotoKey }, _ephemeral: true }, nextState, action._timestamp);
                      }
                      
                      // 2. Update variant's photoGroupKey reference (Listings Creation)
                      const listingCreationState = nextState.listingCreation;
                      const nextProposal = listingCreationState.proposals[janCode];
                      if (nextProposal) {
                          const nextVariants = nextProposal.variants.map((v: any) => {
                              if (v.id === variantId || v.itemId === variantId) {
                                  return { ...v, photoGroupKey: newPhotoKey };
                              }
                              return v;
                          });
                          
                          nextState = {
                              ...nextState,
                              listingCreation: {
                                  ...listingCreationState,
                                  proposals: {
                                      ...listingCreationState.proposals,
                                      [janCode]: {
                                          ...nextProposal,
                                          variants: nextVariants
                                      }
                                  }
                              }
                          };
                      }
                  }
              }
          }
      }
  }

  // Listing <-> Inventory Sync (Title/Description)
  if (action.type === "update_field") {
      const { id, field, to } = action.payload;
      
      // Case A: Linking (Handle Set)
      if (field === 'handle') {
          const handle = to;
          const listing = nextState.listings.handleToListing[handle];
          if (listing) {
              if (nextState.inventory.idToItem[id].description !== listing.title) {
                   const syncAction = {
                       ...update_field({ id, field: 'description', from: nextState.inventory.idToItem[id].description, to: listing.title }),
                       _ephemeral: true,
                       timestamp: action.timestamp || action._timestamp
                   };
                   nextState = { 
                       ...nextState, 
                       inventory: inventory(nextState.inventory, syncAction) 
                   };
                   logger(syncAction, nextState, action._timestamp);
              }
          }
      }
      
      // Case B: Item Description Update -> Propagate to Listing & Siblings
      if (field === 'description') {
          const item = nextState.inventory.idToItem[id];
          if (item && item.handle) {
              const listing = nextState.listings.handleToListing[item.handle];
              if (listing) {
                  // 1. Update Listing Title (if not already updated by listings slice)
                  if (listing.title !== to) {
                      const updateListingAction = {
                          ...update_listing({ handle: item.handle, changes: { title: to } }),
                          _ephemeral: true,
                          timestamp: action.timestamp || action._timestamp
                      };
                      nextState = {
                          ...nextState,
                          listings: listings(nextState.listings, updateListingAction)
                      };
                      logger(updateListingAction, nextState, action._timestamp);
                  }
                  
                  // 2. Update Siblings (Always check consistency)
                  const handle = item.handle;
                  const newTitle = to;
                  for (const otherId in nextState.inventory.idToItem) {
                      const otherItem = nextState.inventory.idToItem[otherId];
                      if (otherItem.handle === handle && otherItem.description !== newTitle) {
                           const syncSiblingAction = {
                               ...update_field({ id: otherId, field: 'description', from: otherItem.description, to: newTitle }),
                               _ephemeral: true,
                               timestamp: action.timestamp || action._timestamp
                           };
                           nextState = { 
                               ...nextState, 
                               inventory: inventory(nextState.inventory, syncSiblingAction) 
                           };
                           logger(syncSiblingAction, nextState, action._timestamp);
                      }
                  }
              }
          }
      }
  }

  if (action.type === "update_listing") {
      const { handle, changes } = action.payload;
      if (changes.title) {
          const newTitle = changes.title;
          // Propagate title to ALL items with this handle
          for (const id in nextState.inventory.idToItem) {
              const item = nextState.inventory.idToItem[id];
              if (item.handle === handle && newTitle && item.description !== newTitle) {
                   const syncAction = {
                       ...update_field({ id, field: 'description', from: item.description, to: newTitle }),
                       _ephemeral: true,
                       timestamp: action.timestamp || action._timestamp
                   };
                   nextState = { 
                       ...nextState, 
                       inventory: inventory(nextState.inventory, syncAction) 
                   };
                   logger(syncAction, nextState, action._timestamp);
              }
          }
      }
  }

  // Order Import Batch
  if (action.type === "orderImport/import_batch" && state.orderImport) {
    console.log(
      "[RootReducer] Intercepting Order Import Batch",
      action.payload,
    );

    const { updates, indices } = computeOrderImportBatch(
      state.orderImport,
      state.inventory.idToItem,
      action.payload.filter,
    );

    // Map updates to BulkImportItem (if compute returns raw objects)
    const bulkUpdates: BulkImportItem[] = updates.map((u) => ({
      type: u.type,
      id: u.id,
      item: u.type === "new" ? mapOrderToInventory(u.item) : u.item, 
    }));

    if (bulkUpdates.length > 0) {
      const internalAction = {
        ...bulk_import_items({ items: bulkUpdates }),
        _ephemeral: true,
        timestamp: action.timestamp || action._timestamp, // Uses propagated timestamp
      };

      // Apply to Inventory
      nextState = {
        ...nextState,
        inventory: inventory(nextState.inventory, internalAction),
      };
      logger(internalAction, nextState, action._timestamp); // LOG SUB-ACTION

      // Apply to Listings
      nextState = {
        ...nextState,
        listings: listings(nextState.listings, internalAction),
      };
      // Listings sub-log
      logger({ ...internalAction, type: 'bulk_import_items (listings)' }, nextState, action._timestamp); 
    }

    // Mark Items Done in Order Import Slice
    if (indices.length > 0) {
      const markAction = markOrderDone({ indices });
      nextState = {
        ...nextState,
        orderImport: orderImport(nextState.orderImport, markAction),
      };
      logger(markAction, nextState, action._timestamp); // LOG SUB-ACTION
    }
  }

  // Shopify Import Batch
  if (action.type === "shopifyImport/import_batch" && state.shopifyImport) {
    const { filter, options } = action.payload; 
    console.log(
      `[RootReducer] Intercepting Shopify Import Batch { filter: '${filter}' }`,
    );

    const { updates, listingUpdates, indices } = computeShopifyImportBatch(
      state.shopifyImport,
      state.inventory.idToItem,
      state.listings.handleToListing,
      filter,
      options, 
    );

    const bulkUpdates: BulkImportItem[] = updates.map((u) => ({
      type: u.type,
      id: u.id,
      item: u.type === "new" ? mapShopifyToInventory(u.item) : u.item,
    }));

    if (bulkUpdates.length > 0) {
      const internalAction = {
        ...bulk_import_items({ items: bulkUpdates }),
        _ephemeral: true,
        timestamp: action.timestamp || action._timestamp,
      };

      nextState = {
        ...nextState,
        inventory: inventory(nextState.inventory, internalAction),
        listings: listings(nextState.listings, internalAction),
      };
      logger(internalAction, nextState, action._timestamp); // LOG SUB-ACTION
    }

    if (listingUpdates && listingUpdates.length > 0) {
      let nextListings = nextState.listings;
      listingUpdates.forEach((u) => {
        if (u.type === "add_image") {
          const internalAction = {
            ...add_listing_image({ handle: u.handle, image: u.image }),
            _ephemeral: true,
            timestamp: action.timestamp || action._timestamp,
          };
          nextListings = listings(nextListings, internalAction);
          // We must update nextState.listings locally to pass to next iteration
          // but we also want to capture the full state for the log.
          const intermediateState = { ...nextState, listings: nextListings };
          logger(internalAction, intermediateState, action._timestamp); // LOG SUB-ACTION
        } else if (u.type === "create_listing") {
          const internalAction = {
            ...create_listing({ listing: u.listing }),
            _ephemeral: true,
            timestamp: action.timestamp || action._timestamp,
          };
          nextListings = listings(nextListings, internalAction);
          const intermediateState = { ...nextState, listings: nextListings };
          logger(internalAction, intermediateState, action._timestamp); // LOG SUB-ACTION
        }
      });
      nextState = { ...nextState, listings: nextListings };
    }

    if (indices.length > 0) {
      const markAction = markShopifyDone({ indices });
      nextState = {
        ...nextState,
        shopifyImport: shopifyImport(nextState.shopifyImport, markAction),
      };
      logger(markAction, nextState, action._timestamp); // LOG SUB-ACTION
    }
  }

  // Add Proposals (Interception & Enrichment)
  if (action.type === "listingCreation/add_proposals") {
      const cleanProposals = action.payload;
      
      const enrichedProposals = cleanProposals.map((p: any) => {
          // Find matching inventory items
          const inventoryItems: { id: string, item: any }[] = [];
          for (const [id, val] of Object.entries(state.inventory.idToItem)) {
              const item = val as any;
              if (item.janCode === p.janCode && !item.handle && item.qty > 0) {
                  inventoryItems.push({ id, item });
              }
          }
          const inventoryItemIds = inventoryItems.map(x => x.id);
          // Default to empty string if no inventory items found (shouldn't happen if scan logic was correct)
          const baseItemId = inventoryItemIds.length > 0 ? inventoryItemIds[0] : ""; 
          
          return {
              ...p,
              inventoryItemIds,
              variants: p.variants.map((v: any) => ({
                  ...v,
                  itemId: baseItemId // Enrich variant with inventory link
              }))
          };
      });

      const internalAction = {
          ...add_proposals_internal(enrichedProposals),
          _ephemeral: true,
          timestamp: action.timestamp || action._timestamp
      };
      
      nextState = {
          ...nextState,
          listingCreation: listingCreation(nextState.listingCreation, internalAction)
      };
      logger(internalAction, nextState, action._timestamp);
  }

  // Import Existing Variants (Listing Creation)
  if (action.type === "listingCreation/import_existing_variants" && state.inventory) {
      const { janCode, handle } = action.payload;
      console.log(`[RootReducer] Importing variants for ${janCode} from handle ${handle}`);
      
      const matchedItems: { id: string, item: Item }[] = [];
      Object.entries(state.inventory.idToItem).forEach(([id, item]) => {
          if ((item as Item).handle === handle) {
               matchedItems.push({ id, item: item as Item });
          }
      });
      
      console.log(`[RootReducer] Found ${matchedItems.length} existing items for handle ${handle}`);

      if (matchedItems.length > 0) {
          // 0. Ensure Photos Exist in Photos Slice (for Image Picker)
          const photosState = nextState.photos;
          let nextJanCodeToPhotos = { ...photosState.janCodeToPhotos };
          let photosUpdated = false;

          matchedItems.forEach(({ item }) => {
              if (!item.image) return;
              
              const photoKey = item.subtype ? `${item.janCode}:${item.subtype}` : item.janCode;
              const group = nextJanCodeToPhotos[photoKey] || [];
              
              // Check if image already exists in group
              const exists = group.some(p => p.baseUrl === item.image || p.productUrl === item.image);
              
              if (!exists) {
                  console.log(`[RootReducer] Backfilling photo for ${photoKey}: ${item.image}`);
                  if (!nextJanCodeToPhotos[photoKey]) nextJanCodeToPhotos[photoKey] = [];
                  
                  const syntheticPhoto = {
                      id: `synthetic-${crypto.randomUUID()}`,
                      baseUrl: item.image,
                      productUrl: item.image,
                      mimeType: "image/jpeg",
                      filename: "imported.jpg",
                      mediaMetadata: { 
                          creationTime: new Date().toISOString(), 
                          width: "0", 
                          height: "0" 
                      }
                  };
                  
                  nextJanCodeToPhotos[photoKey] = [...nextJanCodeToPhotos[photoKey], syntheticPhoto];
                  photosUpdated = true;
                  
                  // Log synthetic action
                  logger({ 
                      type: 'photos/categorize_photo (synthetic)', 
                      payload: { janCode: photoKey, photo: syntheticPhoto }, 
                      _ephemeral: true 
                  }, nextState, action._timestamp);
              }
          });

          if (photosUpdated) {
              nextState = {
                  ...nextState,
                  photos: {
                      ...photosState,
                      janCodeToPhotos: nextJanCodeToPhotos
                  }
              };
          }

          // 1. Add Variants
          const variants = matchedItems.map(({ id, item }) => {
              console.log(`[RootReducer] Mapping existing item ${id}. Image: ${item.image}`);
              const photoGroupKey = item.subtype ? `${item.janCode}:${item.subtype}` : item.janCode;
              return {
                  id: `${item.janCode}:${item.subtype || "Default"}:${crypto.randomUUID().slice(0, 8)}`,
                  itemId: id,
                  option1Value: item.subtype || "Default",
                  image: item.image, // Preserve existing photo
                  photoGroupKey, // Link to photo group
                  qty: item.qty // Initialize allocation to match current inventory
              };
          });

          const addVariantsAction = {
              ...add_variants_internal({ janCode, variants }),
              _ephemeral: true,
              timestamp: action.timestamp || action._timestamp
          };
          
          nextState = {
              ...nextState,
              listingCreation: listingCreation(nextState.listingCreation, addVariantsAction)
          };
          logger(addVariantsAction, nextState, action._timestamp);

          // 2. Sync Price & Gallery Images (Logic moved from Thunk to Reducer for Event Sourcing/Replay)
          const existingPrice = matchedItems[0].item.price;
          console.log(`[RootReducer] Existing Price from first item: ${existingPrice}`);
          
          const currentProposal = nextState.listingCreation.proposals[janCode];
          
          if (currentProposal) {
              // Sync Price if proposal doesn't have one set (or if we trust the merge target more?)
              // Generally, if we are merging into an existing listing, that listing's price is the truth.
              if (existingPrice !== undefined && currentProposal.price === undefined) {
                  console.log(`[RootReducer] Syncing price to proposal: ${existingPrice}`);
                  const syncPriceAction = {
                      type: "listingCreation/update_proposal_field",
                      payload: { janCode, field: 'price', value: existingPrice },
                      _ephemeral: true,
                      timestamp: action.timestamp || action._timestamp
                  };
                  nextState = {
                      ...nextState,
                      listingCreation: listingCreation(nextState.listingCreation, syncPriceAction)
                  };
                  logger(syncPriceAction, nextState, action._timestamp);
              }

              // Sync Gallery Images
              // Need to look up the listing from `nextState.listings`
              const existingListing = nextState.listings.handleToListing[handle];
              console.log(`[RootReducer] Looking up existing listing for handle '${handle}': ${!!existingListing}`);
              
              if (existingListing && existingListing.images && existingListing.images.length > 0) {
                  console.log(`[RootReducer] Existing listing has ${existingListing.images.length} images.`);
                  // Identify Gallery Images (Not used by variants)
                  // Use a frequency map to consume images 1-to-1. 
                  // If a URL is used by 1 variant but appears 2 times in the listing, 
                  // we only filter it out ONCE, preserving the second as a gallery image.
                  const variantImageCounts = new Map<string, number>();
                  matchedItems.forEach(m => {
                      if (m.item.image) {
                          variantImageCounts.set(m.item.image, (variantImageCounts.get(m.item.image) || 0) + 1);
                      }
                  });
                  
                  const galleryImages: any[] = [];
                  existingListing.images.forEach(img => {
                      const count = variantImageCounts.get(img.url);
                      if (count && count > 0) {
                          // Claim this listing image for the variant
                          variantImageCounts.set(img.url, count - 1);
                      } else {
                          // Not claimed (or surplus duplicate), keep as gallery image
                          galleryImages.push(img);
                      }
                  });
                  
                  console.log(`[RootReducer] Found ${galleryImages.length} gallery images (not linked to variants).`);
                  
                  if (galleryImages.length > 0) {
                      const listingOnlyImages = galleryImages.map(img => ({ ...img, isListingOnly: true }));
                      
                      // We need to set listingOnlyImages AND listingImageOrder
                      // We can construct actions for `update_proposal_field`.
                      
                      const syncImagesAction = {
                          type: "listingCreation/update_proposal_field",
                          payload: { janCode, field: 'listingOnlyImages', value: listingOnlyImages },
                          _ephemeral: true,
                          timestamp: action.timestamp || action._timestamp
                      };
                      nextState = {
                          ...nextState,
                          listingCreation: listingCreation(nextState.listingCreation, syncImagesAction)
                      };
                      logger(syncImagesAction, nextState, action._timestamp);

                      const syncOrderAction = {
                          type: "listingCreation/update_proposal_field",
                          payload: { janCode, field: 'listingImageOrder', value: existingListing.images.map(img => img.id) },
                          _ephemeral: true,
                          timestamp: action.timestamp || action._timestamp
                      };
                      nextState = {
                          ...nextState,
                          listingCreation: listingCreation(nextState.listingCreation, syncOrderAction)
                      };
                      logger(syncOrderAction, nextState, action._timestamp);
                  }
              }
          }
      }
  }

  // Listing Creation Global Config & Proposal Persistence
  // We must log ALL actions that modify the proposal state to ensure replayability
  if (action.type.startsWith("listingCreation/") && 
      !action.type.includes("approve_proposal") && // Handled by interceptor
      !action.type.includes("remove_proposal") &&  // Handled by interceptor
      !action.type.includes("complete_batch") &&   // Handled by interceptor
      !action.type.includes("start_batch") &&      // Handled elsewhere or safe? start_batch resets state.
      !action.type.includes("import_existing_variants") // Handled by interceptor
     ) {
      // Whitelist or Blacklist? 
      // Safe to log all state-modifying reducers.
      // List of reducers in slice:
      // set_drive_connection_status (ephemeral? yes)
      // set_current_step (ephemeral? yes, handled by UI state mostly, but good to log for resume)
      // add_proposals (logged by thunk usually? or component dispatch)
      
      // Explicit list of critical editing actions:
      const criticalActions = [
          "listingCreation/set_global_prompts",
          "listingCreation/update_proposal_field",
          "listingCreation/exclude_proposal_photo",
          "listingCreation/include_proposal_photo",
          "listingCreation/add_listing_only_image",
          "listingCreation/remove_listing_only_image",
          "listingCreation/update_variant_value",
          "listingCreation/update_variant_qty",
          "listingCreation/update_variant_image",
          "listingCreation/set_variant_photo_group",
          "listingCreation/split_variant",
          "listingCreation/move_variant",
          "listingCreation/merge_proposal",
          "listingCreation/reorder_variants",
          "listingCreation/add_proposals",
          "listingCreation/start_batch",
          "listingCreation/set_current_step"
      ];
      
      if (criticalActions.includes(action.type)) {
          logger(action, nextState, action._timestamp);
      }
  }

  // Approve Proposal Interceptor (Event Sourcing Logic)
  if (action.type === "listingCreation/approve_proposal") {
      // The reducer has already marked it as approved in nextState.
      // Now we must apply the side effects (Inventory/Listings updates) deterministically.
      
      const { janCode } = action.payload;
      const proposal = nextState.listingCreation.proposals[janCode];
      
      if (proposal) {
           const finalHandle = proposal.handle || generateHandle(proposal.title, proposal.janCode);
           const allProposals = nextState.listingCreation.proposals;

           // 1. Identify Siblings (Merged Group)
           // Robustly match sibling proposals by Handle OR by janCode (if handle is implicit/missing)
           const mergedProposals = Object.values(allProposals)
               .filter((p: any) => {
                   const h = p.handle || generateHandle(p.title, p.janCode);
                   if (h === finalHandle) return true;
                   if (!p.handle && !proposal.handle && p.janCode === proposal.janCode) return true;
                   return false;
               }) as any[]; // Type assertion for Proposal

           // 2. Aggregate Variants from ALL siblings for Inventory Operations
           const allVariants = mergedProposals.flatMap(p => p.variants || []);

           // 3. Inventory Splits
           const itemsToSplit = new Map<string, any[]>();
           const variantIdToItemId = new Map<string, string>();

           allVariants.forEach((v: any) => {
               if (!itemsToSplit.has(v.itemId)) itemsToSplit.set(v.itemId, []);
               itemsToSplit.get(v.itemId)?.push(v);
               variantIdToItemId.set(v.id, v.itemId);
           });

           itemsToSplit.forEach((variants, sourceId) => {
               if (variants.length > 1) {
                   const splits = variants.map((v: any) => {
                        const cleanOption = (v.option1Value || 'Default').replace(/[^a-zA-Z0-9-_]/g, '');
                        // Use Source Item's JAN for SKU generation (safe even if sourceId is item-1)
                        const sourceItem = nextState.inventory.idToItem[sourceId];
                        const baseJan = sourceItem ? sourceItem.janCode : proposal.janCode;
                        // JAN + Option (No colon)
                        let uniqueId = `${baseJan}${cleanOption}`;
                        
                        return {
                           newId: uniqueId,
                           qty: v.qty || 0,
                           subtype: v.option1Value
                        };
                   });
                   
                   const splitAction = {
                       ...split_inventory_item({ sourceId, splits }),
                       _ephemeral: true,
                       timestamp: action.timestamp || action._timestamp
                   };
                   nextState = { ...nextState, inventory: inventory(nextState.inventory, splitAction) };
                   logger(splitAction, nextState, action._timestamp);
                   
                   // Update variant references to new IDs locally
                   variants.forEach((v: any, i: number) => {
                       variantIdToItemId.set(v.id, splits[i].newId);
                   });

                   // Clear handle on source item to prevent it from appearing in the listing (ghost row)
                   if (nextState.inventory.idToItem[sourceId]) {
                       const sourceHandle = nextState.inventory.idToItem[sourceId]?.handle || "";
                       const clearHandleAction = {
                           ...update_field({ id: sourceId, field: 'handle', from: sourceHandle, to: '' }),
                           _ephemeral: true,
                           timestamp: action.timestamp || action._timestamp
                       };
                       nextState = { ...nextState, inventory: inventory(nextState.inventory, clearHandleAction) };
                       logger(clearHandleAction, nextState, action._timestamp);
                   }
               }
           });

           // 4. Inventory Updates (Price, Handle, Subtype, Image, Position)
           const processedItemIds = new Set<string>();
           
           allVariants.forEach((v: any, i: number) => {
               const fields: any[] = [];
               let currentItemId = variantIdToItemId.get(v.id) || v.itemId;
               
               // Resolve Image: Override > Photo Group > Skip
               let imageUrl = v.image;
               if (!imageUrl && v.photoGroupKey) {
                   const group = nextState.photos.janCodeToPhotos[v.photoGroupKey];
                   if (group && group.length > 0) {
                       imageUrl = group[0].baseUrl || group[0].productUrl || (group[0] as any).thumbnailLink;
                   }
               }
               
               // Find which proposal this variant belongs to (for shared fields like price/title)
               // Optimally we use the primary proposal's data for shared fields, 
               // but variant-specific data (subtype) comes from v.
               
               if (proposal.price !== undefined) fields.push({ field: 'price', value: proposal.price });
               fields.push({ field: 'handle', value: finalHandle });
               // Explicitly sync Description from Proposal Title
               fields.push({ field: 'description', value: proposal.title });
               if (imageUrl) fields.push({ field: 'image', value: imageUrl });
               fields.push({ field: 'imagePosition', value: i + 1 });
               
               // Update Subtype LAST because it triggers a rename (retype_item logic in update_field reducer),
               // which invalidates the currentItemId. All other updates must happen on the old ID first.
               if (v.option1Value) fields.push({ field: 'subtype', value: v.option1Value });

               fields.forEach(f => {
                   const itemBeforeUpdate = nextState.inventory.idToItem[currentItemId];
                   const janBeforeUpdate =
                       itemBeforeUpdate?.janCode ||
                       String(currentItemId).match(/^\d+/)?.[0] ||
                       proposal.janCode;
                   const updateAction = {
                       ...update_field({ id: currentItemId, field: f.field, from: "", to: f.value }),
                       _ephemeral: true,
                       timestamp: action.timestamp || action._timestamp
                   };
                   
                   nextState = { 
                       ...nextState, 
                       inventory: inventory(nextState.inventory, updateAction),
                       listings: listings(nextState.listings, updateAction)
                   };
                   logger(updateAction, nextState, action._timestamp);

                   // Subtype updates can re-key inventory IDs (jan+subtype). Keep local references in sync
                   // so downstream idToHandle aggregation includes renamed keys (required for subtype pills).
                   if (f.field === "subtype") {
                       const subtype = (f.value as string)?.trim() || "";
                       const baseJan = janBeforeUpdate;
                       const renamedItemId = `${baseJan}${subtype}`;
                       if (
                           renamedItemId &&
                           renamedItemId !== currentItemId &&
                           nextState.inventory.idToItem[renamedItemId]
                       ) {
                           const listingState = nextState.listings;
                           const nextIdToHandle = { ...listingState.idToHandle };
                           const mappedHandle = nextIdToHandle[currentItemId] || finalHandle;
                           nextIdToHandle[renamedItemId] = mappedHandle;
                           delete nextIdToHandle[currentItemId];

                           nextState = {
                               ...nextState,
                               listings: {
                                   ...listingState,
                                   idToHandle: nextIdToHandle,
                               },
                           };

                           currentItemId = renamedItemId;
                           variantIdToItemId.set(v.id, renamedItemId);
                       }
                   }
               });
           });

           // 4.5 Ensure ALL merged items point to the final handle in listings state
           // (Avoid stale idToHandle entries from previous handles after merges)
           const mergedItemIds = new Set<string>();
           allVariants.forEach((v: any) => {
               const currentItemId = variantIdToItemId.get(v.id) || v.itemId;
               if (currentItemId) mergedItemIds.add(currentItemId);
           });
           if (mergedItemIds.size > 0) {
               const listingState = nextState.listings;
               const nextIdToHandle = { ...listingState.idToHandle };
               const nextHandleToListing = { ...listingState.handleToListing };
               const priorHandles = new Set<string>();

               mergedItemIds.forEach((id) => {
                   const prior = nextIdToHandle[id];
                   if (prior && prior !== finalHandle) priorHandles.add(prior);
                   nextIdToHandle[id] = finalHandle;
               });

               // Clean up old handles if no longer used
               priorHandles.forEach((handle) => {
                   if (handle === finalHandle) return;
                   const stillUsed = Object.values(nextIdToHandle).includes(handle);
                   if (!stillUsed) {
                       delete nextHandleToListing[handle];
                   }
               });

               nextState = {
                   ...nextState,
                   listings: {
                       ...listingState,
                       idToHandle: nextIdToHandle,
                       handleToListing: nextHandleToListing,
                   },
               };
           }

           // 5. Create/Update Listing with Aggregated Images
           // Ensure Approved Proposal is FIRST for image ordering priority
           const primaryIndex = mergedProposals.findIndex(p => p.janCode === proposal.janCode);
           if (primaryIndex > 0) {
               mergedProposals.splice(primaryIndex, 1);
               mergedProposals.unshift(proposal);
           }

           const mergedImagesRaw = buildDraftListingImages(
               mergedProposals, 
               nextState.photos, 
               nextState.inventory
           );
           // Dedupe by URL while preserving the LAST occurrence in ordered images.
           // This keeps user-reordered listing-only duplicates authoritative.
           const seenImageUrls = new Set<string>();
           const dedupedFromRight: any[] = [];
           for (let i = mergedImagesRaw.length - 1; i >= 0; i--) {
               const img = mergedImagesRaw[i];
               const key = (img.url || img.id || "").trim();
               if (!key) {
                   dedupedFromRight.push(img);
                   continue;
               }
               if (seenImageUrls.has(key)) continue;
               seenImageUrls.add(key);
               dedupedFromRight.push(img);
           }
           const mergedImages = dedupedFromRight.reverse().map((img, idx) => ({
               ...img,
               position: idx + 1,
           }));

           const listingData = {
               handle: finalHandle,
               title: proposal.title,
               bodyHtml: proposal.bodyHtml,
               productCategory: proposal.productCategory,
               vendor: proposal.vendor,
               tags: proposal.tags,
               option1Name: proposal.option1Name || "Subtype",
               images: mergedImages,
               productType: "", 
               status: 'active' as const,
               lastUpdated: Date.now()
           };

           const existingListing = nextState.listings.handleToListing[finalHandle];
           let finalListing = listingData;
           if (existingListing) {
               finalListing = { ...existingListing, ...listingData };
           }

           const createActionLocal = {
               ...create_listing({ listing: finalListing }),
               _ephemeral: true,
               timestamp: action.timestamp || action._timestamp
           };
           nextState = { ...nextState, listings: listings(nextState.listings, createActionLocal) };
           logger(createActionLocal, nextState, action._timestamp);

           // 6. Cleanup ALL Merged Proposals
           mergedProposals.forEach(p => {
               const removeAction = {
                   ...remove_proposal({ janCode: p.janCode }),
                   _ephemeral: true,
                   timestamp: action.timestamp || action._timestamp
               };
               nextState = { ...nextState, listingCreation: listingCreation(nextState.listingCreation, removeAction) };
               logger(removeAction, nextState, action._timestamp);
           });

           // 7. Complete Batch Check
           if (nextState.listingCreation.activeBatchJans.length === 0) {
               const completeAction = {
                   ...complete_batch(),
                   _ephemeral: true,
                   timestamp: action.timestamp || action._timestamp
               };
               nextState = { ...nextState, listingCreation: listingCreation(nextState.listingCreation, completeAction) };
               logger(completeAction, nextState, action._timestamp);
           }
      }
  }

  return nextState;
};
