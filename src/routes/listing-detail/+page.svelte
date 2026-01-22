<script lang="ts">
  import { page } from '$app/stores';
  import { store } from '$lib/store';
  import { update_listing, add_listing_image, remove_listing_image, type ListingImage } from '$lib/listings-slice';
  import { 
      approve_proposal_thunk, 
      regenerate_title, 
      regenerate_description, 
      update_proposal_field,
      add_listing_only_image,
      remove_listing_only_image,
      set_current_step,
      remove_proposal,
      complete_batch
  } from "$lib/listing-creation-slice";
  import { update_field } from '$lib/inventory';
  import { goto } from '$app/navigation';
  import { broadcast } from '$lib/redux-firestore';
  import { firestore } from '$lib/firebase';
  import { user } from '$lib/user-store';
  import { generateHandle } from "$lib/handle-utils";
  import { ensureFolderStructure, uploadImageToDrive, getStoredToken, initiateOAuthFlow } from '$lib/google-drive';
  import ListingEditor from '$lib/components/ListingEditor.svelte';

  // --- State ---
  $: mode = $page.url.searchParams.get('mode');
  $: janCode = $page.url.searchParams.get('janCode') || $page.url.searchParams.get('jan');
  $: handle = $page.url.searchParams.get('handle');

  // Batch Navigation State
  $: activeBatchJans = $store.listingCreation.activeBatchJans || [];
  $: currentIndex = activeBatchJans.indexOf(janCode || '');
  $: prevJan = currentIndex > 0 ? activeBatchJans[currentIndex - 1] : null;
  $: nextJan = currentIndex >= 0 && currentIndex < activeBatchJans.length - 1 ? activeBatchJans[currentIndex + 1] : null;

  let searchTerm = '';
  let matchingHandles: string[] = [];
  let fileInput: HTMLInputElement;
  
  // Prompt Modal State
  let showPromptModal = false;
  let promptTarget: 'title' | 'description' | null = null;
  let customPrompt = "";

  // Image Picker State (Listing Photos)
  let showImagePicker = false;
  let imagePickerTargetJan: string | null = null;
  
  // AI Loading State
  let isGeneratingTitle = false;
  let isGeneratingDescription = false;
  
  // Polymorphic Data Load
  let listingData: { 
      title: string; 
      bodyHtml: string; 
      option1Name?: string;
      titlePrompt?: string;
      descriptionPrompt?: string;
  } | null = null;

  let listingImages: ListingImage[] = [];
  let associatedItems: any[] = []; 
  
  // Image Upload State
  let uploadingImageId: string | null = null;
  let replacingImagePosition: number | null = null;
  let replacingSubtypeId: string | null = null;
  let targetProposalJan: string | null = null;
  
  $: {
      if (mode === 'create' && janCode) {
          // --- Creation Mode ---
          const primaryProposal = $store.listingCreation.proposals[janCode];
          
          if (primaryProposal) {
              // 1. Identify Handle Group
              const primaryHandle = primaryProposal.handle || generateHandle(primaryProposal.title, primaryProposal.janCode);
              
              // 2. Find all proposals in this group (Aggregation)
              const siblingProposals = Object.values($store.listingCreation.proposals)
                  .filter((p: any) => {
                      // Only check active batch if filtered, or all drafts? 
                      // Ideally we check all "in batch". But proposals are global.
                      // Let's just catch all with same handle.
                      const h = p.handle || generateHandle(p.title, p.janCode);
                      return h === primaryHandle;
                  });

              listingData = {
                  title: primaryProposal.title,
                  bodyHtml: primaryProposal.bodyHtml,
                  option1Name: primaryProposal.option1Name,
                  titlePrompt: primaryProposal.titlePrompt,
                  descriptionPrompt: primaryProposal.descriptionPrompt
              };
              
              isGeneratingTitle = !!primaryProposal.isGeneratingTitle;
              isGeneratingDescription = !!primaryProposal.isGeneratingDescription;
              
              associatedItems = [];
              const allPhotos: any[] = [];
              const seenItemIds = new Set<string>();
              const seenPhotoIds = new Set<string>();

              // 3. Flatten Items & Photos from ALL siblings
              siblingProposals.forEach((p: any) => {
                  // Items
                  p.inventoryItemIds.forEach((id: string) => {
                       if (seenItemIds.has(id)) return;
                       seenItemIds.add(id);

                       const item = $store.inventory.idToItem[id];
                       if (item) {
                           associatedItems.push({
                               ...item,
                               id,
                               price: p.price !== undefined ? p.price : item.price 
                           });
                       }
                  });

                  // Photos
                  const pPhotos = $store.photos.janCodeToPhotos[p.janCode] || [];
                  pPhotos.forEach((ph: any) => {
                      // Dedupe photos? Usually scoped by Jan.
                      // But merged listing should show ALL.
                      // ID might not be unique if same file object used?
                      // Using filename + byteSize as unique key or just URL?
                      // Drive file ID is best.
                      if (!seenPhotoIds.has(ph.id)) {
                          seenPhotoIds.add(ph.id);
                          allPhotos.push(ph);
                      }
                  });
              });

              const listingOnly = primaryProposal.listingOnlyImages || [];
              const photoImages = allPhotos.map((p: any, idx: number) => ({
                  id: p.id,
                  url: p.baseUrl || '', 
                  position: idx,
                  altText: p.filename || 'Product Image'
              }));
              const mergedImages = [...photoImages, ...listingOnly];
              mergedImages.forEach((img, idx) => img.position = idx + 1);
              listingImages = mergedImages;
          } else {
              listingData = null;
          }
      } else {
          // ... (Live mode remains same)
          const liveListing = handle ? $store.listings.handleToListing[handle] : null;
          if (liveListing) {
              listingData = liveListing;
              listingImages = liveListing.images;
              associatedItems = Object.entries($store.listings.idToHandle || {})
                  .filter(([id, h]) => h === handle)
                  .map(([id]) => {
                      const item = $store.inventory.idToItem[id];
                      return item ? { ...item, id } : null;
                  })
                  .filter((item): item is NonNullable<typeof item> => !!item);
          } else {
              listingData = null;
          }
      }
  }

  function dispatchBroadcast(action: any) {
    if ($user && $user.uid) {
        broadcast(firestore, $user.uid, action);
    } else {
        console.warn("User not authenticated, falling back to local dispatch");
        store.dispatch(action);
    }
  }

  // Sync Step Index if in Batch
  let isExiting = false;
  $: if (!isExiting && mode === 'create' && janCode && activeBatchJans.length > 0) {
      const idx = activeBatchJans.indexOf(janCode);
      const currentStepIndex = $store.listingCreation.currentStepIndex;
      if (idx !== -1 && idx !== currentStepIndex) {
          dispatchBroadcast(set_current_step(idx));
      }
  }

  // --- Actions ---

  // AI Prompt Logic
  function openPromptModal(target: 'title' | 'description') {
      promptTarget = target;
      
      // Load persisted prompt or default
      if (listingData) {
          const globalState = $store.listingCreation;
          if (target === 'title') {
              customPrompt = globalState.globalTitlePrompt || "Generate a concise, catchy product title. Return ONLY the title text.";
          } else {
              customPrompt = globalState.globalDescriptionPrompt || "Write a playful product description in HTML.";
          }
      }
      showPromptModal = true;
  }
  
  function handleRunPrompt() {
      if (mode === 'create' && janCode && promptTarget) {
          if (promptTarget === 'title') {
              regenerate_title(janCode, customPrompt)(dispatchBroadcast, store.getState, undefined);
          } else {
              regenerate_description(janCode, customPrompt)(dispatchBroadcast, store.getState, undefined);
          }
      }
      showPromptModal = false;
  }
  
  function goToJan(targetJan: string) {
      goto(`/listing-detail?mode=create&jan=${targetJan}`);
  }

  // Subtype Selection
  let selectedSubtypeId: string | null = null;
  $: if (associatedItems.length > 0 && selectedSubtypeId === null) {
      selectedSubtypeId = associatedItems[0].id;
  }
  
  function handleSelectSubtype(e: CustomEvent<string>) {
      selectedSubtypeId = e.detail;
  }

  // Updates
  function handleUpdateTitle(e: CustomEvent<string>) {
      if (!$user.uid) return;
      if (mode === 'create' && janCode) {
          dispatchBroadcast(update_proposal_field({ janCode, field: 'title', value: e.detail }));
      } else if (handle) {
           broadcast(firestore, $user.uid, update_listing({ handle, changes: { title: e.detail } }));
      }
  }

  function handleUpdateDescription(e: CustomEvent<string>) {
       if (!$user.uid) return;
       if (mode === 'create' && janCode) {
          dispatchBroadcast(update_proposal_field({ janCode, field: 'bodyHtml', value: e.detail }));
       } else if (handle) {
           broadcast(firestore, $user.uid, update_listing({ handle, changes: { bodyHtml: e.detail } }));
       }
  }

  function handleUpdatePrice(e: CustomEvent<number>) {
      const uid = $user.uid;
      if (!uid) return;
      const newPrice = e.detail;

      if (mode === 'create' && janCode) {
          // Draft Mode: Update Redux state only
          dispatchBroadcast(update_proposal_field({ janCode, field: 'price', value: newPrice }));
      } else {
          // Live Mode: Update inventory directly
          associatedItems.forEach(item => {
              if (item && item.id) {
                  broadcast(firestore, uid, update_field({ 
                      id: item.id as string, 
                      field: 'price', 
                      from: item.price || 0,
                      to: newPrice 
                  }));
              }
          });
      }
  }
  
  // Image Deletion
  function handleDeleteImage(e: CustomEvent<any>) {
      if (mode === 'create' && janCode) {
          const proposal = $store.listingCreation.proposals[janCode];
          const listingOnly = proposal?.listingOnlyImages || [];
          const isListingOnly = listingOnly.some(img => img.id === e.detail.id);
          if (isListingOnly) {
              dispatchBroadcast(remove_listing_only_image({ janCode, imageId: e.detail.id }));
          } else {
              alert("Removing JAN photos from draft is not supported yet.");
          }
          return;
      }
      if (!$user.uid || !handle) return;
      broadcast(firestore, $user.uid, remove_listing_image({ handle, imageId: e.detail.id }));
  }
  
  function handleDeleteSubtypeImage(e: CustomEvent<any>) {
      if (!$user.uid) return;
      broadcast(firestore, $user.uid, update_field({ 
          id: e.detail.id, 
          field: 'image', 
          from: e.detail.image, 
          to: '' 
      }));
  }

  // Image Upload / Replace Logic
  function handleReplaceImage(e: CustomEvent<any>) {
       const img = e.detail;
       uploadingImageId = img.id;
       replacingImagePosition = img.position;
       replacingSubtypeId = null;
       targetProposalJan = (mode === 'create') ? janCode : null;
       fileInput.click();
  }
  
  function handleReplaceSubtypeImage(e: CustomEvent<any>) {
      const item = e.detail;
      replacingSubtypeId = item.id;
      uploadingImageId = null; 
      targetProposalJan = null;
      fileInput.click();
  }
  
  async function handleFileUpload(event: Event) {
      const target = event.target as HTMLInputElement;
      if (!target.files || target.files.length === 0) return;
      
      const file = target.files[0];
      
      try {
          const token = getStoredToken();
          if (!token) {
              initiateOAuthFlow();
              return;
          }
          
          const folders = await ensureFolderStructure(token.access_token);
          const uploadKey = mode === 'create' ? janCode : handle;
          const result = await uploadImageToDrive(file, `replace_${uploadKey}_${Date.now()}.jpg`, folders.processedId, token.access_token);
          const newUrl = result.thumbnailLink || result.webViewLink;

          if ($user.uid) {
              if (replacingSubtypeId) {
                  const item = associatedItems.find(i => i.id === replacingSubtypeId);
                  if (item) {
                       broadcast(firestore, $user.uid, update_field({
                          id: item.id,
                          field: 'image',
                          from: item.image,
                          to: newUrl
                      }));
                  }
              } else if (mode === 'create') {
                  alert("Replacing gallery images in draft not implemented");
              } else {
                   if (uploadingImageId && replacingImagePosition !== null && handle) {
                       broadcast(firestore, $user.uid, remove_listing_image({ handle, imageId: uploadingImageId }));
                       const newImage: ListingImage = {
                           id: crypto.randomUUID(),
                           url: newUrl,
                           position: replacingImagePosition,
                           altText: listingData?.title || ''
                       };
                       broadcast(firestore, $user.uid, add_listing_image({ handle, image: newImage }));
                   }
              }
          }
      } catch (e) {
          console.error("Upload failed", e);
          alert("Failed to upload image. Check console.");
      } finally {
          uploadingImageId = null;
          replacingImagePosition = null;
          replacingSubtypeId = null;
          targetProposalJan = null;
          if (fileInput) fileInput.value = "";
      }
  }

  // Approval
  function handleApprove() {
      if (mode === 'create' && janCode) {
          approve_proposal_thunk(janCode)(dispatchBroadcast, store.getState, undefined);
          goto('/listings/create');
      }
  }

  function openImagePicker() {
      if (mode !== 'create' || !janCode) return;
      imagePickerTargetJan = janCode;
      showImagePicker = true;
  }

  function buildImagePickerCandidates() {
      if (mode !== 'create' || !janCode) return [];
      const primary = $store.listingCreation.proposals[janCode];
      if (!primary) return [];
      const handleKey = primary.handle || generateHandle(primary.title, primary.janCode);
      const proposals = Object.values($store.listingCreation.proposals);
      const siblings = proposals.filter((p: any) => {
          const h = p.handle || generateHandle(p.title, p.janCode);
          return h === handleKey;
      });

      const candidates = new Map<string, { id: string; url: string; altText: string }>();
      const janPhotos = $store.photos.janCodeToPhotos?.[janCode] || [];
      janPhotos.forEach((p: any, idx: number) => {
          const url = p.baseUrl || p.thumbnailLink || p.productUrl;
          if (!url) return;
          candidates.set(url, { id: p.id || `jan-${idx}`, url, altText: p.filename || 'JAN photo' });
      });

      siblings.forEach((p: any) => {
          p.inventoryItemIds.forEach((id: string) => {
              const item = $store.inventory.idToItem[id];
              if (!item?.image) return;
              const url = item.image;
              if (!candidates.has(url)) {
                  candidates.set(url, { id: `variant-${id}`, url, altText: item.subtype || 'Variant image' });
              }
          });
      });

      return Array.from(candidates.values());
  }

  function handlePickListingImage(candidate: { id: string; url: string; altText: string }) {
      if (!imagePickerTargetJan) return;
      const imageId = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
          ? crypto.randomUUID()
          : `img-${Date.now()}`;
      const image = {
          id: imageId,
          url: candidate.url,
          altText: candidate.altText || '',
          position: listingImages.length + 1
      };
      dispatchBroadcast(add_listing_only_image({ janCode: imagePickerTargetJan, image }));
      showImagePicker = false;
      imagePickerTargetJan = null;
  }

  function handleDrop() {
      if (mode !== 'create' || !janCode) return;
      const stateBefore = store.getState().listingCreation;
      const currentIndex = stateBefore.activeBatchJans.indexOf(janCode);

      dispatchBroadcast(remove_proposal({ janCode }));

      const stateAfter = store.getState().listingCreation;
      const remaining = stateAfter.activeBatchJans;
      if (remaining.length === 0) {
          dispatchBroadcast(complete_batch());
          goto('/listings/create');
          return;
      }

      let nextIndex = currentIndex;
      if (nextIndex < 0) nextIndex = 0;
      if (nextIndex >= remaining.length) nextIndex = 0;

      const nextJan = remaining[nextIndex];
      dispatchBroadcast(set_current_step(nextIndex));
      goto(`/listing-detail?mode=create&jan=${nextJan}`);
  }

  // Search (Live Mode)
  function handleSearch() {
       if (!searchTerm) {
           matchingHandles = [];
           return;
       }
       const q = searchTerm.toLowerCase();
       matchingHandles = Object.keys($store.listings.handleToListing).filter(h => h.toLowerCase().includes(q));
       
       if (matchingHandles.length === 1) {
           goto(`/listing-detail?mode=live&handle=${matchingHandles[0]}`);
           searchTerm = '';
           matchingHandles = [];
       }
  }
  
  function selectHandle(h: string) {
       goto(`/listing-detail?mode=live&handle=${h}`);
       searchTerm = '';
       matchingHandles = [];
  }

