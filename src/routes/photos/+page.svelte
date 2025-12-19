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
  $: uploads = $store.photos.uploads || {};
  $: janCodeToPhotos = $store.photos.janCodeToPhotos || {};
  $: isGenerating = $store.photos.generating;
  $: isCategorizing = $store.photos.categorizing;

  import { 
    begin_categorize, 
    end_categorize, 
    merge_jan_groups 
  } from "$lib/photos-slice";

  import { categorizeMediaItems } from "$lib/gemini-client"; 
  let catProgress = { current: 0, total: 0, message: "" };

  async function handleCategorize() {
    if (photos.length === 0) return;
    
    // Broadcast begin (Sets flag)
    if ($user.uid) {
         broadcast(firestore, $user.uid, { type: "photos/begin_categorize" });
    }
    
    catProgress = { current: 0, total: photos.length, message: "Starting..." };
    
    try {
        const token = getStoredToken();
        if (!token) throw new Error("Not authenticated");
        const apiKey = import.meta.env.VITE_GOOGLE_API_KEY; // Optional
        
        // Pass a copy of photos to avoid mutation race conditions if UI updates
        const itemsToProcess = photos.map(p => ({ baseUrl: p.baseUrl, id: p.id }));
        
        await categorizeMediaItems(
           itemsToProcess,
           token.access_token,
           apiKey,
           (item, janCode) => {
               // On Match -> Broadcast Action to move item
               if ($user.uid) {
                   // We need the full MediaItem. Find it in current state (or known uploads)
                   const fullItem = photos.find(p => p.id === item.id) || { ...item }; // Fallback
                   
                   broadcast(firestore, $user.uid, {
                       type: "photos/categorize_photo",
                       payload: { janCode, photo: fullItem }
                   });
               }
           },
           (current, total, message) => {
               catProgress = { current, total, message };
           }
        );
        
    } catch (e: any) {
        checkAuthError(e);
        console.error("Categorize Error:", e);
        error = e.message;
    } finally {
        if ($user.uid) {
             broadcast(firestore, $user.uid, { type: "photos/end_categorize" });
             store.dispatch(end_categorize()); // Also dispatch locally to be sure
        }
    }
  }

  // State
  let error = "";
  let isPolling = false;
  let loading = false;
  let pollInterval: ReturnType<typeof setInterval>;
  let pollAttempts = 0;

  const MAX_POLL_ATTEMPTS = 60; // 2 minutes (approx)
  let pickerWindow: Window | null = null;

  // LIFECYCLE
  onMount(() => {
     // Safety: Reset categorization state if it was stuck from a previous session/reload
     if ($store.photos.categorizing) {
         console.log("Resetting stuck 'categorizing' state on mount.");
         store.dispatch(end_categorize());
     }
  });

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


  
  // ... imports ...

  async function loadSelectedPhotos(sessionId: string) {
    try {
      const newItems = await listSessionMediaItems(sessionId);
      
      // Filter or Map items?
      // Just pass raw items (with their ephemeral baseUrl).
      // The background worker will pick them up and upload them.
      
      let finalItems: MediaItem[] = [];

      if (selectionMode === "replace") {
        finalItems = newItems;
      } else {
        // ADD mode: Merge with existing photos
        const map = new Map<string, MediaItem>();
        photos.forEach((p) => map.set(p.id, p));
        newItems.forEach((p) => map.set(p.id, p));
        finalItems = Array.from(map.values());
      }
      
      // Sort
      finalItems.sort((a, b) => {
         const tA = new Date(a.mediaMetadata?.creationTime || 0).getTime();
         const tB = new Date(b.mediaMetadata?.creationTime || 0).getTime();
         return tA - tB;
      });

      if ($user.uid) {
         // Broadcast selection.
         // This puts ephemeral URLs in the store.
         // PhotoUploadManager will detect them and initiate upload.
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

  function handleClearPhotos() {
      if (confirm("Remove all selected photos?")) {
          // Clear via broadcast
          if ($user.uid) {
            broadcast(firestore, $user.uid, {
              type: "photos/select_photos",
              payload: { photos: [] },
            });
          }
      }
  }

  async function handleGenerate() {
    if (photos.length === 0) return;
    // ... rest of handleGenerate
    
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

  // Merge Logic
  import { fade } from 'svelte/transition';
  import { merge_jan_groups, rename_jan_group } from "$lib/photos-slice";

  let hoveredRowIndex: number | null = null;
  let hoveredColumn: "jan" | "photos" | null = null;
  $: categorizedEntries = Object.entries(janCodeToPhotos);

  // JAN Validation (EAN-13 Checksum)
  function isValidJan(code: string): boolean {
      if (!/^\d{13}$/.test(code)) return false; // Must be 13 digits for standard JAN
      
      const digits = code.split('').map(Number);
      const checksum = digits.pop()!;
      
      const sum = digits.reduce((acc, curr, idx) => {
          // Even index (0, 2...) -> Odd Position (1st, 3rd...) -> x1
          // Odd index (1, 3...) -> Even Position (2nd, 4th...) -> x3
          const weight = (idx % 2 === 0) ? 1 : 3;
          return acc + (curr * weight);
      }, 0);
      
      const calcChecksum = (10 - (sum % 10)) % 10;
      return calcChecksum === checksum;
  }

  function handleJanRename(oldJan: string, newJan: string) {
      newJan = newJan.trim();
      if (newJan === oldJan) return; // Allow empty!

      if ($user.uid) {
           broadcast(firestore, $user.uid, {
               type: "photos/rename_jan_group",
               payload: { oldJan, newJan }
           });
      }
      store.dispatch(rename_jan_group({ oldJan, newJan }));
  }

  function handleInputKey(e: KeyboardEvent, oldJan: string) {
      if (e.key === 'Enter') {
          (e.target as HTMLInputElement).blur();
      }
  }

  function handleMergeUp(index: number) {
      if (index <= 0) return;
      
      const [sourceJan] = categorizedEntries[index];
      const [targetJan] = categorizedEntries[index - 1];
      
      if ($user.uid) {
           broadcast(firestore, $user.uid, {
               type: "photos/merge_jan_groups",
               payload: { sourceJan, targetJan }
           });
      }
      // Optimistic
      store.dispatch(merge_jan_groups({ sourceJan, targetJan }));
      
      hoveredRowIndex = null;
  }

  // --- PREVIEW LOGIC ---
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  let previewItem: MediaItem | null = null;
  let previewStyle = ""; // For positioning

  function handleThumbnailEnter(e: MouseEvent, item: MediaItem) {
      if (previewTimer) clearTimeout(previewTimer);
      
      const target = e.currentTarget as HTMLElement;
      const rect = target.getBoundingClientRect();
      const mouseY = rect.top + (rect.height / 2); // Use center of thumbnail
      
      previewTimer = setTimeout(() => {
          const winHeight = window.innerHeight;
          const spaceAbove = mouseY;
          const spaceBelow = winHeight - mouseY;
          
          let style = "left: 50%; transform: translateX(-50%); position: fixed; z-index: 100;";
          
          // Use space above if it's significantly larger or we are in bottom half
          if (spaceAbove > spaceBelow) {
              // Show ABOVE
              style += ` bottom: ${winHeight - rect.top + 10}px; top: 20px;`;
          } else {
              // Show BELOW
              style += ` top: ${rect.bottom + 10}px; bottom: 20px;`;
          }
          
          previewStyle = style;
          previewItem = item;
      }, 200);
  }

  function handleThumbnailLeave() {
      if (previewTimer) clearTimeout(previewTimer);
      previewItem = null;
  }
</script>

<div class="p-8 max-w-6xl mx-auto relative">
  <!-- PREVIEW OVERLAY -->
  {#if previewItem}
      <div 
        class="fixed bg-white p-2 rounded shadow-2xl border border-gray-200 pointer-events-none flex flex-col items-center"
        style={previewStyle}
        transition:fade={{ duration: 200 }}
      >
        <!-- Large Image -->
        <SecureImage 
            src={previewItem.baseUrl.includes("drive.google.com") ? `${previewItem.baseUrl}&sz=w800` : `${previewItem.baseUrl}=w1024`}
            className="w-auto h-full max-h-full object-contain rounded"
        />
        <!-- Optional Info -->
        <div class="mt-2 text-xs text-gray-500 font-mono">{previewItem.filename}</div>
      </div>
  {/if}

  <div class="flex justify-between items-center mb-8">
  <!-- ... existing content ... -->
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
                    src={url.startsWith("data:") || url.includes("drive.google.com") ? url : `${url}=w296-h296-c`}
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
                on:click={handleClearPhotos}
                class="bg-red-100 text-red-700 px-3 py-2 rounded-md font-medium hover:bg-red-200 transition text-sm mr-2"
                title="Remove all photos"
            >
                Clear
            </button>

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

          <div class="flex gap-2">
             {#if photos.length > 0}
                <button
                on:click={handleCategorize}
                disabled={isCategorizing || isGenerating}
                class="bg-teal-600 text-white px-4 py-2 rounded-md font-medium hover:bg-teal-700 transition disabled:opacity-50 flex items-center gap-2 text-sm"
                >
                Categorize Photos
                </button>
                
                <button
                on:click={handleGenerate}
                disabled={isGenerating || isCategorizing}
                class="bg-purple-600 text-white px-4 py-2 rounded-md font-medium hover:bg-purple-700 transition disabled:opacity-50 flex items-center gap-2 text-sm"
                >
                Generate Descriptions
                </button>
             {/if}
          </div>
        </div>

        <!-- Progress Bar for Categorization -->
        {#if isCategorizing}
            <div class="px-4 py-2">
                <div class="flex justify-between text-sm text-gray-600 mb-1">
                    <span>Categorizing... {catProgress.message}</span>
                    <span>{catProgress.current} / {catProgress.total}</span>
                </div>
                <div class="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                    <div class="bg-teal-500 h-2 rounded-full transition-all duration-300" style="width: {(catProgress.current / catProgress.total) * 100}%"></div>
                </div>
            </div>
        {/if}

        <!-- Thumbnails Row (Selected / Uncategorized) -->
        <div
          class="flex flex-row flex-wrap gap-4 mt-2 mb-6 p-4 min-h-[160px]"
          style="display: flex; flex-direction: row; flex-wrap: wrap;"
        >
          {#if photos.length > 0}
            <!-- EXISTING PHOTO LOOP -->
            {#each photos as photo (photo.id)}
              <div
                class="bg-white rounded-lg overflow-hidden border border-gray-200 shadow-sm relative group"
                style="width: 148px; height: 148px; flex-shrink: 0;"
              >
                <SecureImage
                  src={photo.baseUrl.includes("drive.google.com") ? `${photo.baseUrl}&sz=w800` : `${photo.baseUrl}=w400-h400-c`}
                  alt="Thumbnail"
                  className="w-full h-full object-cover"
                />
                
                <!-- Upload Status Overlay -->
                {#if uploads[photo.id]}
                    {#if uploads[photo.id].status === 'uploading'}
                        <div class="absolute inset-0 bg-black/30 flex items-center justify-center">
                            <span class="animate-spin h-6 w-6 border-2 border-white border-t-transparent rounded-full"></span>
                        </div>
                    {:else if uploads[photo.id].status === 'failed'}
                         <div class="absolute inset-0 bg-red-500/30 flex items-center justify-center" title={uploads[photo.id].error}>
                            <span class="text-white font-bold text-xl">!</span>
                        </div>
                    {/if}
                {/if}
              </div>
            {/each}
          {:else if isPolling}
            <div class="w-full text-center py-10 text-gray-500">
              <p>Selection in progress...</p>
            </div>
          {:else if isCategorizing}
             <!-- While categorizing, list empties, so this might show temporarily. -->
             <div class="w-full text-center py-10 text-gray-500 italic">Processing...</div>
          {:else}
            <div class="w-full text-center py-10 text-gray-400 italic">
              No photos queued. Select or Add photos to begin.
            </div>
          {/if}
        </div>
      </div>
      
      <!-- CATEGORIZED RESULTS -->
      {#if Object.keys(janCodeToPhotos).length > 0}
        <div class="bg-white p-6 rounded-lg shadow-md mt-8 border-t-4 border-teal-500">
            <h2 class="text-xl font-bold mb-4 text-gray-800">Categorized Photos</h2>
            <div class="border border-gray-300 rounded-lg overflow-hidden bg-white shadow-sm">
                <!-- Header -->
                <div class="flex flex-row bg-slate-200 border-b-2 border-slate-300 text-slate-700" style="display: flex; flex-direction: row;">
                    <div class="w-48 flex-none p-4 font-bold text-center uppercase tracking-wide text-sm" style="width: 200px; flex: none;">JAN Code</div>
                    <div class="flex-1 p-4 font-bold text-sm uppercase tracking-wide" style="flex: 1;">Photos</div>
                </div>
                
                {#each categorizedEntries as [jan, items], index}
                    <!-- 
                        Highlight Logic:
                        - Current Row Hover: Handled by .categorized-row:hover (CSS)
                        - Previous Row (Highlight): IF `hoveredRowIndex` is `index + 1` (the row below this one), highlight THIS one.
                        - AND `hoveredColumn` must be 'photos' as requested.
                    -->
                    <div 
                        class="flex flex-row categorized-row group" 
                        class:related-highlight={hoveredRowIndex === index + 1 && hoveredColumn === 'photos'}
                        style="display: flex; flex-direction: row relative;"
                        on:mouseleave={() => { hoveredRowIndex = null; hoveredColumn = null; }}
                    >
                        <!-- JAN Column -->
                        <div 
                            class="w-48 flex-none p-4 font-mono text-lg font-medium text-teal-700 break-all bg-gray-50/50 group-hover:bg-transparent transition-colors z-10"
                            class:bg-red-100={!isValidJan(jan)} 
                            class:text-red-800={!isValidJan(jan)}
                            style="width: 200px; flex: none; display: flex; align-items: center; justify-content: center; border-right: 1px solid #e2e8f0; { !isValidJan(jan) ? 'background-color: #fee2e2;' : '' }"
                            on:mouseenter={() => { hoveredRowIndex = index; hoveredColumn = 'jan'; }}
                        >
                            <input 
                                type="text" 
                                value={jan} 
                                class="editable-jan"
                                on:blur={(e) => handleJanRename(jan, e.currentTarget.value)}
                                on:keyup={(e) => handleInputKey(e, jan)}
                            />
                        </div>
                        
                        <!-- Photos Column: The Merge Trigger Zone -->
                        <div 
                            class="flex-1 p-4 min-w-0 relative" 
                            style="flex: 1; min-width: 0; position: relative;"
                            on:mouseenter={() => { hoveredRowIndex = index; hoveredColumn = 'photos'; }}
                        >
                            <!-- Merge Trigger Button (Only if NOT the first row) -->
                            {#if hoveredRowIndex === index && hoveredColumn === 'photos' && index > 0}
                                <button 
                                    class="absolute -top-3 right-4 bg-yellow-100 hover:bg-yellow-200 text-yellow-800 border border-yellow-300 rounded-full px-3 py-1 text-xs font-bold shadow-sm z-50 flex items-center gap-1 cursor-pointer transition-transform hover:scale-105"
                                    style="position: absolute; top: -12px; right: 16px;"
                                    on:click|stopPropagation={() => handleMergeUp(index)}
                                    title="Merge these photos into the previous group"
                                    transition:fade={{ duration: 100 }}
                                >
                                    <span>↑ Merge Up</span>
                                </button>
                            {/if}

                            <div class="flex flex-row flex-wrap gap-2 content-start w-full" style="display: flex; flex-direction: row; flex-wrap: wrap;">
                                {#each items as item}
                                    <div 
                                        class="w-14 h-14 rounded border border-gray-200 overflow-hidden relative flex-none cursor-help"
                                        style="width: 56px; height: 56px;"
                                        on:mouseenter={(e) => handleThumbnailEnter(e, item)}
                                        on:mouseleave={handleThumbnailLeave}
                                    >
                                        <SecureImage 
                                            src={item.baseUrl.includes("drive.google.com") ? `${item.baseUrl}&sz=w128` : `${item.baseUrl}=w128-h128-c`}
                                            className="w-full h-full object-cover"
                                        />
                                        <!-- Show upload status here too -->
                                        {#if uploads[item.id]}
                                            {#if uploads[item.id].status === 'uploading'}
                                                <div class="absolute inset-0 bg-black/30 flex items-center justify-center">
                                                    <span class="animate-spin h-3 w-3 border-2 border-white border-t-transparent rounded-full"></span>
                                                </div>
                                            {:else if uploads[item.id].status === 'failed'}
                                                <div class="absolute inset-0 bg-red-500/30 flex items-center justify-center">!</div>
                                            {/if}
                                        {/if}
                                    </div>
                                {/each}
                            </div>
                        </div>
                    </div>
                {/each}
            </div>
        </div>
      {/if}
      
    {/if}
  </div>
</div>

<style>
    .categorized-row {
        border-bottom: 1px solid #e2e8f0;
        transition: background-color 0.1s;
    }
    .categorized-row:hover {
        background-color: #eff6ff; /* blue-50 */
    }
    .related-highlight {
        background-color: #fef9c3 !important; /* yellow-100 */
        border: 2px dashed #facc15 !important; /* yellow-400 */
    }
    
    .editable-jan {
        width: 100%;
        text-align: center;
        background-color: transparent;
        border: 1px solid transparent; /* Reserve space for border */
        border-radius: 4px;
        padding: 2px 4px;
        outline: none;
        transition: all 0.2s;
    }
    .editable-jan:hover {
        background-color: white;
        border-color: #d1d5db; /* gray-300 */
    }
    .editable-jan:focus {
        background-color: white;
        border-color: #14b8a6; /* teal-500 */
        box-shadow: 0 0 0 1px #14b8a6;
    }
    /* Let's fix the highlighting logic in the HTML block instead of CSS tricks */
</style>
