import { configureStore, combineReducers } from "@reduxjs/toolkit";
import { writable } from "svelte/store";
import type { Writable } from "svelte/store";
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
import { photos, categorize_photo } from "./photos-slice";
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
import { listings, add_listing_image, create_listing, delete_listing } from "./listings-slice";
import listingCreation, { 
  add_proposals, 
  start_batch, 
  generate_descriptions_for_batch,
  generate_proposals,
  set_drive_connection_status,
  approve_proposal_thunk,
  add_variants_internal,
  remove_proposal,
  complete_batch
} from "./listing-creation-slice";
import { saveSnapshot, loadSnapshot } from "./action-cache";
import { devtoolsMiddleware, logAction } from "./devtools-middleware";
import { driveSyncMiddleware } from "./drive-sync-middleware";
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
};
const combinedReducer = combineReducers(reducerObject);

// Helper to map Order Import Item to Inventory Item
const mapOrderToInventory = (importItem: any): Item => {
  // Note: This helper might be redundant if computeOrderImportBatch constructs full items.
  // But computeOrderImportBatch returns constructed items. We map them to BulkImportItem.
  return {
    janCode: importItem.janCode,
    subtype: "", // Default
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

// Removed duplicate import

// ...

// Root reducer to handle full state hydration and Event Sourcing Orchestration
export const rootReducer = (state: any, action: any) => {
  if (action.type === "HYDRATE") {
    return { ...state, ...action.payload };
  }

  // 1. Standard Reducer Execution
  let nextState = combinedReducer(state, action);

  // 2. Interception & Composition

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
        timestamp: action._timestamp, // Uses propagated timestamp
      };

      // Apply to Inventory
      nextState = {
        ...nextState,
        inventory: inventory(nextState.inventory, internalAction),
      };
      logAction(internalAction, nextState, action._timestamp); // LOG SUB-ACTION

      // Apply to Listings
      nextState = {
        ...nextState,
        listings: listings(nextState.listings, internalAction),
      };
      // Listings sub-log
      logAction({ ...internalAction, type: 'bulk_import_items (listings)' }, nextState, action._timestamp); 
    }

    // Mark Items Done in Order Import Slice
    if (indices.length > 0) {
      const markAction = markOrderDone({ indices });
      nextState = {
        ...nextState,
        orderImport: orderImport(nextState.orderImport, markAction),
      };
      logAction(markAction, nextState, action._timestamp); // LOG SUB-ACTION
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
        timestamp: action._timestamp,
      };

      nextState = {
        ...nextState,
        inventory: inventory(nextState.inventory, internalAction),
        listings: listings(nextState.listings, internalAction),
      };
      logAction(internalAction, nextState, action._timestamp); // LOG SUB-ACTION
    }

    if (listingUpdates && listingUpdates.length > 0) {
      let nextListings = nextState.listings;
      listingUpdates.forEach((u) => {
        if (u.type === "add_image") {
          const internalAction = {
            ...add_listing_image({ handle: u.handle, image: u.image }),
            _ephemeral: true,
            timestamp: action._timestamp,
          };
          nextListings = listings(nextListings, internalAction);
          // We must update nextState.listings locally to pass to next iteration
          // but we also want to capture the full state for the log.
          const intermediateState = { ...nextState, listings: nextListings };
          logAction(internalAction, intermediateState, action._timestamp); // LOG SUB-ACTION
        } else if (u.type === "create_listing") {
          const internalAction = {
            ...create_listing({ listing: u.listing }),
            _ephemeral: true,
            timestamp: action._timestamp,
          };
          nextListings = listings(nextListings, internalAction);
          const intermediateState = { ...nextState, listings: nextListings };
          logAction(internalAction, intermediateState, action._timestamp); // LOG SUB-ACTION
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
      logAction(markAction, nextState, action._timestamp); // LOG SUB-ACTION
    }
  }

  // Import Existing Variants (Listing Creation)
  if (action.type === "listingCreation/import_existing_variants" && state.inventory) {
      const { janCode, handle } = action.payload;
      
      const matchedItems: { id: string, item: Item }[] = [];
      Object.entries(state.inventory.idToItem).forEach(([id, item]) => {
          if ((item as Item).handle === handle) {
               matchedItems.push({ id, item: item as Item });
          }
      });

      if (matchedItems.length > 0) {
          const variants = matchedItems.map(({ id, item }) => ({
              id: `${item.janCode}:${item.subtype || "Default"}:${crypto.randomUUID().slice(0, 8)}`,
              itemId: id,
              option1Value: item.subtype || "Default"
          }));

          const internalAction = {
              ...add_variants_internal({ janCode, variants }),
              _ephemeral: true,
              timestamp: action._timestamp
          };
          
          nextState = {
              ...nextState,
              listingCreation: listingCreation(nextState.listingCreation, internalAction)
          };
          logAction(internalAction, nextState, action._timestamp);
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
          logAction(action, nextState, action._timestamp);
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
                       timestamp: action._timestamp
                   };
                   nextState = { ...nextState, inventory: inventory(nextState.inventory, splitAction) };
                   logAction(splitAction, nextState, action._timestamp);
                   
                   // Update variant references to new IDs locally
                   variants.forEach((v: any, i: number) => {
                       variantIdToItemId.set(v.id, splits[i].newId);
                   });
               }
           });

           // 4. Inventory Updates (Price, Handle, Subtype, Image, Position)
           const processedItemIds = new Set<string>();
           
           allVariants.forEach((v: any, i: number) => {
               const fields: any[] = [];
               const currentItemId = variantIdToItemId.get(v.id) || v.itemId;
               
               // Resolve Image: Override > Photo Group > Skip
               let imageUrl = v.image;
               if (!imageUrl && v.photoGroupKey) {
                   const group = nextState.photos.janCodeToPhotos[v.photoGroupKey];
                   if (group && group.length > 0) {
                       imageUrl = group[0].baseUrl || group[0].productUrl || group[0].thumbnailLink;
                   }
               }
               
               // Find which proposal this variant belongs to (for shared fields like price/title)
               // Optimally we use the primary proposal's data for shared fields, 
               // but variant-specific data (subtype) comes from v.
               
               if (proposal.price !== undefined) fields.push({ field: 'price', value: proposal.price });
               fields.push({ field: 'handle', value: finalHandle });
               if (v.option1Value) fields.push({ field: 'subtype', value: v.option1Value });
               if (imageUrl) fields.push({ field: 'image', value: imageUrl });
               fields.push({ field: 'imagePosition', value: i + 1 });

               fields.forEach(f => {
                   const updateAction = {
                       ...update_field({ id: currentItemId, field: f.field, from: "", to: f.value }),
                       _ephemeral: true,
                       timestamp: action._timestamp
                   };
                   
                   nextState = { 
                       ...nextState, 
                       inventory: inventory(nextState.inventory, updateAction),
                       listings: listings(nextState.listings, updateAction)
                   };
                   logAction(updateAction, nextState, action._timestamp);
               });
           });

           // 5. Create/Update Listing with Aggregated Images
           // Ensure Approved Proposal is FIRST for image ordering priority
           const primaryIndex = mergedProposals.findIndex(p => p.janCode === proposal.janCode);
           if (primaryIndex > 0) {
               mergedProposals.splice(primaryIndex, 1);
               mergedProposals.unshift(proposal);
           }

           const mergedImages = buildDraftListingImages(
               mergedProposals, 
               nextState.photos, 
               nextState.inventory
           );

           const listingData = {
               handle: finalHandle,
               title: proposal.title,
               bodyHtml: proposal.bodyHtml,
               productCategory: proposal.productCategory,
               vendor: proposal.vendor,
               tags: proposal.tags,
               option1Name: proposal.option1Name,
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
               timestamp: action._timestamp
           };
           nextState = { ...nextState, listings: listings(nextState.listings, createActionLocal) };
           logAction(createActionLocal, nextState, action._timestamp);

           // 6. Cleanup ALL Merged Proposals
           mergedProposals.forEach(p => {
               const removeAction = {
                   ...remove_proposal({ janCode: p.janCode }),
                   _ephemeral: true,
                   timestamp: action._timestamp
               };
               nextState = { ...nextState, listingCreation: listingCreation(nextState.listingCreation, removeAction) };
               logAction(removeAction, nextState, action._timestamp);
           });

           // 7. Complete Batch Check
           if (nextState.listingCreation.activeBatchJans.length === 0) {
               const completeAction = {
                   ...complete_batch(),
                   _ephemeral: true,
                   timestamp: action._timestamp
               };
               nextState = { ...nextState, listingCreation: listingCreation(nextState.listingCreation, completeAction) };
               logAction(completeAction, nextState, action._timestamp);
           }
      }
  }

  return nextState;
};

