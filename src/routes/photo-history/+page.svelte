<script lang="ts">
  import { page } from "$app/stores";
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { store } from "$lib/store";
  import { initiate_upload, complete_upload } from "$lib/photos-slice";
  import { ensureFolderStructure, uploadImageToDrive } from "$lib/google-drive";
  import { getStoredToken, initiateOAuthFlow } from "$lib/google-photos";
  import Navigation from "$lib/components/Navigation.svelte";

  import SecureImage from "$lib/components/SecureImage.svelte";
  import ImageThumbnail from "$lib/components/ImageThumbnail.svelte";
  import ManualCropModal from "$lib/components/ManualCropModal.svelte";
  import { removeBackground } from "$lib/background-removal";
  import { autoColorCorrect } from "$lib/color-correction";
  import { RawImage } from "@xenova/transformers"; // For color correct if needed or use simple canvas

  
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

  // --- Manual Operations ---
  let processingOp = ""; 
  let showCropModal = false;
  let cropTargetUrl = "";

  async function fetchSafeDataUrl(url: string): Promise<string> {
       // Helper to get a stable local Data URL (avoiding CORS taint on canvas)
       // Check if already data:
       if (url.startsWith('data:')) return url;
       
       const token = getStoredToken();
       const headers: any = {};
       
       let fetchUrl = url;
       // 1. Rewrite Drive Thumbnail URLs to API URLs
       if (fetchUrl.includes("drive.google.com/thumbnail")) {
            const match = fetchUrl.match(/id=([^&]+)/);
            if (match && match[1]) {
                fetchUrl = `https://www.googleapis.com/drive/v3/files/${match[1]}?alt=media`;
            }
       }

       // 2. Configure Headers
       // If it's the Drive API (googleapis.com), we NEED the token.
       // If it's a Photos Base URL (googleusercontent.com), we MUST NOT send the token (CORS).
       const isDriveApi = fetchUrl.includes("googleapis.com/drive");
       const isPhotosUrl = fetchUrl.includes("googleusercontent.com");
       
       if (isDriveApi) {
           if (!token) {
               throw new Error("Authentication missing. Please Switch Account to grant Drive permission.");
           }
           headers.Authorization = `Bearer ${token.access_token}`;
       } else if (token && !isPhotosUrl) {
           // For non-photos, non-drive URLs (if any), assume we attach token
           headers.Authorization = `Bearer ${token.access_token}`;
       }
              
       const res = await fetch(fetchUrl, { headers });
       if (!res.ok) throw new Error("Failed to load image source");
       const blob = await res.blob();
       
       return new Promise((resolve, reject) => {
           const reader = new FileReader();
           reader.onloadend = () => resolve(reader.result as string);
           reader.onerror = reject;
           reader.readAsDataURL(blob);
       });
  }

  async function openManualCrop(url: string) {
      try {
          // Pre-load to avoid CORS in cropper
          cropTargetUrl = await fetchSafeDataUrl(url);
          showCropModal = true;
      } catch (e: any) {
          alert("Could not load image for cropping: " + e.message);
      }
  }

  async function handleCropSave(e: CustomEvent<Blob>) {
      if (!photoId || !cropTargetUrl) return;
      const blob = e.detail;
      await uploadBlob(blob, "manual_crop");
  }

  async function handleManualOp(url: string, op: 'color' | 'bg' | 'smart_crop') {
      if (processingOp) return;
      processingOp = url + '_' + op;
      
      try {
          // 1. Get Safe Source
          const safeDataUrl = await fetchSafeDataUrl(url); // This is "data:image/png;base64,..."
          // Extract purely base64 for libraries that want it raw?
          // removeBackground takes full URL or Base64? library says:
          // "img.src = input.startsWith('data:') ? input : `data:image/png;base64,${input}`;"
          // So passing full Data URL is SAFE and handled.
          
          // autoColorCorrect also handles data: prefix?
          // "img.src = input.startsWith('data:') ? input : ..."
          // YES. Both libraries handle Data URLs.
          
          let b64Result: string | null = null;
          
          if (op === 'bg') {
             b64Result = await removeBackground(safeDataUrl);
          } else if (op === 'color') {
             b64Result = await autoColorCorrect(safeDataUrl);
          } else if (op === 'smart_crop') {
             // smartCrop returns RAW base64 (no prefix)
             const { smartCrop: runSmartCrop } = await import("$lib/background-removal");
             b64Result = await runSmartCrop(safeDataUrl);
          }
          
          if (b64Result) {
              // Result might be raw base64 or have prefix?
              // Libraries usually return raw base64 string from canvas.toDataURL().split(',')[1] based on my reading.
              // Let's normalize.
              const cleanB64 = b64Result.includes("base64,") ? b64Result.split("base64,")[1] : b64Result;
              
              const byteChars = atob(cleanB64);
              const byteNumbers = new Array(byteChars.length);
              for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
              const byteArray = new Uint8Array(byteNumbers);
              const blob = new Blob([byteArray], { type: 'image/png' });
              
              const suffix = op === 'smart_crop' ? 'crop' : op;
              await uploadBlob(blob, suffix);
          } else {
              throw new Error("No image data returned.");
          }

      } catch (e: any) {
          console.error("Manual Op Failed", e);
          alert("Error: " + e.message);
      } finally {
          processingOp = "";
      }
  }


  async function uploadBlob(blob: Blob, suffix: string) {
      if (!photoId) return;
      
      try {
          const token = getStoredToken();
          if (!token) { initiateOAuthFlow(); return; }
          
          const folders = await ensureFolderStructure(token.access_token);
          
          const filename = `manual_${suffix}_${photoId}_${Date.now()}.png`; // PNG for transparency
          const file = new File([blob], filename, { type: 'image/png' });
          
          store.dispatch(initiate_upload({ id: photoId, timestamp: Date.now() }));
          
          const result = await uploadImageToDrive(file, filename, folders.processedId, token.access_token);
          
          console.log("[Manual Upload] Result:", result);

          const safeUrl = result.thumbnailLink || result.webViewLink;
          if (!safeUrl) {
              throw new Error("Upload succeeded but returned no usable URL.");
          }

           const action = complete_upload({ 
              id: photoId, 
              permanentUrl: safeUrl, 
              webViewLink: result.webViewLink || "" 
          });

          if ($user.uid) {
              console.log("[Manual Upload] Broadcasting action via user", $user.uid);
              broadcast(firestore, $user.uid, action);
          } else {
              console.warn("[Manual Upload] No User UID! Dispatching locally only. Persistence will fail.");
              store.dispatch(action);
          }

      } catch (e) {
          console.error("Upload Blob Failed", e);
          alert("Failed to save result.");
      }
  }
