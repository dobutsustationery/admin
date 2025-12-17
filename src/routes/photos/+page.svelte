<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import {
    createPickerSession,
    pollPickerSession,
    listSessionMediaItems,
    getStoredToken,
  } from "$lib/google-photos";
  import type { MediaItem } from "$lib/google-photos";
  import { processMediaItems } from "$lib/gemini-client";
  import SecureImage from "$lib/components/SecureImage.svelte";
  import { store } from "$lib/store";
  import { broadcast } from "$lib/redux-firestore";
  import { auth, firestore } from "$lib/firebase";
  import { user } from "$lib/user-store";
  import { signOut } from "firebase/auth";

  // State from Redux Store
  $: photos = $store.photos.selected;
  $: isGenerating = $store.photos.generating;

  let error = "";
  let isPolling = false;
  let loading = false;
  let pollInterval: ReturnType<typeof setInterval>;
  let pollAttempts = 0;

  const MAX_POLL_ATTEMPTS = 60; // 2 minutes (approx)
  let pickerWindow: Window | null = null;

  onDestroy(() => {
    stopPolling();
  });

  function checkAuthError(e: any): boolean {
    const msg = e.message || String(e);
    if (
      msg.includes("401") ||
      msg.includes("UNAUTHENTICATED") ||
      msg.includes("invalid authentication credentials")
    ) {
      console.warn("Caught authentication error, signing out user.");
      signOut(auth);
      return true;
    }
    return false;
  }

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
    }
    isPolling = false;
    pollAttempts = 0;
  }

  let selectionMode: "replace" | "add" = "replace";

  async function handleSelectPhotos(mode: "replace" | "add" = "replace") {
    selectionMode = mode;
    error = "";
    loading = true;

    try {
      const session = await createPickerSession();
      // The picker URI needs to be opened in a way the user can interact.
      // We append /autoclose to let Google handle the window closing after selection.
      let uri = session.pickerUri;
      if (!uri.endsWith("/autoclose")) {
        uri = uri.endsWith("/") ? `${uri}autoclose` : `${uri}/autoclose`;
      }
      pickerWindow = window.open(uri, "_blank", "width=800,height=600");

      startPolling(session.id);
    } catch (e: any) {
      checkAuthError(e);
      error = e.message;
      loading = false;
    }
  }

  function startPolling(sessionId: string) {
    stopPolling();
    isPolling = true;
    loading = true; // Still loading from user perspective until photos appear

    // Poll every 2 seconds
    pollInterval = setInterval(async () => {
      pollAttempts++;
      if (pollAttempts > MAX_POLL_ATTEMPTS) {
        stopPolling();
        error = "Selection timed out. Please try again.";
        loading = false;
        return;
      }

      try {
        const session = await pollPickerSession(sessionId);
        if (session.mediaItemsSet) {
          // User finished selection
          if (pickerWindow) {
            // Try to close
            pickerWindow.close();
            // Focus parent window to bring it forward if closure fails
            window.focus();
            pickerWindow = null;
          }
          stopPolling();
          await loadSelectedPhotos(sessionId);
        }
      } catch (e: any) {
        checkAuthError(e);
        console.error("Polling error:", e);
      }
    }, 2000);
  }

  async function loadSelectedPhotos(sessionId: string) {
    try {
      const newItems = await listSessionMediaItems(sessionId);

      let finalItems: MediaItem[] = [];

      if (selectionMode === "replace") {
        finalItems = newItems;
      } else {
        // ADD mode: Merge with existing photos
        // Deduplicate based on ID
        const map = new Map<string, MediaItem>();
        // Add existing photos first
        photos.forEach((p) => map.set(p.id, p));
        // Add/Overwrite with new photos
        newItems.forEach((p) => map.set(p.id, p));

        finalItems = Array.from(map.values());
      }

      // Sort by creationTime (oldest first)
      finalItems.sort((a, b) => {
        const tA = new Date(a.mediaMetadata?.creationTime || 0).getTime();
        const tB = new Date(b.mediaMetadata?.creationTime || 0).getTime();
        return tA - tB;
      });

      // Save to Broadcast for persistence/replay
      if ($user.uid) {
        broadcast(firestore, $user.uid, {
          type: "photos/select_photos",
          payload: { photos: finalItems },
        });
      }
    } catch (e: any) {
      checkAuthError(e);
      error = "Failed to load photos: " + e.message;
    } finally {
      loading = false;
    }
  }

  import type { LiveGroup } from "$lib/gemini-client";

  let analysisGroups: LiveGroup[] = [];
  let progress = { current: 0, total: 0, message: "" };

  async function handleGenerate() {
    if (photos.length === 0) return;

    //store.dispatch({ type: "photos/set_generating", payload: true });
    error = "";
    analysisGroups = [];
    progress = { current: 0, total: photos.length, message: "Initializing..." };

    try {
      // Use the stored token from Signin (localStorage)
      const token = getStoredToken();
      if (!token) throw new Error("Not authenticated");

      console.log("Using token scopes:", token.scope);
      const apiKey = import.meta.env.VITE_GOOGLE_API_KEY;

      await processMediaItems(
        photos.map((p) => ({ baseUrl: p.baseUrl, id: p.id })),
        token.access_token,
        apiKey,
        (groups, prog) => {
          analysisGroups = groups;
          progress = prog;
        },
      );
    } catch (e: any) {
      checkAuthError(e);
      console.error("Generation error:", e);
      error = e.message;
    } finally {
      store.dispatch({ type: "photos/set_generating", payload: false });
      progress = { ...progress, message: "Done" };
    }
  }
