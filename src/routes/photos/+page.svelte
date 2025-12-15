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
  import { processMediaItems } from "$lib/gemini-client";
  import SecureImage from "$lib/components/SecureImage.svelte";

  let isConnected = false;
  let photos: MediaItem[] = [];
  let loading = false;
  let error = "";
  let isPolling = false;
  let pollInterval: ReturnType<typeof setInterval>;
  let pollAttempts = 0;

  const MAX_POLL_ATTEMPTS = 60; // 2 minutes (approx)
  let pickerWindow: Window | null = null;

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
      // We append /autoclose to let Google handle the window closing after selection.
      let uri = session.pickerUri;
      if (!uri.endsWith('/autoclose')) {
          uri = uri.endsWith('/') ? `${uri}autoclose` : `${uri}/autoclose`;
      }
      pickerWindow = window.open(uri, "_blank", "width=800,height=600");

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
        console.error("Polling error:", e);
        // Don't stop polling on transient errors, but maybe count them?
      }
    }, 2000);
  }

  let isGenerating = false;
  let generationResults: any[] = [];

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

  import type { LiveGroup } from "$lib/gemini-client";

  let analysisGroups: LiveGroup[] = [];
  let progress = { current: 0, total: 0, message: "" };
  
  async function handleGenerate() {
    if (photos.length === 0) return;
    
    isGenerating = true;
    error = "";
    analysisGroups = [];
    progress = { current: 0, total: photos.length, message: "Initializing..." };

    try {
        const token = await import('$lib/google-photos').then(m => m.getStoredToken());
        if (!token) throw new Error("Not authenticated");

        console.log("Using token scopes:", token.scope);
        const apiKey = import.meta.env.VITE_GOOGLE_API_KEY;
        
        // We ignore the return value as we use the live state
        await processMediaItems(
            photos.map(p => ({ baseUrl: p.baseUrl, id: p.id })),
            token.access_token,
            apiKey,
            (groups, prog) => {
                analysisGroups = groups;
                progress = prog;
            }
        );

    } catch (e: any) {
        console.error("Generation error:", e);
        error = e.message;

        if (
            e.message === "Not authenticated" || 
            e.message.includes("403") || 
            e.message.includes("401") ||
            e.message.includes("insufficient permissions")
        ) {
            handleDisconnect();
            error = "Authentication expired or insufficient permissions. Please connect again to grant access.";
        }
    } finally {
        isGenerating = false;
        progress = { ...progress, message: "Done" };
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
      <div class="bg-white p-6 rounded-lg shadow-md flex items-center justify-between">
        <div>
          <h2 class="text-xl font-semibold mb-2">Select Photos</h2>
          <p class="text-gray-500 text-sm">Open the Google Photos picker to choose images.</p>
        </div>
        <div class="flex gap-4">
            <button
              on:click={handleSelectPhotos}
              disabled={loading || isPolling}
              class="bg-green-600 text-white px-6 py-3 rounded-md font-medium hover:bg-green-700 transition disabled:opacity-50 flex items-center gap-2"
            >
              {#if isPolling}
                <span class="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full"></span>
                Waiting...
              {:else}
                <span>Photos Library</span>
              {/if}
            </button>

            {#if photos.length > 0}
                <button
                  on:click={handleGenerate}
                  disabled={isGenerating}
                  class="bg-purple-600 text-white px-6 py-3 rounded-md font-medium hover:bg-purple-700 transition disabled:opacity-50 flex items-center gap-2"
                >
                  {#if isGenerating}
                    <span class="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full"></span>
                    Generating...
                  {:else}
                    <span>Generate Descriptions</span>
                  {/if}
                </button>
            {/if}
        </div>
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
                        style="width: {progress.total ? (progress.current / progress.total) * 100 : 0}%"
                    ></div>
                </div>
            </div>
        {/if}

        <!-- Analysis Groups / Results -->
        {#if analysisGroups.length > 0}
            <div class="space-y-8">
                {#each analysisGroups as group}
                    <!-- Card with nice rounded border -->
                    <!-- FORCED STYLES to ensure appearance -->
                    <div class="bg-slate-50 relative" style="margin: 1em; padding: 0.5em; border: 2px solid #e2e8f0; border-radius: 16px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);">
                        <!-- JAN Badge -->
                        <div class="absolute -top-4 left-6">
                            <span class="bg-blue-600 text-white text-sm font-bold px-4 py-1.5 rounded-full shadow-md flex items-center gap-2">
                                <span>JAN: {group.janCode}</span>
                                {#if group.status === 'collecting'}
                                    <span class="w-2 h-2 bg-yellow-300 rounded-full animate-pulse" title="Collecting images"></span>
                                {:else if group.status === 'generating'}
                                    <span class="w-2 h-2 bg-purple-300 rounded-full animate-pulse" title="Generating"></span>
                                {:else if group.status === 'done'}
                                    <span class="w-2 h-2 bg-green-300 rounded-full" title="Done"></span>
                                {/if}
                            </span>
                        </div>

                        <!-- Thumbnails Row -->
                        <!-- Thumbnails Row -->
                        <div class="flex flex-row flex-wrap gap-4 mt-4 mb-6" style="display: flex; flex-direction: row; flex-wrap: wrap;">
                            {#each group.imageUrls as url, i}
                                <!-- FORCED SIZE to 148px -->
                                <div class="bg-white rounded-lg overflow-hidden border border-gray-200 shadow-sm relative" style="width: 148px; height: 148px; flex-shrink: 0;">
                                     <SecureImage
                                      src="{url.startsWith('data:') ? url : `${url}=w296-h296-c`}"
                                      alt="Product Thumbnail"
                                      className="w-full h-full object-cover"
                                    />
                                    
                                    <!-- Spinner Overlay -->
                                    {#if group.imageStatuses && group.imageStatuses[i] === 'optimizing'}
                                        <div class="absolute inset-0 bg-white/70 flex items-center justify-center z-10 transition-opacity duration-300">
                                            <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                                        </div>
                                    {/if}
                                </div>
                            {/each}
                        </div>

                        <!-- Description -->
                        {#if group.description}
                            <div class="prose prose-sm max-w-none bg-white p-5 rounded-lg border border-gray-200 shadow-inner">
                                {@html group.description}
                            </div>
                        {:else}
                             <div class="h-24 flex items-center justify-center bg-gray-100 rounded-lg border-2 border-dashed border-gray-300 text-gray-400 text-sm italic">
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
            <!-- Empty State / Selection View -->
            {#if photos.length > 0}
               <!-- ... existing thumbnail selection grid ... -->
               <div class="flex justify-between items-center mb-4">
                 <h3 class="font-medium text-gray-700">Selected Photos ({photos.length})</h3>
               </div>
               <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                 {#each photos as photo}
                   <div class="aspect-square bg-gray-100 rounded overflow-hidden relative group">
                     <SecureImage
                       src="{photo.baseUrl}=w400-h400-c"
                       alt="Thumbnail"
                       className="w-full h-full object-cover"
                     />
                   </div>
                 {/each}
               </div>
            {:else if isPolling}
               <!-- ... polling state ... -->
               <div class="text-center py-20 text-gray-500">
                 <p class="text-lg">Please select photos in the popup window...</p>
               </div>
            {:else}
               <div class="text-center py-20 text-gray-400">
                 No photos selected yet.
               </div>
            {/if}
        {/if}
      </div>
    </div>
  {/if}
</div>
