import { writable } from "svelte/store";

const internalUser = writable<{
  signedIn: boolean;
  uid?: string;
  email?: string;
  name?: string;
  photo?: string;
  last?: number;
}>({ signedIn: false });

let userStore = internalUser;

if (typeof window !== "undefined") {
  const win = window as any;
  if (!win.__user_store) {
    win.__user_store = internalUser;
  }
  userStore = win.__user_store;
}

export const user = userStore;