</script>

<ManualCropModal 
    bind:open={showCropModal} 
    imageUrl={cropTargetUrl} 
    on:save={handleCropSave} 
/>

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
      <div class="bg-yellow-50 border border-yellow-200 text-yellow-800 p-4 rounded-md flex flex-col items-center gap-4">
          <p class="font-bold">No Photo ID provided on URL.</p>
          <button 
              class="bg-indigo-600 text-white px-4 py-2 rounded font-bold hover:bg-indigo-700 transition"
              on:click={() => goto('/photos')}
          >
              Back to Photos
          </button>
      </div>
    {:else if !item && urlHistory.length === 0}
      <div class="bg-red-50 border border-red-200 text-red-800 p-4 rounded-md flex flex-col items-center gap-4">
          <p class="font-bold">Photo not found with ID: {photoId}.</p>
          <button 
              class="bg-indigo-600 text-white px-4 py-2 rounded font-bold hover:bg-indigo-700 transition"
              on:click={() => goto('/photos')}
          >
              Back to Photos
          </button>
      </div>
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

                             <div class="flex flex-wrap gap-2 mt-3">
                                <button 
                                    class="text-[10px] font-bold px-2 py-1 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded border border-gray-300 transition-colors"
                                    on:click={() => handleMakeCurrent(url)}
                                >
                                    Make Current
                                </button>
                                <div class="w-px h-4 bg-gray-300 mx-1 self-center"></div>
                                <button 
                                    class="text-[10px] font-bold px-2 py-1 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded border border-blue-200 transition-colors"
                                    on:click={() => handleManualOp(url, 'smart_crop')}
                                    disabled={processingOp === url + '_smart_crop'}
                                >
                                    {#if processingOp === url + '_smart_crop'}...{:else}Auto Crop{/if}
                                </button>
                                <button 
                                    class="text-[10px] font-bold px-2 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded border border-indigo-200 transition-colors"
                                    on:click={() => openManualCrop(url)}
                                >
                                    Manual Crop
                                </button>
                                <button 
                                    class="text-[10px] font-bold px-2 py-1 bg-purple-50 hover:bg-purple-100 text-purple-700 rounded border border-purple-200 transition-colors"
                                    on:click={() => handleManualOp(url, 'color')}
                                    disabled={processingOp === url + '_color'}
                                >
                                    {#if processingOp === url + '_color'}...{:else}Color{/if}
                                </button>
                                <button 
                                    class="text-[10px] font-bold px-2 py-1 bg-teal-50 hover:bg-teal-100 text-teal-700 rounded border border-teal-200 transition-colors"
                                    on:click={() => handleManualOp(url, 'bg')}
                                    disabled={processingOp === url + '_bg'}
                                >
                                    {#if processingOp === url + '_bg'}...{:else}Remove BG{/if}
                                </button>
                             </div>
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
