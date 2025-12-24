import { configureStore, combineReducers } from "@reduxjs/toolkit";
import { writable } from "svelte/store";
import type { Writable } from "svelte/store";
import { history } from "./history";
import { inventory, bulk_import_items, type BulkImportItem, type Item } from "./inventory";
import { names } from "./names";
import { photos } from "./photos-slice";
import { orderImport, computeOrderImportBatch, mark_items_done as markOrderDone } from "./order-import-slice";
import { shopifyImport, computeShopifyImportBatch, mark_items_done as markShopifyDone } from "./shopify-import-slice";
import { listings, add_listing_image, create_listing } from "./listings-slice";
import { saveSnapshot, loadSnapshot } from "./action-cache";

function svelteStoreEnhancer(createStoreApi: (arg0: any, arg1: any) => any) {
  return (reducer: any, initialState: any) => {
    const reduxStore = createStoreApi(reducer, initialState);
    return {
      ...reduxStore,
      subscribe(fn: (arg0: ReturnType<typeof reduxStore.getState>) => void) {
        fn(reduxStore.getState());

        return reduxStore.subscribe(() => {
          fn(reduxStore.getState());
        });
      },
    };
  };
}

const reducerObject = {
  names,
  inventory,
  history,
  photos,
  orderImport,
  shopifyImport,
  listings,
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
        countryOfOrigin: importItem.countryOfOrigin
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
        ...importItem 
    } as Item;
};

// Root reducer to handle full state hydration and Event Sourcing Orchestration
export const rootReducer = (state: any, action: any) => {
  if (action.type === 'HYDRATE') {
    return { ...state, ...action.payload };
  }

  // 1. Standard Reducer Execution
  let nextState = combinedReducer(state, action);

  // 2. Interception & Composition
  
  // Order Import Batch
  if (action.type === 'orderImport/import_batch' && state.orderImport) {
      console.log("[RootReducer] Intercepting Order Import Batch", action.payload);
      
      const { updates, indices } = computeOrderImportBatch(
          state.orderImport, 
          state.inventory.idToItem, 
          action.payload.filter
      );
      
      // Map updates to BulkImportItem (if compute returns raw objects)
      // Actually computeOrderImportBatch returns objects with { type, id, item }.
      // So they match BulkImportItem structure directly.
      const bulkUpdates: BulkImportItem[] = updates.map(u => ({
          type: u.type,
          id: u.id,
          item: u.type === 'new' ? mapOrderToInventory(u.item) : u.item // Map 'new' items to ensure defaults
      }));

      if (bulkUpdates.length > 0) {
          const internalAction = {
              ...bulk_import_items({ items: bulkUpdates }),
              _ephemeral: true,
              timestamp: action.timestamp // Inherit timestamp
          };

          // Apply to Inventory
          nextState = {
              ...nextState,
              inventory: inventory(nextState.inventory, internalAction)
          };
          // Apply to Listings
           nextState = {
              ...nextState,
              listings: listings(nextState.listings, internalAction)
          };
      }
      
      // Mark Items Done in Order Import Slice
      if (indices.length > 0) {
          const markAction = markOrderDone({ indices });
          nextState = {
              ...nextState,
              orderImport: orderImport(nextState.orderImport, markAction)
          };
      }
  }

  // Shopify Import Batch
  if (action.type === 'shopifyImport/import_batch' && state.shopifyImport) {
      const { filter, options } = action.payload; // Extract options
      console.log(`[RootReducer] Intercepting Shopify Import Batch { filter: '${filter}' }`);
      
      const { updates, listingUpdates, indices } = computeShopifyImportBatch(
          state.shopifyImport,
          state.inventory.idToItem,
          state.listings.handleToListing,
          filter,
          options // Pass options
      );
      
      const bulkUpdates: BulkImportItem[] = updates.map(u => ({
          type: u.type,
          id: u.id,
          item: u.type === 'new' ? mapShopifyToInventory(u.item) : u.item
      }));

      if (bulkUpdates.length > 0) {
          const internalAction = {
              ...bulk_import_items({ items: bulkUpdates }),
              _ephemeral: true,
              timestamp: action.timestamp
          };

          nextState = {
              ...nextState,
              inventory: inventory(nextState.inventory, internalAction),
              listings: listings(nextState.listings, internalAction)
          };
      }

      if (listingUpdates && listingUpdates.length > 0) {
          let nextListings = nextState.listings;
          listingUpdates.forEach(u => {
               if (u.type === 'add_image') {
                   const internalAction = {
                       ...add_listing_image({ handle: u.handle, image: u.image }),
                       _ephemeral: true,
                       timestamp: action.timestamp
                   };
                   nextListings = listings(nextListings, internalAction);
               } else if (u.type === 'create_listing') {
                   const internalAction = {
                       ...create_listing({ listing: u.listing }),
                       _ephemeral: true,
                       timestamp: action.timestamp
                   };
                   nextListings = listings(nextListings, internalAction);
               }
          });
          nextState = { ...nextState, listings: nextListings };
      }
      
      if (indices.length > 0) {
          const markAction = markShopifyDone({ indices });
          nextState = {
              ...nextState,
              shopifyImport: shopifyImport(nextState.shopifyImport, markAction)
          };
      }
  }

  return nextState;
};

const devTools =
  typeof window !== "undefined" && (window as any).__REDUX_DEVTOOLS_EXTENSION__
    ? (window as any).__REDUX_DEVTOOLS_EXTENSION__()
    : (f: any) => f;

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
             store.dispatch({ type: 'HYDRATE', payload: loaded.state });
             snapshotMetadata = loaded.lastAction || null;
             console.log("[Store] Hydrated state from IDB", snapshotMetadata);
        }
    } catch (e) {
        console.error("Hydration failed", e);
    }
}

function triggerSave(state: any, lastAction: SnapshotMetadata | null) {
     // Save via IDB (async)
     saveSnapshot(state, lastAction).catch(e => console.warn("Save failed", e));
}

const persistenceMiddleware = (storeAPI: any) => (next: any) => (action: any) => {
  const result = next(action);
  
  // Check if this action has broadcast metadata (id + timestamp)
  // We only care about tracking the "cursor" of processed actions.
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
  
  return result;
};

const reduxStore = configureStore({
  reducer: rootReducer,
  // No preloadedState, we hydrate async
  enhancers: [svelteStoreEnhancer, devTools],
  middleware: (getDefaultMiddleware) => 
    getDefaultMiddleware({
      serializableCheck: false, // We handle map/Date serialization manually
    }).concat(persistenceMiddleware),
  devTools: false,
});
export type ReduxStore = typeof reduxStore;

export type GlobalState = ReturnType<typeof reduxStore.getState>;
export type SvelteStore = Writable<GlobalState>;

export const store = reduxStore as ReduxStore & SvelteStore;

export { user } from "./user-store";

export { inventory_synced } from "./inventory";
export type { AnyAction } from "@reduxjs/toolkit";