</script>

<div class="container">
  <!-- Header / Navigation -->
  {#if mode === 'live'}
  <div class="search-header">
      <div class="search-bar-row">
           <input 
              class="search-input" 
              type="text" 
              placeholder="Search by handle..." 
              bind:value={searchTerm}
              on:input={handleSearch}
              on:keydown={(e) => e.key === 'Enter' && handleSearch()}
           />
           <button class="back-btn" on:click={() => goto('/shopify-products')}>Back to List</button>
      </div>
      {#if matchingHandles.length > 0 && searchTerm}
          <div class="search-results">
              {#each matchingHandles as h}
                  <button class="result-item" on:click={() => selectHandle(h)}>
                      {h}
                  </button>
              {/each}
          </div>
      {/if}
  </div>
  {:else}
       <div class="search-header">
           <div class="nav-row">
               <button class="back-btn" on:click={() => {
                    isExiting = true;
                    dispatchBroadcast(set_current_step(-1));
                    goto('/listings/create');
                }}>Back to Batch</button>
               
               <!-- Quick Batch Nav -->
               {#if activeBatchJans.length > 0}
               <div class="mini-nav">
                    <button class="icon-btn" disabled={!prevJan} on:click={() => prevJan && goToJan(prevJan)} aria-label="Previous item">
                         <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
                              <path d="M15 18l-6-6 6-6" />
                         </svg>
                    </button>
                    <span class="step-text">{currentIndex + 1} / {activeBatchJans.length}</span>
                    <button class="icon-btn" disabled={!nextJan} on:click={() => nextJan && goToJan(nextJan)} aria-label="Next item">
                         <svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
                              <path d="M9 6l6 6-6 6" />
                         </svg>
                    </button>
               </div>
               {/if}
           </div>
       </div>
  {/if}

  {#if listingData}
  
      <!-- AI Controls (Creation Mode Only) -->
      {#if mode === 'create'}
          <div class="ai-controls-toolbar">
               <div class="ai-group">
                   <span class="label">AI Tools:</span>
                   
                   <div class="btn-group">
                       <button class="ai-btn" disabled={isGeneratingTitle} on:click={() => janCode && regenerate_title(janCode)(dispatchBroadcast, store.getState, undefined)}>
                           {#if isGeneratingTitle}
                               <span class="spinner small"></span>
                           {:else}
                               ↻
                           {/if} Title
                       </button>
                       <button class="ai-btn icon-only" disabled={isGeneratingTitle} on:click={() => openPromptModal('title')} title="Edit Prompt">✎</button>
                   </div>
                   
                   <span class="sep">|</span>
                   
                   <div class="btn-group">
                       <button class="ai-btn" disabled={isGeneratingDescription} on:click={() => janCode && regenerate_description(janCode)(dispatchBroadcast, store.getState, undefined)}>
                           {#if isGeneratingDescription}
                               <span class="spinner small"></span>
                           {:else}
                               ↻
                           {/if} Desc
                       </button>
                       <button class="ai-btn icon-only" disabled={isGeneratingDescription} on:click={() => openPromptModal('description')} title="Edit Prompt">✎</button>
                   </div>
               </div>
          </div>
          <div class="image-tools-toolbar">
               <button class="ai-btn" on:click={openImagePicker}>Add Listing Photo</button>
          </div>
      {/if}

      <ListingEditor
          listing={listingData}
          images={listingImages}
          associatedItems={associatedItems}
          bind:selectedSubtypeId
          readOnly={false}
          isCreationMode={mode === 'create'}
          isGeneratingTitle={isGeneratingTitle}
          isGeneratingDescription={isGeneratingDescription}
          on:updateTitle={handleUpdateTitle}
          on:updateDescription={handleUpdateDescription}
          on:updatePrice={handleUpdatePrice}
          on:deleteImage={handleDeleteImage}
          on:selectSubtype={handleSelectSubtype}
          on:deleteSubtypeImage={handleDeleteSubtypeImage}
          on:replaceImage={handleReplaceImage}
          on:replaceSubtypeImage={handleReplaceSubtypeImage}
          on:approve={handleApprove}
          on:drop={handleDrop}
      />
      
      <!-- Batch Navigation Footer -->
      {#if mode === 'create' && activeBatchJans.length > 0}
          <div class="batch-nav-bar">
               <button class="nav-btn" disabled={!prevJan} on:click={() => prevJan && goToJan(prevJan)}>← Previous Item</button>
               <button class="nav-btn" disabled={!nextJan} on:click={() => nextJan && goToJan(nextJan)}>Next Item →</button>
          </div>
      {/if}

  {:else if (mode === 'live' && handle) || (mode === 'create' && janCode)}
      <div class="not-found">
          <p class="not-found-text">
              {#if mode === 'create'}
                  Proposal not found for JAN: <span class="handle-text">{janCode}</span>
              {:else}
                  Listing not found for handle: <span class="handle-text">{handle}</span>
              {/if}
          </p>
          <button class="link-btn" on:click={() => goto(mode === 'create' ? '/listings/create' : '/shopify-products')}>Return</button>
      </div>
  {:else}
       <div class="empty-state">
          <p class="empty-text">Search for a listing or start a creation batch.</p>
      </div>
  {/if}

  {#if showImagePicker}
      <div class="modal-backdrop">
          <div class="modal image-picker-modal">
              <h3 class="modal-title">Select listing image</h3>
              <div class="image-picker-grid">
                  {#each buildImagePickerCandidates() as candidate}
                      <button class="image-picker-item" on:click={() => handlePickListingImage(candidate)}>
                          <img src={candidate.url} alt={candidate.altText} />
                      </button>
                  {/each}
              </div>
              <div class="modal-actions flex justify-end gap-2">
                  <button class="btn-cancel" on:click={() => { showImagePicker = false; imagePickerTargetJan = null; }}>Cancel</button>
              </div>
          </div>
      </div>
  {/if}

  <!-- Hidden File Input for Replacements -->
  <input 
      type="file" 
      accept="image/*" 
      class="hidden-input"
      bind:this={fileInput}
      on:change={handleFileUpload}
  />
  
  <!-- Prompt Modal -->
  {#if showPromptModal}
      <div class="modal-backdrop">
          <div class="modal">
              <h3 class="font-bold text-lg mb-4">Custom AI Prompt for {promptTarget === 'title' ? 'Title' : 'Description'}</h3>
              <textarea 
                bind:value={customPrompt} 
                rows="4"
                class="w-full border p-2 rounded mb-4"
                placeholder="Enter your instructions for the AI..."
              ></textarea>
              <div class="modal-actions flex justify-end gap-2">
                  <button class="px-4 py-2 border rounded hover:bg-gray-100" on:click={() => showPromptModal = false}>Cancel</button>
                  <button class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700" on:click={handleRunPrompt}>Generate</button>
              </div>
          </div>
      </div>
  {/if}
</div>

<style>
  .container { max-width: 1200px; margin: 0 auto; padding: 2rem; font-family: sans-serif; color: #333; }
  .hidden-input { display: none; }

  /* Navigation & Toolbar */
  .search-header { margin-bottom: 2rem; display: flex; flex-direction: column; gap: 0.5rem; position: relative; }
  .search-bar-row { display: flex; gap: 0.5rem; }
  .nav-row { display: flex; justify-content: space-between; align-items: center; width: 100%; }
  
  .mini-nav { display: flex; align-items: center; gap: 1rem; }
  .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: 1px solid #e5e7eb; border-radius: 4px; background: white; cursor: pointer; padding: 0; }
  .nav-icon { width: 14px; height: 14px; stroke: currentColor; stroke-width: 2; fill: none; stroke-linecap: round; stroke-linejoin: round; }
  .icon-btn:hover:not(:disabled) { background: #f3f4f6; }
  .icon-btn:disabled { color: #ccc; cursor: default; }
  .step-text { font-size: 0.9rem; font-weight: 500; color: #666; }

  .search-input { border: 1px solid #ccc; border-radius: 4px; padding: 0.5rem 1rem; width: 100%; max-width: 400px; font-size: 1rem; }
  .search-input:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2); }
  .back-btn { background: #f3f4f6; padding: 0.5rem 1rem; border-radius: 4px; border: none; cursor: pointer; }
  .back-btn:hover { background: #e5e7eb; }
  
  .ai-controls-toolbar { margin-bottom: 1.5rem; padding: 0.75rem; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; }
  .ai-group { display: flex; align-items: center; gap: 0.5rem; }
  .label { font-weight: 600; font-size: 0.85rem; color: #166534; margin-right: 0.5rem; }
  .ai-btn { background: white; border: 1px solid #d1d5db; padding: 0.25rem 0.75rem; border-radius: 4px; font-size: 0.85rem; cursor: pointer; color: #374151; }
  .ai-btn:hover { border-color: #10b981; color: #059669; }
  .sep { color: #d1d5db; margin: 0 0.25rem; }
  
  .batch-nav-bar { margin-top: 2rem; border-top: 1px solid #e5e7eb; padding-top: 1rem; display: flex; justify-content: space-between; }
  .nav-btn { padding: 0.75rem 1.5rem; border: 1px solid #d1d5db; border-radius: 4px; background: white; cursor: pointer; font-weight: 500; }
  .nav-btn:hover:not(:disabled) { background: #f9fafb; border-color: #9ca3af; }
  .nav-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  /* Search Results */
  .search-results { position: absolute; top: 100%; left: 0; width: 100%; max-width: 400px; background: white; border: 1px solid #e5e7eb; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); border-radius: 4px; z-index: 10; max-height: 240px; overflow-y: auto; }
  .result-item { width: 100%; text-align: left; padding: 0.5rem 1rem; background: none; border: none; cursor: pointer; }
  .result-item:hover { background: #eff6ff; }
  
  .not-found, .empty-state { text-align: center; padding: 5rem 0; color: #6b7280; }
  .not-found-text, .empty-text { font-size: 1.25rem; }
  .handle-text { font-family: monospace; color: #374151; }
  .link-btn { margin-top: 1rem; color: #2563eb; background: none; border: none; text-decoration: underline; cursor: pointer; font-size: 1rem; }
  .link-btn:hover { color: #1d4ed8; }
  
  /* Modal */
  .modal-backdrop { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 50; }
  .modal { background: white; padding: 1.5rem; border-radius: 8px; width: 100%; max-width: 500px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); }
  .image-tools-toolbar { display: flex; justify-content: flex-end; margin: 0.5rem 0 1rem; }
  .image-picker-modal { max-width: 720px; }
  .image-picker-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(90px, 1fr)); gap: 0.75rem; margin-top: 1rem; max-height: 420px; overflow: auto; }
  .image-picker-item { border: 1px solid #e5e7eb; background: white; padding: 0; border-radius: 6px; overflow: hidden; cursor: pointer; }
  .image-picker-item img { width: 100%; height: 90px; object-fit: cover; display: block; }
  .image-picker-item:hover { border-color: #3b82f6; box-shadow: 0 0 0 1px #3b82f6; }
</style>
