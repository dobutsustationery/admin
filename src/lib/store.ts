import { configureStore } from "@reduxjs/toolkit";
import { type Writable, writable } from "svelte/store";
import { history } from "./history";
import { inventory } from "./inventory";
import { names } from "./names";

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

export const user = writable<{
  signedIn: boolean;
  uid?: string;
  email?: string;
  name?: string;
  photo?: string;
  last?: number;
}>({ signedIn: false });

export { inventory_synced } from "./inventory";
export type { AnyAction } from "@reduxjs/toolkit";