</script>

<div class="p-8 max-w-6xl mx-auto">
  <div class="flex justify-between items-center mb-8">
    <h1 class="text-3xl font-bold">Google Photos Import</h1>
  </div>

  <!-- CONTENT AREA -->
  <div class="bg-white p-6 rounded-lg shadow-md min-h-[400px]">
    <!-- Progress Bar -->
    {#if isGenerating || analysisGroups.length > 0}
      <div class="mb-8">
        <div class="flex justify-between text-sm text-gray-600 mb-2">
          <span class="font-medium">{progress.message}</span>
          <span>{progress.current} / {progress.total}</span>
        </div>
        <div class="w-full bg-gray-200 rounded-full h-4 overflow-hidden">
          <div
            class="bg-blue-600 h-4 rounded-full transition-all duration-300 ease-out"
            style="width: {progress.total
              ? (progress.current / progress.total) * 100
              : 0}%"
          ></div>
        </div>
      </div>
    {/if}

    <!-- Analysis Groups / Results -->
    {#if analysisGroups.length > 0}
      <div class="space-y-8">
        {#each analysisGroups as group}
          <!-- ... existing group rendering ... -->
          <div
            class="bg-slate-50 relative"
            style="margin: 1em; padding: 0.5em; border: 2px solid #e2e8f0; border-radius: 16px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);"
          >
            <!-- JAN Badge -->
            <div class="absolute -top-4 left-6">
              <!-- ... badge content ... -->
              <span
                class="bg-blue-600 text-white text-sm font-bold px-4 py-1.5 rounded-full shadow-md flex items-center gap-2"
              >
                <span>JAN: {group.janCode}</span>
                {#if group.status === "collecting"}
                  <span
                    class="w-2 h-2 bg-yellow-300 rounded-full animate-pulse"
                    title="Collecting images"
                  ></span>
                {:else if group.status === "generating"}
                  <span
                    class="w-2 h-2 bg-purple-300 rounded-full animate-pulse"
                    title="Generating"
                  ></span>
                {:else if group.status === "done"}
                  <span class="w-2 h-2 bg-green-300 rounded-full" title="Done"
                  ></span>
                {/if}
              </span>
            </div>

            <!-- Thumbnails -->
            <div
              class="flex flex-row flex-wrap gap-4 mt-6 mb-6 p-4"
              style="display: flex; flex-direction: row; flex-wrap: wrap;"
            >
              {#each group.imageUrls as url, i}
                <div
                  class="bg-white rounded-lg overflow-hidden border border-gray-200 shadow-sm relative"
                  style="width: 148px; height: 148px; flex-shrink: 0;"
                >
                  <SecureImage
                    src={url.startsWith("data:") ? url : `${url}=w296-h296-c`}
                    alt="Product Thumbnail"
                    className="w-full h-full object-cover"
                  />
                  <!-- Spinner Overlay -->
                  {#if group.imageStatuses && group.imageStatuses[i] === "optimizing"}
                    <div
                      class="absolute inset-0 bg-white/70 flex items-center justify-center z-10 transition-opacity duration-300"
                    >
                      <div
                        class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"
                      ></div>
                    </div>
                  {/if}
                </div>
              {/each}
            </div>

            <!-- Description -->
            {#if group.description}
              <div
                class="prose prose-sm max-w-none bg-white p-5 rounded-lg border border-gray-200 shadow-inner"
              >
                {@html group.description}
              </div>
            {:else}
              <div
                class="h-24 flex items-center justify-center bg-gray-100 rounded-lg border-2 border-dashed border-gray-300 text-gray-400 text-sm italic"
              >
                <span class="animate-pulse">Waiting for AI description...</span>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    {#if error}
      <div class="p-4 bg-red-50 text-red-700 rounded mb-4 mt-6">
        {error}
      </div>
    {/if}

    {#if !isGenerating && analysisGroups.length === 0}
      <div
        class="bg-slate-50 relative mt-8"
        style="margin: 1em; padding: 0.5em; border: 2px solid #e2e8f0; border-radius: 16px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);"
      >
        <!-- Controls area inside card -->
        <div class="flex justify-between items-center px-4 pt-4 pb-2">
          <div class="flex gap-2">
            <button
              on:click={() => handleSelectPhotos("replace")}
              disabled={loading || isPolling}
              class="bg-green-600 text-white px-4 py-2 rounded-md font-medium hover:bg-green-700 transition disabled:opacity-50 flex items-center gap-2 text-sm"
            >
              {#if isPolling && selectionMode === "replace"}
                <span
                  class="animate-spin h-3 w-3 border-2 border-white border-t-transparent rounded-full"
                ></span>
                Waiting...
              {:else}
                Select Photos
              {/if}
            </button>

            <button
              on:click={() => handleSelectPhotos("add")}
              disabled={loading || isPolling}
              class="bg-blue-600 text-white px-4 py-2 rounded-md font-medium hover:bg-blue-700 transition disabled:opacity-50 flex items-center gap-2 text-sm"
            >
              {#if isPolling && selectionMode === "add"}
                <span
                  class="animate-spin h-3 w-3 border-2 border-white border-t-transparent rounded-full"
                ></span>
                Waiting...
              {:else}
                Add Photos
              {/if}
            </button>
          </div>

          {#if photos.length > 0}
            <button
              on:click={handleGenerate}
              disabled={isGenerating}
              class="bg-purple-600 text-white px-4 py-2 rounded-md font-medium hover:bg-purple-700 transition disabled:opacity-50 flex items-center gap-2 text-sm"
            >
              Generate Descriptions
            </button>
          {/if}
        </div>

        <!-- Thumbnails Row -->
        <div
          class="flex flex-row flex-wrap gap-4 mt-2 mb-6 p-4 min-h-[160px]"
          style="display: flex; flex-direction: row; flex-wrap: wrap;"
        >
          {#if photos.length > 0}
            {#each photos as photo}
              <div
                class="bg-white rounded-lg overflow-hidden border border-gray-200 shadow-sm relative group"
                style="width: 148px; height: 148px; flex-shrink: 0;"
              >
                <SecureImage
                  src="{photo.baseUrl}=w400-h400-c"
                  alt="Thumbnail"
                  className="w-full h-full object-cover"
                />
              </div>
            {/each}
          {:else if isPolling}
            <div class="w-full text-center py-10 text-gray-500">
              <p>Selection in progress...</p>
            </div>
          {:else}
            <div class="w-full text-center py-10 text-gray-400 italic">
              No photos queued. Select or Add photos to begin.
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>
