<script lang="ts">
  import { page } from "$app/stores";
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { store } from "$lib/store";
  import { initiate_upload, complete_upload } from "$lib/photos-slice";
  import { ensureFolderStructure, uploadImageToDrive, getStoredToken, initiateOAuthFlow } from "$lib/google-drive";
  import Navigation from "$lib/components/Navigation.svelte";

  import SecureImage from "$lib/components/SecureImage.svelte";
  import ImageThumbnail from "$lib/components/ImageThumbnail.svelte";
  
  import { broadcast } from "$lib/redux-firestore";
  import { firestore } from "$lib/firebase";
  import { user } from "$lib/user-store";

  // Actions are dispatched via broadcast to ensure persistence
  
  // Get ID from URL
  $: photoId = $page.url.searchParams.get("id") || "";
  
  // Select data from Redux via auto-subscription
  // $store gives the state
  
  $: urlHistory = $store.photos.urlHistory?.[photoId] || [];
  $: selectedItem = $store.photos.selected?.find((p: any) => p.id === photoId);
  $: categorizedItem = findCategorizedItem(photoId, $store.photos.janCodeToPhotos);
  $: item = selectedItem || categorizedItem;
  
  function findCategorizedItem(id: string, map: Record<string, any[]>): any {
      if (!map) return null;
      for (const key in map) {
          const found = map[key].find(p => p.id === id);
          if (found) return found;
      }
      return null;
  }

  let fileInput: HTMLInputElement;
  let uploading = false;
  let uploadError = "";

  async function handleFileUpload(event: Event) {
      const target = event.target as HTMLInputElement;
      if (!target.files || target.files.length === 0) return;
      
      const file = target.files[0];
      uploading = true;
      uploadError = "";

      try {
          // 1. Auth Check
          const token = getStoredToken();
          if (!token) {
              initiateOAuthFlow();
              return;
          }

          // 2. Ensure Folder Structure
          const folders = await ensureFolderStructure(token.access_token);
          
      // 3. Initiate Upload State
          if (!photoId) throw new Error("No Photo ID");
          store.dispatch(initiate_upload({ id: photoId, timestamp: Date.now() }));

          // 4. Upload to "Processed"
          const result = await uploadImageToDrive(file, `replaced_${photoId}_${Date.now()}.jpg`, folders.processedId, token.access_token);
          
          // 5. Complete Upload & Update History
          // 5. Complete Upload & Update History
          const action = complete_upload({ 
              id: photoId, 
              // Use thumbnailLink for the permanent URL as it renders an image. 
              // webViewLink is the Drive UI viewer.
              permanentUrl: result.thumbnailLink || result.webViewLink, 
              webViewLink: result.webViewLink 
          });

          if ($user.uid) {
              broadcast(firestore, $user.uid, action);
          } else {
              // Fallback for unauthenticated/testing? Or just dispatch locally.
              store.dispatch(action);
          }
          
          // Clear input
          if (fileInput) fileInput.value = "";
          
      } catch (e: any) {
          console.error("Upload failed", e);
          uploadError = e.message;
      } finally {
          uploading = false;
      }
  }

  async function handleMakeCurrent(url: string) {
      if (!photoId) return;
      // Re-dispatching as a completed upload effectively pushes this URL to the front
      // Re-dispatching as a completed upload effectively pushes this URL to the front
      const action = complete_upload({
          id: photoId,
          permanentUrl: url,
          webViewLink: url 
      });

      if ($user.uid) {
          broadcast(firestore, $user.uid, action);
      } else {
          store.dispatch(action);
      }
  }
</script>

