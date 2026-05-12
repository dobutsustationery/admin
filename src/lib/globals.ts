// Historically a separate writable<User>() with no initial value; callers
// dereferenced `$user.uid` and crashed before the layout's signin event
// fired (or never, because this store was never wired into Firebase Auth).
//
// Re-export the canonical store from `$lib/user-store` so every consumer
// reads the same signed-in user that the layout populates via
// onAuthStateChanged.  The user-store starts at `{signedIn: false}`, so
// `$user` is always defined; consumers should check `$user?.signedIn` or
// `$user?.uid` before acting.
export { user } from "$lib/user-store";
