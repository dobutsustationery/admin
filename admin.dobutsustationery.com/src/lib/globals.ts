import type { SignedInUser } from "@ourway/svelte-firebase-auth";
import { writable } from "svelte/store";

export const user = writable<SignedInUser>();