<div class="min-h-screen bg-gray-50 flex flex-col">
  <Navigation />
  
  <main class="flex-1 p-8 max-w-6xl mx-auto w-full">
    <!-- Header -->
    <div class="flex items-center justify-between mb-8">
      <button 
        class="text-gray-500 hover:text-gray-700 flex items-center gap-2"
        on:click={() => goto('/photos')}
      >
        ← Back to Photos
      </button>
      <h1 class="text-2xl font-bold text-gray-900">Photo History</h1>
    </div>

    {#if !photoId}
        <div class="p-8 text-center text-gray-500">No Photo ID provided</div>
    {:else if !item && urlHistory.length === 0}
        <div class="p-8 text-center text-gray-500">Photo not found in session state.</div>
    {:else}
        <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
            <!-- Current State (Left/Main) -->
            <div class="md:col-span-2 bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <h2 class="text-xl font-semibold mb-4">Current Image</h2>
                {#if urlHistory.length > 0}
                    <!-- Current Image: Max size 300x300, contained -->
                    <div class="flex justify-center mb-8">
                        <ImageThumbnail 
                            src={urlHistory[0]} 
                            alt="Current" 
                            width="300px" 
                            height="300px" 
                            fit="contain"
                        />
                    </div>
                     <div class="mt-4 text-xs text-gray-400 font-mono break-all text-center">
                        {urlHistory[0]}
                    </div>
                {:else}
                     <div class="p-12 text-center text-gray-400">No URL history available</div>
                {/if}

                <!-- Replacement Action -->
                <div class="mt-8 pt-6 border-t border-gray-100">
                    <h3 class="font-medium text-gray-900 mb-2">Replace Image</h3>
                    <p class="text-sm text-gray-500 mb-4">Upload an alternate image. This will become the new current active image for this photo ID.</p>
                    
                    <div class="flex items-center gap-4">
                        <input 
                            type="file" 
                            accept="image/*" 
                            class="hidden"
                            bind:this={fileInput}
                            on:change={handleFileUpload}
                        />
                        <button 
                            class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            on:click={() => fileInput.click()}
                            disabled={uploading}
                        >
                            {uploading ? 'Uploading...' : 'Upload Alternate'}
                        </button>
                        {#if uploadError}
                            <span class="text-red-500 text-sm">{uploadError}</span>
                        {/if}
                    </div>
                </div>
            </div>

            <!-- History Timeline (Right) -->
            <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 h-fit">
                <h2 class="text-xl font-semibold mb-6">History</h2>
                
                {#if urlHistory.length === 0}
                    <div class="text-gray-400 italic">No history recorded</div>
                {/if}

                <div class="space-y-6 relative border-l-2 border-slate-200 ml-3">
                  {#each urlHistory as url, i}
                    <div class="relative flex items-start pl-6 group">
                         <!-- Dot -->
                        <div class="absolute -left-[9px] top-4 flex items-center justify-center w-5 h-5 rounded-full border-2 border-white bg-slate-300 group-first:bg-indigo-600 shadow z-10">
                        </div>
                        
                        <!-- Content -->
                        <div class="ml-4 w-full p-4 rounded-lg border border-gray-200 bg-white shadow-sm">
                             <div class="flex items-center gap-3 mb-2">
                                 <span class="text-xs font-bold uppercase text-gray-400">
                                     {i === 0 ? 'Current Version' : 'Previous Version'}
                                 </span>
                             </div>
                             
                             <!-- Timeline Image: Fixed 200x120, contained -->
                             <div class="flex justify-center mb-2">
                                 <ImageThumbnail 
                                     src={url} 
                                     alt="History Item" 
                                     width="200px" 
                                     height="120px" 
                                     fit="contain"
                                 />
                             </div>
                             
                             <div class="text-xs text-gray-500 truncate font-mono mb-2">
                                 {url}
                             </div>

                             {#if i > 0}
                                <button 
                                    class="w-full text-xs py-1 px-2 border border-gray-300 rounded hover:bg-gray-50 text-gray-600 transition-colors"
                                    on:click={() => handleMakeCurrent(url)}
                                >
                                    Make Current
                                </button>
                             {/if}
                        </div>
                    </div>
                  {/each}
                </div>
            </div>
        </div>
    {/if}
  </main>
</div>

<style>
    /* Styles removed in favor of Tailwind utility classes */
</style>