// Persistence Logic
export interface SnapshotMetadata {
  id: string;
  timestamp: any;
}

export let snapshotMetadata: SnapshotMetadata | null = null;
let saveTimeout: any = null;

export async function hydrate() {
  if (typeof window === "undefined") return;
  try {
    const loaded = await loadSnapshot();
    if (loaded && loaded.state) {
      store.dispatch({ type: "HYDRATE", payload: loaded.state });
      snapshotMetadata = loaded.lastAction || null;
      console.log("[Store] Hydrated state from IDB", snapshotMetadata);
    }
  } catch (e) {
    console.error("Hydration failed", e);
  }
}

function triggerSave(state: any, lastAction: SnapshotMetadata | null) {
  // Sanitize state before save (clear ephemeral UI flags)
  const safeState = { ...state };
  // Note: We used to clear listingCreation flags here, but activeBatchId IS critical session state
  // and lastCompletedBatchId should persist until acknowledged to ensure the user sees the reward.
  
  // Save via IDB (async)
  saveSnapshot(safeState, lastAction).catch((e) => console.warn("Save failed", e));
}

const persistenceMiddleware =
  (storeAPI: any) => (next: any) => (action: any) => {
    const result = next(action);

    // Check if this action has broadcast metadata (id + timestamp)
    // We only care about tracking the "cursor" of processed actions.
    if (action && action.id && action.timestamp) {
      snapshotMetadata = { id: action.id, timestamp: action.timestamp };
      
      // Debounce save
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        triggerSave(storeAPI.getState(), snapshotMetadata);
      }, 100);
    } 
    // ALSO trigger save for local 'photos/' actions to persist UI state (checkboxes, queue)
    // We do NOT update snapshotMetadata because these are local-only changes, 
    // and we want to resume event fetching from the last real remote event.
    else if (action.type.startsWith('photos/')) {
       if (saveTimeout) clearTimeout(saveTimeout);
       saveTimeout = setTimeout(() => {
         triggerSave(storeAPI.getState(), snapshotMetadata);
       }, 500); // Slightly longer debounce for local UI thrashing
    }

    return result;
  };

