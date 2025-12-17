import { configureStore } from "@reduxjs/toolkit";
import { writable } from "svelte/store";
import type { Writable } from "svelte/store";
import { history } from "./history";
import { inventory } from "./inventory";
import { names } from "./names";
import { photos } from "./photos-slice";

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

const reducer = {
  names,
  inventory,
  history,
  photos,
};

const devTools =
  typeof window !== "undefined" && (window as any).__REDUX_DEVTOOLS_EXTENSION__
    ? (window as any).__REDUX_DEVTOOLS_EXTENSION__()
    : (f: any) => f;

const reduxStore = configureStore({
  reducer,
  enhancers: [svelteStoreEnhancer, devTools],
  middleware: [],
  devTools: false,
});
export type ReduxStore = typeof reduxStore;
export type GlobalState = ReturnType<typeof reduxStore.getState>;
export type SvelteStore = Writable<GlobalState>;

export const store = reduxStore as ReduxStore & SvelteStore;

export { user } from "./user-store";

export { inventory_synced } from "./inventory";
export type { AnyAction } from "@reduxjs/toolkit";
