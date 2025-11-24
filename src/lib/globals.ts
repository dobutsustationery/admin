import type { User } from "$lib/Signin.svelte";
import { writable } from "svelte/store";

export const user = writable<User>();
