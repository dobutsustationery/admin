<script lang="ts">
  import "../app.css"; // Import global styles
  import Navigation from "$lib/components/Navigation.svelte";
  import LoadingScreen from "$lib/components/LoadingScreen.svelte";
  import Signin from "$lib/Signin.svelte"; // Static import
  import { onAuthStateChanged } from "firebase/auth";
  import { auth, firestore, googleAuthProvider } from "$lib/firebase"; // Ensure imports are correct based on file context
  import { doc, setDoc, deleteDoc, type Unsubscribe } from "firebase/firestore";
  import { onMount } from "svelte";
  import { store, inventory_synced } from "$lib/store";
  import { user } from "$lib/user-store";
  import type { AnyAction } from "$lib/store";
  import { watchBroadcastActions } from "$lib/redux-firestore";

  // Define User interface if not imported (it was let me: User)
  // Assuming User is global or imported. If not, I'll use 'any' or define it.
  // The original file used `User` type. It might be global or needing import.
  // I will assume it works as before, but if 'User' was in script context="module", I might need it.
  // Original file didn't show imports for User, likely global.

  interface User {
    signedIn: boolean;
    uid?: string;
    email?: string;
    name?: string;
    photo?: string;
    last?: number;
  }

  let me: User = { signedIn: false };
  let loadingState: "initializing" | "loading" | "ready" = "initializing";
  let navigationOpen = false;

  import { signOut } from "firebase/auth";

  function handleUserChange(firebaseUser: any) {
    if (firebaseUser && firebaseUser.email) {
      // Validate Scopes globally
      // Need to be cautious about SSR context if localStorage is accessed
      if (typeof window !== "undefined") {
        const checkScopes = async () => {
          let attempts = 0;
          const maxAttempts = 3;

          while (attempts < maxAttempts) {
            const storedTokenString = localStorage.getItem(
              "google_photos_access_token",
            );
            let hasAllScopes = false;

            if (storedTokenString) {
              try {
                const token = JSON.parse(storedTokenString);
                if (token && token.scope) {
                  // Check only for the critical API scopes
                  const criticalScopes = [
                    "https://www.googleapis.com/auth/drive.file",
                    "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
                    "https://www.googleapis.com/auth/generative-language.retriever",
                  ];
                  const missing = criticalScopes.filter(
                    (s) => !token.scope.includes(s),
                  );
                  hasAllScopes = missing.length === 0;

                  if (!hasAllScopes && attempts === maxAttempts - 1) {
                    console.warn(
                      `[Layout] Scope mismatch! Missing: ${missing.join(", ")}`,
                    );
                  }
                }
              } catch (e) {
                // Silent catch
              }
            }

            if (hasAllScopes) {
              return true; // Success!
            }

            attempts++;
            await new Promise((r) => setTimeout(r, 200)); // Wait 200ms
          }
          return false; // Failed after retries
        };

        // Don't block UI immediately, check potentially in background but quickly
        checkScopes().then((valid) => {
          if (!valid) {
            console.error(
              "[Layout] User signed in but missing required scopes or token after retries. Signing out.",
            );
            // Debug scope of failure
            const stored = localStorage.getItem("google_photos_access_token");
            console.warn("Final Token State:", stored);

            signOut(auth).then(() => {
              me = { signedIn: false };
              loadingState = "ready";
            });
          } else {
            // VALIDATION SUCCESS: Now we proceed to sign in the app
            const { uid, email, displayName, photoURL } = firebaseUser;
            me = {
              signedIn: true,
              uid,
              email,
              name: displayName || "Unknown",
              photo: photoURL || "",
              last: new Date().getTime(),
            };
            $user = me;
            loadingState = "loading"; // This will transition to "ready" when sync completes

            // Update user record
            setDoc(doc(firestore as any, "users", email), {
              uid: me.uid,
              name: me.name,
              email: me.email,
              photo: me.photo,
              activity_timestamp: new Date().getTime(),
            }).catch(console.error);

            // Start syncing if not already
            if (!unsubscribeBroadcast) {
              unsubscribeBroadcast = startBroadcastListener();
            }
          }
        });
        return; // Exit here, let the promise handle the state update
      }

      // Fallback for SSR or non-window (shouldn't happen for auth, but good practice)
      // Original logic would go here if needed, but we returned above.
    } else {
      me = { signedIn: false };
      loadingState = "ready"; // Show Sign in

      // Stop syncing
      if (unsubscribeBroadcast) {
        unsubscribeBroadcast();
        unsubscribeBroadcast = undefined;
      }
    }
  }

  // Original broadcast logic variables
  const executedActions: { [k: string]: AnyAction } = {};
  const confirmedActions: { [k: string]: AnyAction } = {};
  let unsyncedActions = 0;
  let loadedActionCount = 0;
  let unsubscribeBroadcast: Unsubscribe | undefined;

  function startBroadcastListener() {
    return watchBroadcastActions(firestore, (changes) => {
      loadedActionCount += changes.length;
      changes.forEach((change) => {
        const action = change.doc.data() as AnyAction;
        const id = change.doc.id;
        if (executedActions[id] === undefined) {
          executedActions[id] = action;
          if (action.type === "retype_item") {
            const itemKey = action.payload.itemKey;
            const newItemKey = action.payload.janCode + action.payload.subtype;
            if (itemKey == newItemKey) {
              console.error("bad retype item detected", id);
              deleteDoc(change.doc.ref);
            }
          }
          store.dispatch(action);
        }
        if (action.timestamp !== null) {
          confirmedActions[id] = action;
        }
        unsyncedActions =
          Object.keys(executedActions).length -
          Object.keys(confirmedActions).length;
      });
      store.dispatch(inventory_synced());

      // If we are signed in and receiving actions, we are ready
      if (me.signedIn) {
        loadingState = "ready";
      }
    });
  }

  onMount(() => {
    // Auth Listener
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      handleUserChange(u);
    });

    // Console suppression for tests
    const originalConsoleError = console.error;
    console.error = (...args: any[]) => {
      if (
        String(args[0]).includes("Component auth has not been registered yet")
      )
        return;
      originalConsoleError.apply(console, args);
    };

    // Fallback sync
    setTimeout(() => {
      store.dispatch(inventory_synced());
      if (me.signedIn) loadingState = "ready";
    }, 10000);

    return () => {
      unsubscribe();
      if (unsubscribeBroadcast) unsubscribeBroadcast();
    };
  });
