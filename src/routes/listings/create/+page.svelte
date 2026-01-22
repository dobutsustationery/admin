<script lang="ts">
  import { store } from "$lib/store";
  // HMR Trigger
  import { onMount } from "svelte";
  import { 
      generate_proposals, 
      start_batch, 
      generate_descriptions_for_batch, 
      regenerate_description,
      set_current_step,
      recalculate_batch_navigation 
  } from "$lib/listing-creation-slice";
  import { goto } from '$app/navigation';

  import { initiateOAuthFlow, isAuthenticated } from "$lib/google-drive";
  import { set_drive_connection_status, update_proposal_field } from "$lib/listing-creation-slice";
  import BulkEditor, { type ColumnConfig } from "$lib/components/BulkEditor.svelte";
  import { generateHandle } from "$lib/handle-utils";
  import ViewCell from "$lib/components/cell-renderers/ViewCell.svelte";
  import BodyHtmlCell from "$lib/components/cell-renderers/BodyHtmlCell.svelte";
  import BodyHtmlModal from "$lib/components/BodyHtmlModal.svelte";
  import { broadcast } from "$lib/redux-firestore";
  import { firestore } from "$lib/firebase";
  import { user } from "$lib/user-store";
  import { update_field } from "$lib/inventory";
  import SecureImage from "$lib/components/SecureImage.svelte";

  // Subscribe to state
  $: listingCreation = $store.listingCreation;
  $: photosState = $store.photos;
  $: proposals = Object.values(listingCreation.proposals) as any[];
  $: activeBatchJans = listingCreation.activeBatchJans;
  $: originalBatchJans = listingCreation.originalBatchJans;
  $: visibleBatchJans = (originalBatchJans && originalBatchJans.length > 0) ? originalBatchJans : activeBatchJans;
  
  $: driveStatus = listingCreation.driveConnectionStatus;

  let showImagePicker = false;
  let imagePickerRow: any | null = null;

  let showBodyModal = false;
  let bodyModalJan: string | null = null;
  let bodyModalValue = "";

  let showDescPromptModal = false;
  let descPromptValue = "";
  

  // Derived
  $: hasOrganizedPhotos = photosState && photosState.janCodeToPhotos && Object.keys(photosState.janCodeToPhotos).length > 0;
  $: draftCount = proposals.filter(p => p.status === 'draft').length;
  
  // Use state directly to avoid ReferenceError on intermediate variables
  $: activeProposal = (activeBatchJans.length > 0 && listingCreation.currentStepIndex >= 0) 
      ? listingCreation.proposals[activeBatchJans[listingCreation.currentStepIndex]] 
      : null;

  $: isBulkEditMode = activeBatchJans.length > 0 && listingCreation.currentStepIndex === -1;
  
  // Enrich proposals with Image Data for Grid AND Variant Fields for Columns
  $: enrichedProposals = proposals.map(p => {
       const photos = photosState?.janCodeToPhotos?.[p.janCode];
       // Prefer baseUrl, fallback to thumbnailLink
       const janThumb = photos && photos.length > 0 ? (photos[0].baseUrl || photos[0].thumbnailLink) : null;
       
       // Flatten Variant Data (taking first variant for grid display)
       const firstVariant = p.variants && p.variants.length > 0 ? p.variants[0] : null;
       const inventoryItem = firstVariant ? $store.inventory.idToItem[firstVariant.itemId] : null;
       const variantThumb = inventoryItem?.image || null;
       
       return { 
           ...p, 
           _thumbnail: variantThumb || janThumb,
           option1Value: firstVariant ? firstVariant.option1Value : "",
           // For simple display, using janCode as id mostly.
           id: firstVariant ? firstVariant.itemId : p.janCode, 
       };
  });

  // Redirect if Active Proposal Found (and not in Bulk Mode)
  // Ensure we don't trigger this mid-state transition if index is invalid
  $: if (activeProposal && !isBulkEditMode && typeof listingCreation.currentStepIndex === 'number' && listingCreation.currentStepIndex >= 0) {
      goto(`/listing-detail?mode=create&jan=${activeProposal.janCode}`);
  }
  
  function handleStartReview() {
      store.dispatch(set_current_step(0));
  }

  onMount(() => {
     // Check initial auth state
     if (isAuthenticated()) {
         if (driveStatus !== 'connected') {
             store.dispatch(set_drive_connection_status('connected'));
         }
     } else {
         if (driveStatus !== 'disconnected') {
             store.dispatch(set_drive_connection_status('disconnected'));
         }
     }
     
     // IMPORTANT: If we land on this page and we are in a batch, we assume the user wants to see the Batch Editor (Step -1).
     // This prevents the infinite redirect loop if the user clicks "Back" from a listing detail page (Step 0, 1, etc.)
     // If they want to "Resume", they can click "Start Review" again.
     if (activeBatchJans.length > 0 && listingCreation.currentStepIndex !== -1) {
         store.dispatch(set_current_step(-1));
     }
  });
  
  function dispatchBroadcast(action: any) {
    if ($user && $user.uid) {
        broadcast(firestore, $user.uid, action);
    } else {
        console.warn("User not authenticated, falling back to local dispatch");
        store.dispatch(action);
    }
  }
  
  function handleGenerate() {
      generate_proposals()(dispatchBroadcast, store.getState, undefined);
  }
  
  function handleStartBatch() {
      // Pick top 10 drafts
      const drafts = proposals.filter(p => p.status === 'draft').slice(0, 10);
      
      if (drafts.length === 0) {
          return;
      }
      
      const ids = drafts.map(p => p.janCode);
      const batchId = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
          ? crypto.randomUUID()
          : `batch-${Date.now()}`;
      dispatchBroadcast(start_batch({ janCodes: ids, batchId, createdAt: Date.now() }));
      generate_descriptions_for_batch(ids)(dispatchBroadcast, store.getState, undefined);
      // Redirect handled by reactive statement above
  }

  function handleConnect() {
      initiateOAuthFlow(window.location.href);
  }

  import ImageCell from "$lib/components/cell-renderers/ImageCell.svelte";

  // --- Bulk Editor Config ---
  let columnConfig: ColumnConfig[] = [
      { field: 'view', header: 'View', width: 50, editable: false, type: 'component', component: ViewCell },
      { field: '_thumbnail', header: 'Image', width: 60, type: 'component', component: ImageCell, editable: false },
      
      { field: 'handle', header: 'Handle', width: 200, type: 'text', placeholderField: 'computedHandle' },
      { field: 'title', header: 'Title', width: 300, type: 'text' }, 
      { field: 'bodyHtml', header: 'Body (HTML)', width: 300, type: 'component', component: BodyHtmlCell, editable: false },
      { field: 'productCategory', header: 'Product Category', width: 150, type: 'text' },
      { field: 'option1Name', header: 'Option1 Name', width: 120, type: 'text' }, // Added
      { field: 'option1Value', header: 'Option1 Value', width: 100, editable: false, placeholderField: 'subtype' }, // Mapped

      { field: 'id', header: 'Variant SKU', width: 150, editable: false },
      { field: 'weight', header: 'Variant Grams', width: 80, type: 'number', align: 'right' },
      { field: 'countryOfOrigin', header: 'Country of Origin', width: 120, type: 'text' },
      { field: 'qty', header: 'Variant Inventory Qty', width: 80, type: 'number', align: 'right' },
      { field: 'price', header: 'Variant Price', width: 80, type: 'number', align: 'right' },
      { field: 'janCode', header: 'Variant Barcode', width: 120, editable: false },
      // Image Src, Position, Alt Text could be added if editable, but sticking to core for creation.
  ];

  function handleCommit(janCode: string, field: string, value: any, index: number) {
      if (field === 'handle') {
           dispatchBroadcast(update_proposal_field({ janCode, field: 'handle', value }));
      } else {
           // Handle Merging Logic
           const targetProposal = proposals.find(p => p.janCode === janCode);
           const targetHandle = targetProposal?.handle || targetProposal?.janCode; 
           
           const currentHandle = targetProposal?.handle || generateHandle(targetProposal?.title || "", targetProposal?.janCode || "");
           
           const isListingField = ['title', 'bodyHtml', 'productCategory', 'vendor', 'tags'].includes(field);
           
           if (isListingField) {
               // Find sharing proposals
               const sharingProposals = proposals.filter(p => {
                   const h = p.handle || generateHandle(p.title || "", p.janCode);
                   return h === currentHandle;
               });
               
               sharingProposals.forEach(p => {
                    dispatchBroadcast(update_proposal_field({ janCode: p.janCode, field: field as any, value }));
               });
           } else {
               dispatchBroadcast(update_proposal_field({ janCode, field: field as any, value }));
           }
      }
  }

  function handleBulkCommit(e: CustomEvent<{ id: string; field: string; value: any; index: number }>) {
      handleCommit(e.detail.id, e.detail.field, e.detail.value, e.detail.index);
  }

  function handleBulkImagePick(e: CustomEvent<{ item: any }>) {
      openImagePicker(e.detail.item);
  }

  function handleBulkEditHtml(e: CustomEvent<{ item: any }>) {
      openBodyModal(e.detail.item);
  }

  function openImagePicker(row: any) {
      imagePickerRow = row;
      showImagePicker = true;
  }

  function buildImagePickerCandidates(row: any) {
      if (!row) return [];
      const janCode = row.janCode;
      const targetProposal = proposals.find(p => p.janCode === janCode);
      if (!targetProposal) return [];
      const handleKey = targetProposal.handle || generateHandle(targetProposal.title || "", targetProposal.janCode);
      const siblings = proposals.filter(p => {
          const h = p.handle || generateHandle(p.title || "", p.janCode);
          return h === handleKey;
      });

      const candidates = new Map<string, { id: string; url: string; altText: string }>();
      const janPhotos = photosState?.janCodeToPhotos?.[janCode] || [];
      janPhotos.forEach((p: any, idx: number) => {
          const url = p.baseUrl || p.thumbnailLink || p.productUrl;
          if (!url) return;
          candidates.set(url, { id: p.id || `jan-${idx}`, url, altText: p.filename || 'JAN photo' });
      });

      siblings.forEach(p => {
          p.inventoryItemIds?.forEach((id: string) => {
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

  function handlePickVariantImage(candidate: { id: string; url: string }) {
      if (!imagePickerRow) return;
      const itemId = imagePickerRow.id;
      const item = $store.inventory.idToItem[itemId];
      const from = item?.image || "";
      dispatchBroadcast(update_field({ id: itemId, field: 'image', from, to: candidate.url }));
      showImagePicker = false;
      imagePickerRow = null;
  }

  function openBodyModal(row: any) {
      bodyModalJan = row?.janCode || null;
      bodyModalValue = row?.bodyHtml || "";
      showBodyModal = true;
  }

  function saveBodyModal(e: CustomEvent<{ value: string }>) {
      if (!bodyModalJan) return;
      dispatchBroadcast(update_proposal_field({ janCode: bodyModalJan, field: 'bodyHtml', value: e.detail.value }));
      showBodyModal = false;
      bodyModalJan = null;
  }

  function cancelBodyModal() {
      showBodyModal = false;
      bodyModalJan = null;
  }

  function handleRegenerateDescription() {
      if (!bodyModalJan) return;
      regenerate_description(bodyModalJan)(dispatchBroadcast, store.getState, undefined);
  }

  function openDescriptionPrompt() {
      const prompt = listingCreation.globalDescriptionPrompt || "Write a playful product description in HTML.";
      descPromptValue = prompt;
      showDescPromptModal = true;
  }

  function runDescriptionPrompt() {
      if (!bodyModalJan) return;
      regenerate_description(bodyModalJan, descPromptValue)(dispatchBroadcast, store.getState, undefined);
      showDescPromptModal = false;
  }

  $: if (showBodyModal && bodyModalJan) {
      const next = $store.listingCreation.proposals[bodyModalJan]?.bodyHtml || "";
      if (next !== bodyModalValue) {
          bodyModalValue = next;
      }
  }
</script>

<div class="container mx-auto p-6">
    <h1 class="text-3xl font-bold mb-6">Create Listings</h1>
    
    {#if driveStatus === 'disconnected'}
        <div class="bg-yellow-50 p-8 rounded border border-yellow-200 text-center">
            <h2 class="text-xl font-bold mb-4 text-yellow-800">Google Drive Connection Required</h2>
            <p class="mb-6 text-yellow-700">Please connect Google Drive to scan for product photos.</p>
            <button on:click={handleConnect} class="bg-blue-600 text-white px-6 py-3 rounded hover:bg-blue-700 font-bold shadow-lg">
                Connect Google Drive
            </button>
        </div>
    {:else if isBulkEditMode}
        <div id="bulk-editor-container" class="h-[calc(100vh-100px)] -mx-6 flex flex-col">
             <div class="flex justify-between items-center px-6 py-2 bg-white border-b">
                <h2 class="text-xl font-bold">Batch Editor</h2>
                <button class="btn-save start-review-btn" on:click={() => {
                    dispatchBroadcast(recalculate_batch_navigation());
                    dispatchBroadcast(set_current_step(0));
                }}>
                    <span>Start Review</span>
                    <span aria-hidden="true">&rarr;</span>
                </button>
            </div>
             <BulkEditor 
                data={enrichedProposals.filter(p => visibleBatchJans.includes(p.janCode))}
                columns={columnConfig}
                keyField="janCode"
                on:commit={handleBulkCommit}
                on:imagePick={handleBulkImagePick}
                on:editHtml={handleBulkEditHtml}
             />
        </div>
    {:else if draftCount > 0}
        <div class="bg-white p-8 rounded shadow text-center">
            <h2 class="text-2xl font-bold mb-4">{draftCount} Drafts Ready</h2>
            <p class="mb-6 text-gray-600">Start a batch to review and publish the next 10 listings.</p>
            <button on:click={handleStartBatch} class="bg-blue-600 text-white px-6 py-3 rounded hover:bg-blue-700 font-bold">
                Start Batch
            </button>
        </div>
    {:else}
         <div class="bg-gray-50 p-8 rounded border border-dashed border-gray-300 text-center">
            <h2 class="text-xl font-medium mb-4 text-gray-500">No proposals found</h2>
            
            {#if !hasOrganizedPhotos}
                <div class="mb-4 text-orange-600 bg-orange-50 p-4 rounded inline-block text-left max-w-lg">
                    <p class="font-bold">No organized photos found.</p>
                    <p>Creating listings requires photos to be matched to JAN codes first.</p>
                    <p class="mt-2">Please go to <a href="/photos" class="underline font-bold">Photos &gt; Organize</a> to categorize your uploads.</p>
                </div>
                <br/>
            {/if}

            <button on:click={handleGenerate} class="text-blue-600 hover:underline">
                Scan for matched items
            </button>
        </div>
    {/if}
</div>

{#if showImagePicker}
    <div class="modal-backdrop">
        <div class="modal image-picker-modal">
            <h3 class="modal-title">Select image for this variant</h3>
            <div class="image-picker-grid">
                {#each buildImagePickerCandidates(imagePickerRow) as candidate}
                    <button class="image-picker-item" on:click={() => handlePickVariantImage(candidate)}>
                        <SecureImage src={candidate.url} alt={candidate.altText} className="image-picker-img" />
                    </button>
                {/each}
            </div>
            <div class="modal-actions">
                <button class="btn-cancel" on:click={() => { showImagePicker = false; imagePickerRow = null; }}>Cancel</button>
            </div>
        </div>
    </div>
{/if}

{#if showBodyModal}
    <BodyHtmlModal
        open={showBodyModal}
        value={bodyModalValue}
        title="Edit Description HTML"
        showRegenerate={true}
        showPrompt={true}
        on:save={saveBodyModal}
        on:cancel={cancelBodyModal}
        on:regenerate={handleRegenerateDescription}
        on:editPrompt={openDescriptionPrompt}
    />
{/if}

{#if showDescPromptModal}
    <div class="modal-backdrop prompt-backdrop">
        <div class="modal prompt-modal">
            <h3 class="modal-title">Edit Description Prompt</h3>
            <textarea class="body-textarea" bind:value={descPromptValue}></textarea>
            <div class="modal-actions">
                <button class="btn-cancel" on:click={() => { showDescPromptModal = false; }}>Cancel</button>
                <button class="btn-save" on:click={runDescriptionPrompt}>Generate</button>
            </div>
        </div>
    </div>
{/if}

<style>
  .start-review-btn { display: inline-flex; align-items: center; gap: 0.5rem; white-space: nowrap; }
  .modal-backdrop { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 200; }
  .modal { background: white; padding: 1.5rem; border-radius: 8px; width: 100%; max-width: 720px; box-shadow: 0 10px 25px rgba(0,0,0,0.1); }
  .prompt-modal { max-width: 720px; z-index: 2001; position: relative; }
  .prompt-backdrop { z-index: 2000; }
  .body-textarea { min-height: 320px; border: 1px solid #e5e7eb; border-radius: 6px; padding: 0.75rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; width: 100%; }
  .btn-save { padding: 0.5rem 0.75rem; border-radius: 6px; background: #2563eb; color: white; border: none; cursor: pointer; }
  .modal-title { font-weight: 600; font-size: 1.1rem; }
  .image-picker-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(90px, 1fr)); gap: 0.75rem; margin-top: 1rem; max-height: 420px; overflow: auto; }
  .image-picker-item { border: 1px solid #e5e7eb; background: white; padding: 0; border-radius: 6px; overflow: hidden; cursor: pointer; }
  .image-picker-img { width: 100%; height: 90px; object-fit: cover; display: block; }
  .image-picker-item:hover { border-color: #3b82f6; box-shadow: 0 0 0 1px #3b82f6; }
  .modal-actions { display: flex; justify-content: flex-end; margin-top: 1rem; }
  .btn-cancel { padding: 0.5rem 0.75rem; border: 1px solid #d1d5db; border-radius: 6px; background: white; cursor: pointer; }
</style>
