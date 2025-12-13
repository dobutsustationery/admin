<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import {
    initiateOAuthFlow,
    handleOAuthCallback,
    isAuthenticated,
    createPickerSession,
    pollPickerSession,
    listSessionMediaItems,
    clearToken,
  } from "$lib/google-photos";
  import type { MediaItem } from "$lib/google-photos";
  import SecureImage from "$lib/components/SecureImage.svelte";

  let isConnected = false;
  let photos: MediaItem[] = [];
  let loading = false;
  let error = "";
  let isPolling = false;
  let pollInterval: ReturnType<typeof setInterval>;
  let pollAttempts = 0;
  const MAX_POLL_ATTEMPTS = 60; // 2 minutes (approx)

  onMount(() => {
    // Check for OAuth callback
    handleOAuthCallback();
    isConnected = isAuthenticated();
  });

  onDestroy(() => {
    stopPolling();
  });

  function handleConnect() {
    initiateOAuthFlow();
  }

  function handleDisconnect() {
    clearToken();
    isConnected = false;
    photos = [];
    stopPolling();
  }

  function stopPolling() {
    if (pollInterval) {
      clearInterval(pollInterval);
    }
    isPolling = false;
    pollAttempts = 0;
  }

  async function handleSelectPhotos() {
    error = "";
    loading = true;

    try {
      const session = await createPickerSession();
      // The picker URI needs to be opened in a way the user can interact.
      // It's a Google-hosted page.
      // Since we need to poll concurrently, we should open it in a new window/tab.
      window.open(session.pickerUri, "_blank", "width=800,height=600");

      startPolling(session.id);
    } catch (e: any) {
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
          stopPolling();
          await loadSelectedPhotos(sessionId);
        }
      } catch (e: any) {
        console.error("Polling error:", e);
        // Don't stop polling on transient errors, but maybe count them?
      }
    }, 2000);
  }

  async function loadSelectedPhotos(sessionId: string) {
    try {
      // Fetch the items
      // Note: Pagination could be needed for large selections, implementing basic listing for now
      const items = await listSessionMediaItems(sessionId);
      // Prepend new photos to existing ones, or replace?
      // Replaces seems cleaner for a "session" concept.
      photos = items;
    } catch (e: any) {
      error = "Failed to load photos: " + e.message;
    } finally {
      loading = false;
    }
  }
</script>

<div class="p-8 max-w-6xl mx-auto">
  <div class="flex justify-between items-center mb-8">
    <h1 class="text-3xl font-bold">Google Photos Picker</h1>
    {#if isConnected}
      <button
        on:click={handleDisconnect}
        class="text-sm text-red-600 hover:text-red-800"
      >
        Disconnect
      </button>
    {/if}
  </div>

  {#if !isConnected}
    <div class="bg-white p-8 rounded-lg shadow-md text-center">
      <p class="mb-6 text-gray-600">
        Connect to Google Photos to select product images.
      </p>
      <button
        on:click={handleConnect}
        class="bg-blue-600 text-white px-6 py-3 rounded-md font-medium hover:bg-blue-700 transition"
      >
        Connect Google Photos
      </button>
    </div>
  {:else}
    <div class="space-y-6">
      <!-- Actions -->
      <div
        class="bg-white p-6 rounded-lg shadow-md flex items-center justify-between"
      >
        <div>
          <h2 class="text-xl font-semibold mb-2">Select Photos</h2>
          <p class="text-gray-500 text-sm">
            Open the Google Photos picker to choose images.
          </p>
        </div>
        <button
          on:click={handleSelectPhotos}
          disabled={loading || isPolling}
          class="bg-green-600 text-white px-6 py-3 rounded-md font-medium hover:bg-green-700 transition disabled:opacity-50 flex items-center gap-2"
        >
          {#if isPolling}
            <span
              class="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full"
            ></span>
            Waiting for selection...
          {:else}
            <span>Photos Library</span>
          {/if}
        </button>
      </div>

      <!-- content -->
      <div class="bg-white p-6 rounded-lg shadow-md min-h-[400px]">
        {#if error}
          <div class="p-4 bg-red-50 text-red-700 rounded mb-4">
            {error}
          </div>
        {/if}

        {#if loading && !isPolling}
          <div class="flex justify-center p-12">
            <div
              class="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"
            ></div>
          </div>
        {:else if photos.length > 0}
          <div class="flex justify-between items-center mb-4">
            <h3 class="font-medium text-gray-700">
              Selected Photos ({photos.length})
            </h3>
          </div>
          <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {#each photos as photo}
              <div
                class="aspect-square bg-gray-100 rounded overflow-hidden relative group"
              >
                <SecureImage
                  src="{photo.baseUrl}=w400-h400-c"
                  alt="Thumbnail"
                  className="w-full h-full object-cover"
                />
                <div
                  class="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-10 transition-all"
                ></div>
              </div>
            {/each}
          </div>
        {:else if isPolling}
          <div class="text-center py-20 text-gray-500">
            <p class="text-lg">Please select photos in the popup window...</p>
            <p class="text-sm mt-2">
              The photos will appear here once you click "Done".
            </p>
          </div>
        {:else}
          <div class="text-center py-20 text-gray-400">
            No photos selected yet.
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
