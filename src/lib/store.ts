import { configureStore, combineReducers } from "@reduxjs/toolkit";
import { writable } from "svelte/store";
import type { Writable } from "svelte/store";
import { history } from "./history";
import {
  inventory,
  bulk_import_items,
  type BulkImportItem,
  type Item,
} from "./inventory";
import { names } from "./names";
import { photos } from "./photos-slice";
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
import { listings, add_listing_image, create_listing } from "./listings-slice";
import { saveSnapshot, loadSnapshot } from "./action-cache";
import { devtoolsMiddleware, logAction } from "./devtools-middleware";

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
  // Save via IDB (async)
  saveSnapshot(state, lastAction).catch((e) => console.warn("Save failed", e));
}

const persistenceMiddleware =
  (storeAPI: any) => (next: any) => (action: any) => {
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
    .concat(persistenceMiddleware),
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

export { user } from "./user-store";

export { inventory_synced } from "./inventory";
export type { AnyAction } from "@reduxjs/toolkit";
