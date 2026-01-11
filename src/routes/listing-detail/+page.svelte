<script lang="ts">
  import { page } from '$app/stores';
  import { store } from '$lib/store';
  import { update_listing, add_listing_image, remove_listing_image, type ListingImage } from '$lib/listings-slice';
  import { update_proposal_field, approve_proposal_thunk, regenerate_title, regenerate_description } from '$lib/listing-creation-slice';
  import { update_field } from '$lib/inventory';
  import { goto } from '$app/navigation';
  import { broadcast } from '$lib/redux-firestore';
  import { firestore } from '$lib/firebase';
  import { user } from '$lib/user-store';
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
  
  $: {
      if (mode === 'create' && janCode) {
          // --- Creation Mode ---
          console.log("[ListingDetail] Mode: create, JAN:", janCode);
          const proposal = $store.listingCreation.proposals[janCode];
          console.log("[ListingDetail] Found Proposal:", proposal);
          if (proposal) {
              listingData = {
                  title: proposal.title,
                  bodyHtml: proposal.bodyHtml,
                  option1Name: proposal.option1Name,
                  titlePrompt: proposal.titlePrompt,
                  descriptionPrompt: proposal.descriptionPrompt
              };
              
              // Loading flags
              isGeneratingTitle = !!proposal.isGeneratingTitle;
              isGeneratingDescription = !!proposal.isGeneratingDescription;
              
              // Load associated items (and override price if proposal has draft price)
              associatedItems = proposal.inventoryItemIds.map((id: string) => {
                   const item = $store.inventory.idToItem[id];
                   if (!item) return null;
                   return { 
                       ...item, 
                       id,
                       price: proposal.price !== undefined ? proposal.price : item.price 
                   };
              }).filter((x: any): x is NonNullable<typeof x> => !!x);
              
              // Images: Use baseUrl. SecureImage handles resizing/fetching.
              // Note: SecureImage needs just the base url usually, or full url.
              // If we appended =w1024 before, SecureImage might handle it if it's just a query param.
              const photos = $store.photos.janCodeToPhotos[janCode] || [];
              listingImages = photos.map((p: any, idx: number) => ({
                  id: p.id,
                  url: p.baseUrl || '', // SecureImage will assume it needs auth if it's a google URL
                  position: idx,
                  altText: p.filename || 'Product Image'
              }));
          } else {
              listingData = null;
          }
      } else {
          // ... (Live mode remains same)
          const liveListing = $store.listings.handleToListing[handle];
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
              store.dispatch(regenerate_title(janCode, customPrompt));
          } else {
              store.dispatch(regenerate_description(janCode, customPrompt));
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
      if (mode === 'create') {
          store.dispatch(update_proposal_field({ janCode, field: 'title', value: e.detail }));
      } else {
           broadcast(firestore, $user.uid, update_listing({ handle, changes: { title: e.detail } }));
      }
  }

  function handleUpdateDescription(e: CustomEvent<string>) {
       if (!$user.uid) return;
       if (mode === 'create') {
          store.dispatch(update_proposal_field({ janCode, field: 'bodyHtml', value: e.detail }));
       } else {
           broadcast(firestore, $user.uid, update_listing({ handle, changes: { bodyHtml: e.detail } }));
       }
  }

  function handleUpdatePrice(e: CustomEvent<number>) {
      if (!$user.uid) return;
      const newPrice = e.detail;

      if (mode === 'create') {
          // Draft Mode: Update Redux state only
          store.dispatch(update_proposal_field({ janCode, field: 'price', value: newPrice }));
      } else {
          // Live Mode: Update inventory directly
          associatedItems.forEach(item => {
              broadcast(firestore, $user.uid, update_field({ id: item.id, field: 'price', value: newPrice }));
          });
      }
  }
  
  // Image Deletion
  function handleDeleteImage(e: CustomEvent<any>) {
      if (mode === 'create') {
          alert("Deleting images in draft mode not fully implemented");
      } else {
          if (!$user.uid) return;
          broadcast(firestore, $user.uid, remove_listing_image({ handle, imageId: e.detail.id }));
      }
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
                   if (uploadingImageId && replacingImagePosition !== null) {
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
          store.dispatch(approve_proposal_thunk(janCode));
          goto('/listings/create');
      }
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
               <button class="back-btn" on:click={() => goto('/listings/create')}>Back to Batch</button>
               
               <!-- Quick Batch Nav -->
               {#if activeBatchJans.length > 0}
               <div class="mini-nav">
                    <button class="icon-btn" disabled={!prevJan} on:click={() => prevJan && goToJan(prevJan)}>←</button>
                    <span class="step-text">{currentIndex + 1} / {activeBatchJans.length}</span>
                    <button class="icon-btn" disabled={!nextJan} on:click={() => nextJan && goToJan(nextJan)}>→</button>
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
                       <button class="ai-btn" disabled={isGeneratingTitle} on:click={() => store.dispatch(regenerate_title(janCode))}>
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
                       <button class="ai-btn" disabled={isGeneratingDescription} on:click={() => store.dispatch(regenerate_description(janCode))}>
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
  .icon-btn { padding: 0.5rem; border: 1px solid #e5e7eb; border-radius: 4px; background: white; cursor: pointer; min-width: 32px; }
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
</style>
