import { configureStore, combineReducers } from "@reduxjs/toolkit";
import { writable } from "svelte/store";
import type { Writable } from "svelte/store";
import { history } from "./history";
import { inventory } from "./inventory";
import { names } from "./names";
import { photos } from "./photos-slice";
import { orderImport } from "./order-import-slice";
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
};
const combinedReducer = combineReducers(reducerObject);

// Root reducer to handle full state hydration
const rootReducer = (state: any, action: any) => {
  if (action.type === 'HYDRATE') {
    // Merge payload into current state to preserve new slices not present in old snapshots
    return { ...state, ...action.payload };
  }
  return combinedReducer(state, action);
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
