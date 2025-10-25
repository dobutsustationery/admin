import { configureStore } from "@reduxjs/toolkit";
import type { Writable } from "svelte/store";
import { names } from "./names";
import { inventory } from "./inventory";
import { history } from "./history";

function svelteStoreEnhancer(createStoreApi: (arg0: any, arg1: any) => any) {
  return function (reducer: any, initialState: any) {
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
};

const reduxStore = configureStore({
  reducer,
  enhancers: [svelteStoreEnhancer],
  middleware: [],
  devTools: { maxAge: 100000 },
});
export type ReduxStore = typeof reduxStore;
export type GlobalState = ReturnType<typeof reduxStore.getState>;
export type SvelteStore = Writable<GlobalState>;

export const store = reduxStore as ReduxStore & SvelteStore;
