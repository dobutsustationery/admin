<script lang="ts">
  import "../app.css"; // Import global styles
  import Navigation from "$lib/components/Navigation.svelte";
  import PhotoUploadManager from "$lib/components/PhotoUploadManager.svelte";
  import LoadingScreen from "$lib/components/LoadingScreen.svelte";
  import StickyBannerContainer from "$lib/components/StickyBannerContainer.svelte";
  import Signin from "$lib/Signin.svelte"; // Static import
  import { onAuthStateChanged, signOut } from "firebase/auth";
  import { auth, firestore, googleAuthProvider } from "$lib/firebase"; // Ensure imports are correct based on file context
  import {
    collection,
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
    setSnapshotPersistencePaused,
  } from "$lib/store";
  import { user } from "$lib/user-store";
  import type { AnyAction } from "$lib/store";
  import {
    watchBroadcastActions,
    type BroadcastProgress,
  } from "$lib/redux-firestore";
  import {
    replace_shopify_sync_events,
    reset_shopify_sync_state,
  } from "$lib/shopify-sync-slice";
  import type { ShopifySyncEvent } from "$lib/shopify-sync-model";
  import {
    replace_sync_events,
    reset_sync_queue_state,
    type SyncEvent,
  } from "$lib/sync-queue-slice";
  import {
    SYNC_COLLECTION,
    toShopifySyncListenerEvent,
  } from "$lib/sync-events";
  import {
    getExpiryInfo as getPhotosExpiry,
    refreshTokensSilently as refreshPhotosSilently,
  } from "$lib/google-photos";
  import {
    getExpiryInfo as getDriveExpiry,
    refreshTokensSilently as refreshDriveSilently,
  } from "$lib/google-drive";
  import AuthRefreshBanner from "$lib/components/AuthRefreshBanner.svelte";

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
  let loadingProgress = 0;
  let loadingMessage = "Starting up...";
  let loadingDetail = "";
  let navigationOpen = false;
  let isRefreshingTokens = false;
  let refreshRequired = false;

  async function checkAndRefreshTokens() {
    if (!me.signedIn || isRefreshingTokens) return;

    const photosExpiry = getPhotosExpiry();
    const driveExpiry = getDriveExpiry();

    // Refresh when less than 15 minutes remain (about 45 minutes into a 60-minute token).
    const NEEDS_REFRESH_SECONDS = 15 * 60;

    const photosNeedsRefresh =
      photosExpiry &&
      !photosExpiry.expired &&
      photosExpiry.expiresInSeconds < NEEDS_REFRESH_SECONDS;
    const driveNeedsRefresh =
      driveExpiry &&
      !driveExpiry.expired &&
      driveExpiry.expiresInSeconds < NEEDS_REFRESH_SECONDS;

    if (photosNeedsRefresh || driveNeedsRefresh) {
      console.log(
        "[Layout] Tokens nearing expiry, initiating silent refresh...",
      );
      isRefreshingTokens = true;
      refreshRequired = false;
      try {
        const success = await refreshPhotosSilently();
        if (success) {
          console.log("[Layout] Silent refresh successful.");
          isRefreshingTokens = false;
        } else {
          console.warn(
            "[Layout] Silent refresh failed or requires interaction.",
          );
          // Don't set isRefreshingTokens false immediately, show "Required" banner
          refreshRequired = true;
        }
      } catch (e) {
        console.error("[Layout] Auto-refresh error", e);
        refreshRequired = true;
      }
    }
  }

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

                  // Relax check: have either one to be considered "valid enough" to keep the token
                  // Individual pages will still check for their specific required scopes
                  hasAllScopes = hasPicker || hasDrive;

                  if (!hasAllScopes && attempts === maxAttempts - 1) {
                    console.warn(
                      `[Layout] No recognized scopes found. Scopes: ${scopeStr}`,
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
            loadingProgress = 0;
            loadingMessage = "Counting actions...";
            loadingDetail = "";
            setSnapshotPersistencePaused(true);

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
      setSnapshotPersistencePaused(false);
      if (unsubscribeBroadcast) {
        unsubscribeBroadcast();
        unsubscribeBroadcast = undefined;
      }
      if (unsubscribeShopifySync) {
        unsubscribeShopifySync();
        unsubscribeShopifySync = undefined;
      }
      store.dispatch(reset_shopify_sync_state());
      store.dispatch(reset_sync_queue_state());
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
    watchBroadcastActions(
      firestore,
      (actions) => {
        let filteredActions = actions;

        if (snapshotMetadata) {
          const snapSeconds = snapshotMetadata.timestamp?.seconds || 0;
          const snapNanos = snapshotMetadata.timestamp?.nanoseconds || 0;

          filteredActions = actions.filter((action) => {
            const thisTs = (action as any).timestamp;
            if (!thisTs) return true;
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
          const action = actionItem as unknown as AnyAction;
          const id = actionItem.id;

          const isAlreadyExecuted =
            executedActions[id] !== undefined ||
            store.getState().history.executedActions?.[id];

          if (!isAlreadyExecuted) {
            executedActions[id] = action;
            if (action.type === "retype_item") {
              const payload = (action as any).payload || {};
              const itemKey = payload.itemKey;
              const newItemKey = payload.janCode + payload.subtype;
              if (itemKey == newItemKey) {
                console.error("bad retype item detected", id);
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
      },
      {
        onProgress: (progress: BroadcastProgress) => {
          loadingState = "loading";
          loadingProgress = progress.percent;
          loadingMessage = progress.message;
          if (progress.total > 0) {
            loadingDetail = `${progress.loaded.toLocaleString()} / ${progress.total.toLocaleString()} actions`;
          } else if (progress.loaded > 0) {
            loadingDetail = `${progress.loaded.toLocaleString()} actions`;
          } else {
            loadingDetail = "";
          }
        },
        onReady: () => {
          loadingProgress = 100;
          loadingMessage = "Live sync connected.";
          setSnapshotPersistencePaused(false, { flush: true });
          if (me.signedIn) {
            loadingState = "ready";
          }
        },
        errorCallback: (error) => {
          console.error("[Broadcast] Bootstrap failed", error);
          loadingMessage = "Failed to load action history.";
        },
      },
    )
      .then((unsub) => {
        unsubscribeBroadcast = unsub;
      })
      .catch((error) => {
        console.error("[Broadcast] Listener startup failed", error);
        loadingMessage = "Failed to load action history.";
      });

    // Return typed undefined initially since we await the promise
    return undefined;
  }

  function startShopifySyncListener() {
    const q = query(
      collection(firestore, SYNC_COLLECTION),
      orderBy("createdAtMs", "desc"),
      limit(5000),
    );

    return onSnapshot(
      q,
      (snapshot) => {
        const events = snapshot.docs.map((eventDoc) =>
          toShopifySyncListenerEvent({
            id: eventDoc.id,
            data: eventDoc.data() as Record<string, any>,
          }),
        ) as ShopifySyncEvent[];
        store.dispatch(replace_sync_events(events as SyncEvent[]));
        store.dispatch(replace_shopify_sync_events(events));
      },
      (error) => {
        console.error(
          `[ShopifySync] Listener failed for ${SYNC_COLLECTION}`,
          error,
        );
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
    }, 10000);

    // Auto-refresh timer (every 60s)
    const refreshInterval = setInterval(checkAndRefreshTokens, 60000);
    // Also check once immediately on mount (delayed slightly to allow hydration)
    setTimeout(checkAndRefreshTokens, 2000);

    return () => {
      unsubscribe();
      if (unsubscribeBroadcast) unsubscribeBroadcast();
      if (unsubscribeShopifySync) unsubscribeShopifySync();
      clearInterval(refreshInterval);
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
    {#if loadingState === "ready"}
      <PhotoUploadManager />
    {/if}

    <main class="main-content" class:nav-open={navigationOpen}>
      <StickyBannerContainer />
      <slot />
    </main>

    {#if isRefreshingTokens}
      <AuthRefreshBanner type={refreshRequired ? "required" : "refreshing"} />
    {/if}
  </div>

  {#if loadingState !== "ready"}
    <LoadingScreen
      status={loadingState}
      progress={loadingProgress}
      message={loadingMessage}
      detail={loadingDetail}
    />
  {/if}
{:else if loadingState === "initializing"}
  <LoadingScreen
    status="initializing"
    progress={loadingProgress}
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
