<script lang="ts">
  import { page } from '$app/stores';
  import { store } from '$lib/store';
  import { update_listing, add_listing_image, remove_listing_image, type ListingImage } from '$lib/listings-slice';
  import { update_proposal_field, approve_proposal_thunk } from '$lib/listing-creation-slice';
  import { update_field } from '$lib/inventory';
  import { goto } from '$app/navigation';
  import { broadcast } from '$lib/redux-firestore';
  import { firestore } from '$lib/firebase';
  import { user } from '$lib/user-store';
  import { ensureFolderStructure, uploadImageToDrive, getStoredToken, initiateOAuthFlow } from '$lib/google-drive';
  import ListingEditor from '$lib/components/ListingEditor.svelte';

  // --- State ---
  let searchTerm = '';
  let matchingHandles: string[] = [];
  let fileInput: HTMLInputElement;
  
  // Upload State
  let uploadingImageId: string | null = null;
  let replacingImagePosition: number | null = null;
  let replacingSubtypeId: string | null = null; // If set, we are updating an inventory item image
  let targetProposalJan: string | null = null; // If set, we are uploading for a proposal

  // --- Derived State ---
  $: mode = $page.url.searchParams.get('mode') || 'live'; // 'live' | 'create'
  $: handle = $page.url.searchParams.get('handle') || ''; // Used for live mode
  $: janCode = $page.url.searchParams.get('jan') || ''; // Used for create mode

  // --- Polymorphic Data Load ---
  
  // 1. Common Data Structure for Editor
  let listingData: { title: string; bodyHtml: string; option1Name?: string } | null = null;
  let listingImages: ListingImage[] = [];
  let associatedItems: any[] = []; // (Item & {id: string})[]
  
  // 2. Selectors
  $: {
      if (mode === 'create' && janCode) {
          // --- Creation Mode ---
          const proposal = $store.listingCreation.proposals[janCode];
          if (proposal) {
              listingData = {
                  title: proposal.title,
                  bodyHtml: proposal.bodyHtml,
                  option1Name: proposal.option1Name
              };
              
              // Load associated items
              associatedItems = proposal.inventoryItemIds.map(id => {
                   const item = $store.inventory.idToItem[id];
                   return item ? { ...item, id } : null;
              }).filter((x): x is NonNullable<typeof x> => !!x);
              
              // Images: Map from Photo Group to ListingImage[]
              // For proposals, we might construct this on the fly or just show subtype images + extras
              // For now, let's grab ALL photos associated with this JAN code from the photos slice
              const photos = $store.photos.janCodeToPhotos[janCode] || [];
              listingImages = photos.map((p, idx) => ({
                  id: p.id,
                  url: p.baseUrl,
                  position: idx,
                  altText: 'Generated'
              }));
          } else {
              listingData = null;
          }
      } else {
          // --- Live Mode ---
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
  
  // Image Deletion
  function handleDeleteImage(e: CustomEvent<any>) {
      if (mode === 'create') {
          // TODO: Implement removing photo from proposal/draft
          alert("Deleting images in draft mode not fully implemented");
      } else {
          if (!$user.uid) return;
          broadcast(firestore, $user.uid, remove_listing_image({ handle, imageId: e.detail.id }));
      }
  }
  
  function handleDeleteSubtypeImage(e: CustomEvent<any>) {
      if (!$user.uid) return;
      // This works same for both modes since it targets inventory items
      broadcast(firestore, $user.uid, update_field({ 
          id: e.detail.id, 
          field: 'image', 
          from: e.detail.image, 
          to: '' 
      }));
  }

  // Image Upload / Replace Logic (Shared)
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
                  // Subtype Replace
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
                  // Proposal Image Replace
                  // For now, no-op or specific proposal action
                  alert("Replacing gallery images in draft not implemented");
              } else {
                  // Live Listing Image Replace
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
          // After approval, the slice logic advances the batch.
          // We need to check if the batch continues or if we are done.
          // The thunk updates the state, but we need to react to that.
          // Simplest way: The `activeBatchJans` and `step` change.
          // We can just redirect back to /listings/create to pick up the next item or finish.
          // OR, since the thunk advances step, we can just grab the new JAN?
          // Let's redirect to /listings/create which will reroute us if batch is active.
          goto('/listings/create');
      }
  }

  // Search (Live Mode Navigation)
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
  <!-- Search Header (Only show in Live Mode or if you want global search) -->
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
      <!-- Back button for creation mode -->
       <div class="search-header">
           <button class="back-btn" on:click={() => goto('/listings/create')}>Back to Batch</button>
       </div>
  {/if}

  {#if listingData}
      <ListingEditor
          listing={listingData}
          images={listingImages}
          associatedItems={associatedItems}
          bind:selectedSubtypeId
          readOnly={false}
          isCreationMode={mode === 'create'}
          on:updateTitle={handleUpdateTitle}
          on:updateDescription={handleUpdateDescription}
          on:deleteImage={handleDeleteImage}
          on:selectSubtype={handleSelectSubtype}
          on:deleteSubtypeImage={handleDeleteSubtypeImage}
          on:replaceImage={handleReplaceImage}
          on:replaceSubtypeImage={handleReplaceSubtypeImage}
          on:approve={handleApprove}
      />
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
</div>

<style>
  .container { max-width: 1200px; margin: 0 auto; padding: 2rem; font-family: sans-serif; color: #333; }
  .hidden-input { display: none; }

  /* Search Header (Same) */
  .search-header { margin-bottom: 2rem; display: flex; flex-direction: column; gap: 0.5rem; position: relative; }
  .search-bar-row { display: flex; gap: 0.5rem; }
  .search-input { border: 1px solid #ccc; border-radius: 4px; padding: 0.5rem 1rem; width: 100%; max-width: 400px; font-size: 1rem; }
  .search-input:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2); }
  .back-btn { background: #f3f4f6; padding: 0.5rem 1rem; border-radius: 4px; border: none; cursor: pointer; }
  .back-btn:hover { background: #e5e7eb; }
  .search-results { position: absolute; top: 100%; left: 0; width: 100%; max-width: 400px; background: white; border: 1px solid #e5e7eb; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); border-radius: 4px; z-index: 10; max-height: 240px; overflow-y: auto; }
  .result-item { width: 100%; text-align: left; padding: 0.5rem 1rem; background: none; border: none; cursor: pointer; }
  .result-item:hover { background: #eff6ff; }
  
  .not-found, .empty-state { text-align: center; padding: 5rem 0; color: #6b7280; }
  .not-found-text, .empty-text { font-size: 1.25rem; }
  .handle-text { font-family: monospace; color: #374151; }
  .link-btn { margin-top: 1rem; color: #2563eb; background: none; border: none; text-decoration: underline; cursor: pointer; font-size: 1rem; }
  .link-btn:hover { color: #1d4ed8; }
</style>
