import { writable } from "svelte/store";
import type { User } from "$lib/Signin.svelte";

export const user = writable<User>();
