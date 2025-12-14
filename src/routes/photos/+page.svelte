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
  <!-- ... (header code remains same, skipping for brevity in replacement) ... -->

  <!-- ... (connect button code remains same) ... -->

  {#if isConnected}
    <div class="space-y-6">
       <!-- ... (selection buttons remain same) ... -->
       
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
                    <div class="border-2 border-gray-200 rounded-lg p-6 relative">
                        <!-- JAN Badge embedded in top border -->
                        <div class="absolute -top-3 left-4 bg-white px-2">
                            <span class="bg-blue-100 text-blue-800 text-sm font-bold px-3 py-1 rounded-full border border-blue-200 shadow-sm">
                                JAN: {group.janCode}
                            </span>
                             {#if group.status === 'collecting'}
                                <span class="ml-2 text-xs text-gray-500 animate-pulse">Collecting images...</span>
                             {:else if group.status === 'generating'}
                                <span class="ml-2 text-xs text-purple-600 animate-pulse">Generating description...</span>
                             {/if}
                        </div>

                        <!-- Thumbnails -->
                        <div class="flex flex-wrap gap-4 mt-2 mb-4">
                            {#each group.imageUrls as url}
                                <div class="w-[148px] h-[148px] bg-gray-100 rounded-lg overflow-hidden border border-gray-200 shadow-sm">
                                     <SecureImage
                                      src="{url}=w296-h296-c"
                                      alt="Product Thumbnail"
                                      className="w-full h-full object-cover"
                                    />
                                </div>
                            {/each}
                        </div>

                        <!-- Description -->
                        {#if group.description}
                            <div class="prose prose-sm max-w-none bg-gray-50 p-4 rounded border border-gray-100">
                                {@html group.description}
                            </div>
                        {:else}
                             <div class="h-24 flex items-center justify-center bg-gray-50 rounded border border-dashed border-gray-300 text-gray-400 text-sm italic">
                                Description pending...
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