// (Import is already handled by previous edit? No, I added it to the top in the previous edit's replacement content but I used StartLine 79 which is far below imports.
// Wait, StartLine 79 was 'export const rootReducer'. I need to make sure the IMPORT was actually added.)
// The replace_file_content tool REPLACES the content. My previous call updated the `rootReducer` body.
// But I also provided `import { devtoolsMiddleware, logAction } ...` in the ReplacementContent, seemingly expecting it to be placed at the top? 
// Ah, `TargetContent` started at `// Root reducer...`. If I included the import line in `ReplacementContent` BEFORE `// Root reducer`, it would insert it there.
// BUT `devtoolsMiddleware` import is at line 258 in original file.
// I should check if the file is valid. I suspect I might have duplicated the import or placed it weirdly.
// Let's explicitly fix the import at line 258.

// ... (previous code)

const reduxStore = configureStore({
  reducer: rootReducer,
  // No preloadedState, we hydrate async
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: false, // We handle map/Date serialization manually
      immutableCheck: false, // Disable for performance with large state
    })
    .concat(devtoolsMiddleware) // Add our native Svelte devtools middleware
    .concat(persistenceMiddleware)
    .concat(driveSyncMiddleware as any), // Type cast if needed for strict Middleware constraints
  devTools: {
    // Keep standard DevTools enabled but with sanitizers as fallback
    name: "Dobutsu Admin",
    trace: true,
    latency: 1000,
    maxAge: 50, // Keep safe mode for extension to avoid crashing it
    actionSanitizer: (action: any) => {
      if (action.type === "HYDRATE") {
        return { ...action, payload: "<<HYDRATION_PAYLOAD_OMITTED>>" };
      }
      return action;
    },
    stateSanitizer: (state: any) => {
       // Always sanitize for the extension to prevent crashes
       const result = { ...state };
       if (result.inventory && result.inventory.idToItem) {
           const keys = Object.keys(result.inventory.idToItem);
           if (keys.length > 100) {
               result.inventory = {
                   ...result.inventory,
                   idToItem: `<<LARGE_INVENTORY_MAP_OMITTED_FOR_DEVTOOLS (${keys.length} items)>>`
               };
           }
       }
       return result;
    }
  },
});

if (typeof window !== "undefined") {
  console.log(
    "[Redux] Store initialized. Extension available:",
    !!(window as any).__REDUX_DEVTOOLS_EXTENSION__,
  );
}

export type ReduxStore = typeof reduxStore;
export type GlobalState = ReturnType<typeof reduxStore.getState>;
export type SvelteStore = Writable<GlobalState>;

const svelteStore = {
  ...reduxStore,
  subscribe(fn: (value: GlobalState) => void) {
    fn(reduxStore.getState());
    return reduxStore.subscribe(() => {
      fn(reduxStore.getState());
    });
  },
};

export const store = svelteStore as ReduxStore & SvelteStore;

if (typeof window !== "undefined") {
  // Expose store and actions for E2E testing in local environment
  // This allows tests to manipulate state without importing modules (which fails in vite preview)
  if (import.meta.env.VITE_FIREBASE_ENV === 'local' || import.meta.env.MODE === 'emulator') {
      (window as any).testHelpers = {
          store,
          actions: {
              bulk_import_items,
              create_listing,
              delete_listing,
              add_proposals,
              categorize_photo,
              start_batch,
              generate_descriptions_for_batch,
              generate_proposals,
              set_drive_connection_status,
              approve_proposal_thunk
          }
      };
      console.log("[Redux] Exposed window.testHelpers for E2E testing");
  }
}

export { user } from "./user-store";

export { inventory_synced } from "./inventory";
export type { AnyAction } from "@reduxjs/toolkit";