</script>

{#if me.signedIn}
  <div class="app-shell">
    <Navigation {unsyncedActions} bind:isOpen={navigationOpen} />

    <main class="main-content" class:nav-open={navigationOpen}>
      <slot />
    </main>
  </div>

  {#if loadingState !== "ready"}
    <LoadingScreen
      status={loadingState}
      progress={0}
      message="Syncing data..."
    />
  {/if}
{:else if loadingState === "initializing"}
  <LoadingScreen
    status="initializing"
    message="Initializing authentication..."
  />
{:else}
  <div class="signin-container">
    <h1>Dobutsu Admin</h1>
    <Signin
      {auth}
      {googleAuthProvider}
      on:user_changed={(e) =>
        handleUserChange(
          e.detail.signedIn
            ? { email: e.detail.email, uid: e.detail.uid }
            : null,
        )}
    />
  </div>
{/if}

<style>
  .app-shell {
    display: flex;
    min-height: 100vh;
  }

  .main-content {
    flex: 1;
    padding: 1rem;
    padding-left: 250px; /* Width of nav */
    transition: padding-left 0.3s ease-in-out;
  }

  /* Mobile: Nav is hidden/overlay, so no padding */
  @media (max-width: 768px) {
    .main-content {
      padding-left: 0;
    }
  }

  .signin-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100vh;
  }
</style>
