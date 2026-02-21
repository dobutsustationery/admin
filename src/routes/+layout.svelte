<script lang="ts">
  import "../app.css"; // Import global styles
  import Navigation from "$lib/components/Navigation.svelte";
  import PhotoUploadManager from "$lib/components/PhotoUploadManager.svelte";
  import LoadingScreen from "$lib/components/LoadingScreen.svelte";
  import Signin from "$lib/Signin.svelte"; // Static import
  import { onAuthStateChanged, signOut } from "firebase/auth";
  import { auth, firestore, googleAuthProvider } from "$lib/firebase"; // Ensure imports are correct based on file context
  import {
    collection,
    deleteDoc,
    doc,
    limit,
    onSnapshot,
    orderBy,
    query,
    setDoc,
    type Unsubscribe,
  } from "firebase/firestore";
  import { onMount } from "svelte";
  import {
    store,
    inventory_synced,
    snapshotMetadata,
    hydrate,
  } from "$lib/store";
  import { user } from "$lib/user-store";
  import type { AnyAction } from "$lib/store";
  import { watchBroadcastActions } from "$lib/redux-firestore";
  import {
    replace_shopify_sync_events,
    reset_shopify_sync_state,
  } from "$lib/shopify-sync-slice";
  import type { ShopifySyncEvent } from "$lib/shopify-sync-model";

  // Start hydration immediately
  const hydrationPromise =
    typeof window !== "undefined" ? hydrate() : Promise.resolve();

  // Define User interface
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

  function handleUserChange(firebaseUser: any) {
    if (firebaseUser && firebaseUser.email) {
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
                  const scopeStr = token.scope;
                  // Strict Check: Must have Picker AND (Drive Readonly OR Drive File OR Drive Full)
                  const hasPicker =
                    scopeStr.includes("photospicker.mediaitems.readonly") ||
                    scopeStr.includes("cloud-platform");
                  const hasDrive =
                    scopeStr.includes("drive.readonly") ||
                    scopeStr.includes("drive.file") ||
                    (scopeStr.includes("/drive") &&
                      !scopeStr.includes("drive.appdata"));

                  hasAllScopes = hasPicker && hasDrive;

                  if (!hasAllScopes && attempts === maxAttempts - 1) {
                    console.warn(
                      `[Layout] Scope mismatch! Picker: ${hasPicker}, Drive: ${hasDrive}. Scopes: ${scopeStr}`,
                    );
                    // Force invalidate here too so the UI updates to "Not Connected"
                    localStorage.removeItem("google_photos_access_token");
                  }
                }
              } catch (e) {}
            }

            if (hasAllScopes) {
              return true;
            }

            attempts++;
            await new Promise((r) => setTimeout(r, 200));
          }
          return false;
        };

        checkScopes().then(async (valid) => {
          if (!valid) {
            console.warn(
              "[Layout] User signed in but missing required scopes or token. Functionality may be limited until 'Switch Account' is used.",
            );
            // Do NOT sign out. Allow user to enter and fix connection.
            // Proceed to set user state below.
          }

          // Proceed regardless of validity (allow fixing in UI)
          if (true) {
            const { uid, email, displayName, photoURL } = firebaseUser;
            me = {
              signedIn: true,
              uid,
              email,
              name: displayName || "Unknown",
              photo: photoURL || "",
              last: new Date().getTime(),
            };

            // Wait for hydration
            await hydrationPromise;

            $user = me;
            loadingState = "loading";

            if (uid) {
              // Only write if we have a UID (always true here)
              setDoc(doc(firestore as any, "users", email), {
                uid: me.uid,
                name: me.name,
                email: me.email,
                photo: me.photo,
                activity_timestamp: new Date().getTime(),
              }).catch(console.error);
            }

            if (!unsubscribeBroadcast) {
              unsubscribeBroadcast = startBroadcastListener();
            }
            if (!unsubscribeShopifySync) {
              unsubscribeShopifySync = startShopifySyncListener();
            }
          }
        });
        return;
      }
    } else {
      me = { signedIn: false };
      loadingState = "ready";
      if (unsubscribeBroadcast) {
        unsubscribeBroadcast();
        unsubscribeBroadcast = undefined;
      }
      if (unsubscribeShopifySync) {
        unsubscribeShopifySync();
        unsubscribeShopifySync = undefined;
      }
      store.dispatch(reset_shopify_sync_state());
    }
  }

  // Original broadcast logic variables
  const executedActions: { [k: string]: AnyAction } = {};
  const confirmedActions: { [k: string]: AnyAction } = {};
  let unsyncedActions = 0;
  let loadedActionCount = 0;
  let unsubscribeBroadcast: Unsubscribe | undefined;
  let unsubscribeShopifySync: Unsubscribe | undefined;

  function startBroadcastListener() {
    // Note: watchBroadcastActions is now async
    watchBroadcastActions(firestore, (actions) => {
      let filteredActions = actions;

      // Filter out actions already covered by the snapshot (if any)
      if (snapshotMetadata) {
        const snapSeconds = snapshotMetadata.timestamp?.seconds || 0;
        const snapNanos = snapshotMetadata.timestamp?.nanoseconds || 0;

        filteredActions = actions.filter((action) => {
          const thisTs = (action as any).timestamp;
          if (!thisTs) return true; // Keep if no timestamp? Or unsafe? Usually broadcast actions have ts.
          const thisSeconds = thisTs.seconds || 0;
          const thisNanos = thisTs.nanoseconds || 0;

          const isBefore =
            thisSeconds < snapSeconds ||
            (thisSeconds === snapSeconds && thisNanos < snapNanos);
          const isSameId = action.id === snapshotMetadata?.id;

          if (isBefore) return false;
          if (isSameId) return false;

          return true;
        });

        if (actions.length !== filteredActions.length) {
          console.log(
            `[Snapshot] Skipped ${actions.length - filteredActions.length} actions already in snapshot.`,
          );
        }
      }

      loadedActionCount += filteredActions.length;
      filteredActions.forEach((actionItem) => {
        // The actionItem is already expanded: { id, ...data }
        const action = actionItem as unknown as AnyAction;
        const id = actionItem.id;

        // Check if locally executed OR already in Redux history (hydration)
        const isAlreadyExecuted =
          executedActions[id] !== undefined ||
          store.getState().history.executedActions?.[id];

        if (!isAlreadyExecuted) {
          executedActions[id] = action;
          if (action.type === "retype_item") {
            // payload typing might be loose here, check properties safely
            const payload = (action as any).payload || {};
            const itemKey = payload.itemKey;
            const newItemKey = payload.janCode + payload.subtype;
            if (itemKey == newItemKey) {
              console.error("bad retype item detected", id);
              // We cannot easily deleteDoc(change.doc.ref) anymore because we don't have the ref reference here directly.
              // We have the ID. We can reconstruct the ref if needed.
              deleteDoc(doc(firestore, "broadcast", id));
            }
          }
          store.dispatch(action);
        }
        if ((action as any).timestamp !== null) {
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
    }).then((unsub) => {
      unsubscribeBroadcast = unsub;
    });

    // Return typed undefined initially since we await the promise
    return undefined;
  }

  function startShopifySyncListener() {
    const q = query(
      collection(firestore, "shopify_sync"),
      orderBy("timestamp", "desc"),
      limit(2000),
    );

    return onSnapshot(
      q,
      (snapshot) => {
        const events = snapshot.docs.map((eventDoc) => {
          return {
            id: eventDoc.id,
            ...(eventDoc.data() as any),
          };
        }) as ShopifySyncEvent[];
        store.dispatch(replace_shopify_sync_events(events));
      },
      (error) => {
        console.error("[ShopifySync] Listener failed", error);
      },
    );
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
      if (unsubscribeShopifySync) unsubscribeShopifySync();
      if (typeof window !== "undefined") delete (window as any).__store;
    };
  });

  if (
    typeof window !== "undefined" &&
    import.meta.env.VITE_ENABLE_TEST_HOOKS === "true"
  ) {
    (window as any).__store = store;
    (window as any).__firebaseAuth = auth;
  }
</script>

{#if me.signedIn}
  <div class="app-shell">
    <Navigation {unsyncedActions} bind:isOpen={navigationOpen} />
    <PhotoUploadManager />

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
    min-width: 0; /* Prevent flex item from expanding beyond viewport */
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
