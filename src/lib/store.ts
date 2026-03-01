import { configureStore } from "@reduxjs/toolkit";
import { writable } from "svelte/store";
import type { Writable } from "svelte/store";
import { rootReducer } from "./root-reducer";
import { saveSnapshot, loadSnapshot } from "./action-cache";
import { devtoolsMiddleware } from "./devtools-middleware";
import { driveSyncMiddleware } from "./drive-sync-middleware";
import { bulk_import_items } from "./inventory";
import { create_listing, delete_listing } from "./listings-slice";
import { categorize_photo, register_media_items } from "./photos-slice";
import {
  add_proposals,
  start_batch,
  generate_descriptions_for_batch,
  generate_proposals,
  set_drive_connection_status,
  approve_proposal_thunk,
  set_current_step,
  add_variant_requested,
  remove_variant_requested,
} from "./listing-creation-slice";

// Persistence Logic
export interface SnapshotMetadata {
  id: string;
  timestamp: any;
}

export let snapshotMetadata: SnapshotMetadata | null = null;
let saveTimeout: any = null;

export async function hydrate() {
  if (typeof window === "undefined") return;
  // Live E2E tests set this flag via addInitScript (before any page JS runs)
  // to prevent hydrating stale IndexedDB state from a previous test in the
  // same browser context.  The flag eliminates a race between deleteDatabase()
  // and loadSnapshot() that caused sub-pixel layout shifts and screenshot diffs.
  if ((window as any).__SKIP_IDB_HYDRATION__) return;
  try {
    const loaded = await loadSnapshot();
    if (loaded && loaded.state) {
      store.dispatch({ type: "HYDRATE", payload: loaded.state });

      // Schema Validation:
      // If the reducer discarded the hydration due to a schema mismatch,
      // the store's schemaVersion will be CURRENT_SCHEMA_VERSION (from reducer default),
      // while the payload might have had an old version (or none).
      // We check if the store state actually matches the payload we just sent.
      const state = store.getState();
      if (state.schemaVersion === (loaded.state as any).schemaVersion) {
        snapshotMetadata = loaded.lastAction || null;
        console.log("[Store] Hydrated state from IDB", snapshotMetadata);
      } else {
        console.warn(
          "[Store] Hydration rejected by reducer (schema mismatch). Replay will start from beginning.",
        );
        snapshotMetadata = null;
      }
    }
  } catch (e) {
    console.error("Hydration failed", e);
  }
}

function triggerSave(state: any, lastAction: SnapshotMetadata | null) {
  const safeState = { ...state };
  saveSnapshot(safeState, lastAction).catch((e) =>
    console.warn("Save failed", e),
  );
}

const persistenceMiddleware =
  (storeAPI: any) => (next: any) => (action: any) => {
    const result = next(action);

    if (action && action.id && action.timestamp) {
      snapshotMetadata = { id: action.id, timestamp: action.timestamp };

      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        triggerSave(storeAPI.getState(), snapshotMetadata);
      }, 100);
    } else if (action.type.startsWith("photos/")) {
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        triggerSave(storeAPI.getState(), snapshotMetadata);
      }, 500);
    }

    return result;
  };

const reduxStore = configureStore({
  reducer: rootReducer,
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: false,
      immutableCheck: false,
    })
      .concat(devtoolsMiddleware)
      .concat(persistenceMiddleware)
      .concat(driveSyncMiddleware as any),
  devTools: {
    name: "Dobutsu Admin",
    trace: true,
    latency: 1000,
    maxAge: 50,
    actionSanitizer: (action: any) => {
      if (action.type === "HYDRATE") {
        return { ...action, payload: "<<HYDRATION_PAYLOAD_OMITTED>>" };
      }
      return action;
    },
    stateSanitizer: (state: any) => {
      const result = { ...state };
      if (result.inventory && result.inventory.idToItem) {
        const keys = Object.keys(result.inventory.idToItem);
        if (keys.length > 100) {
          result.inventory = {
            ...result.inventory,
            idToItem: `<<LARGE_INVENTORY_MAP_OMITTED_FOR_DEVTOOLS (${keys.length} items)>>`,
          };
        }
      }
      return result;
    },
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
  if (
    import.meta.env.VITE_FIREBASE_ENV === "local" ||
    import.meta.env.MODE === "emulator"
  ) {
    (window as any).testHelpers = {
      store,
      actions: {
        bulk_import_items,
        create_listing,
        delete_listing,
        add_proposals,
        categorize_photo,
        register_media_items,
        start_batch,
        generate_descriptions_for_batch,
        generate_proposals,
        set_drive_connection_status,
        approve_proposal_thunk,
        set_current_step,
        add_variant_requested,
        remove_variant_requested,
      },
    };
    console.log("[Redux] Exposed window.testHelpers for E2E testing");
  }
}

export { user } from "./user-store";
export { inventory_synced } from "./inventory";
export type { AnyAction } from "@reduxjs/toolkit";
