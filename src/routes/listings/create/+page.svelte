<script lang="ts">
  import { store } from "$lib/store";
  import Celebration from "$lib/components/Celebration.svelte";
  // HMR Trigger
  import { onMount } from "svelte";
  import { 
      generate_proposals, 
      start_batch, 
      generate_descriptions_for_batch, 
      regenerate_description,
      set_current_step,
      recalculate_batch_navigation,
      set_proposal_handle_thunk,
      clear_celebration,
      mark_celebrated
  } from "$lib/listing-creation-slice";
  import { goto } from '$app/navigation';

  import { initiateOAuthFlow, isAuthenticated } from "$lib/google-drive";
  import { set_drive_connection_status, update_proposal_field, update_variant_value, update_variant_image } from "$lib/listing-creation-slice";
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
  
  let showCelebration = false;
  let showReturnToDashboard = false;

  $: completedBatchId = listingCreation.lastCompletedBatchId;
  $: if (typeof completedBatchId === 'string' && !listingCreation.hasCelebrated) {
      console.log("[Celebration] Triggering! Batch:", completedBatchId);
      store.dispatch(mark_celebrated()); // Record that we played it
      showCelebration = true;
      showReturnToDashboard = false;
      setTimeout(() => {
          showReturnToDashboard = true;
      }, 3500); // Allow animation to play out
  } else if (completedBatchId === undefined) {
      showCelebration = false;
      showReturnToDashboard = false;
  }
  
  function handleReturnToDashboard() {
      store.dispatch(clear_celebration());
      goto('/');
  }

  // Derived
  $: hasOrganizedPhotos = photosState && photosState.janCodeToPhotos && Object.keys(photosState.janCodeToPhotos).length > 0;
  $: draftCount = proposals.filter(p => p.status === 'draft').length;
  
  // Use state directly to avoid ReferenceError on intermediate variables
  $: activeProposal = (activeBatchJans.length > 0 && listingCreation.currentStepIndex >= 0) 
      ? listingCreation.proposals[activeBatchJans[listingCreation.currentStepIndex]] 
      : null;

  $: isBulkEditMode = activeBatchJans.length > 0 && listingCreation.currentStepIndex === -1;
  
  // Enrich proposals with Image Data for Grid AND Variant Fields for Columns
  // FLATTENED: Create one row per VARIANT, not per Proposal.
  $: flattenedRows = proposals.flatMap(p => {
       // If no variants defined (shouldn't happen for valid proposals), fallback to dummy
       const variants = (p.variants && p.variants.length > 0) ? p.variants : [{ itemId: p.janCode, option1Value: "" }];

       return variants.map((v: any, idx: number) => {
            const inventoryItem = $store.inventory.idToItem[v.itemId];
            
            // Photo Lookup Strategy:
            // 1. Explicit Photo Group Key (from Subtype Automation)
            // 2. Specific Variant JAN
            // 3. Linked Photo Groups (from split/merge)
            // 4. Proposal Key (Fallback)
            let photos: any[] = [];
            
            if (v.photoGroupKey && photosState?.janCodeToPhotos?.[v.photoGroupKey]) {
                photos = photosState.janCodeToPhotos[v.photoGroupKey];
            } else if (inventoryItem?.janCode && photosState?.janCodeToPhotos?.[inventoryItem.janCode]) {
                photos = photosState.janCodeToPhotos[inventoryItem.janCode];
            } else if (p.photoGroupIds && p.photoGroupIds.length > 0) {
                // Aggregate all groups? Or just take first valid? 
                // For thumbnail, first valid is fine.
                for (const groupId of p.photoGroupIds) {
                    const group = photosState?.janCodeToPhotos?.[groupId];
                    if (group && group.length > 0) {
                        photos = group;
                        break;
                    }
                }
            } else if (photosState?.janCodeToPhotos?.[p.janCode]) {
                photos = photosState.janCodeToPhotos[p.janCode];
            }

            const thumb = photos && photos.length > 0 ? (photos[0].baseUrl || photos[0].thumbnailLink) : null;
            
            // Prioritize draft variant image override, then inventory image
            const variantThumb = v.image || inventoryItem?.image || null;
            
            return {
                ...p, // Spread Shared Listing Props (Title, Handle, Price, Body, etc.)
                
                // Computed Fields
                computedHandle: p.handle || generateHandle(p.title || "", p.janCode),
                _viewMode: 'create',

                // Row Identity
                rowId: v.id || v.itemId, // Unique ID for the grid row (variant instance ID preferred)
                id: v.itemId, // For Image Picker compatibility
                janCode: p.janCode, // Reference to parent Proposal
                
                // Variant Specifics
                variantId: v.id,
                option1Value: v.option1Value,
                allocatedQty: v.qty, // Allocated quantity for this variant
                sourceQty: inventoryItem ? inventoryItem.qty : 0, // Total available
                photoGroupKey: v.photoGroupKey,
                
                // Images: Variant image > Variant JAN Group Image
                _thumbnail: variantThumb || thumb,
                
                // We use these for display/logic but they are derived
                _variantIndex: idx,
                _isPrimary: idx === 0 
            };
       });
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
    if (typeof action === 'function') {
        return action(dispatchBroadcast, store.getState);
    }

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
      // Pick top 10 drafts (Reverted to 10 per design)
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

  // --- Progress ---
  $: totalInBatch = originalBatchJans ? originalBatchJans.length : 0;
  $: remainingInBatch = activeBatchJans.length;
  $: doneInBatch = totalInBatch - remainingInBatch;
  $: progressPercent = totalInBatch > 0 ? (doneInBatch / totalInBatch) * 100 : 0;

  // --- Bulk Editor Config ---
  let columnConfig: ColumnConfig[] = [
      { field: 'view', header: 'View', width: 50, editable: false, type: 'component', component: ViewCell },
      { field: '_thumbnail', header: 'Image', width: 60, type: 'component', component: ImageCell, editable: false },
      
      { field: 'handle', header: 'Handle', width: 200, type: 'text', placeholderField: 'computedHandle' },
      { field: 'title', header: 'Title', width: 300, type: 'text' }, 
      { field: 'bodyHtml', header: 'Body (HTML)', width: 300, type: 'component', component: BodyHtmlCell, editable: false },
      { field: 'productCategory', header: 'Product Category', width: 150, type: 'text' },
      { field: 'option1Name', header: 'Option1 Name', width: 120, type: 'text' }, 
      { field: 'option1Value', header: 'Option1 Value', width: 120, type: 'text' }, 
      { field: 'photoGroupKey', header: 'Photo Group', width: 120, editable: false },
      { field: 'sourceQty', header: 'Stock', width: 80, editable: false, align: 'right' },
      { field: 'allocatedQty', header: 'Allocated', width: 80, type: 'number', align: 'right' },

      { field: 'price', header: 'Price', width: 100, type: 'number', align: 'right' },
      { field: 'id', header: 'Variant SKU', width: 150, editable: false },
      { field: 'janCode', header: 'Barcode', width: 120, editable: false },
  ];

  function handleCommit(rowId: string, field: string, value: any, index: number) {
      // Find the row data to get the real context
      const row = flattenedRows.find(r => r.rowId === rowId);
      if (!row) {
          console.error("Could not find row for commit", rowId);
          return;
      }
      
      const janCode = row.janCode;

      if (field === 'handle') {
           const newHandle = value;
           dispatchBroadcast(set_proposal_handle_thunk(janCode, row.variantId, newHandle));
      } else if (field === 'option1Value') {
           if (row.variantId) {
               dispatchBroadcast(update_variant_value({ janCode, variantId: row.variantId, value }));
           }
      } else {
           // Standard Update
           // Since we now have "One Proposal = One Listing", we don't need to sync across multiple proposals.
           // However, if we edit a shared field (Title), it applies to the Proposal (and thus all its variants).
           dispatchBroadcast(update_proposal_field({ janCode, field: field as any, value }));
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
      
      // Aggregate photos from all linked groups (handles split/merge)
      const photoGroups = targetProposal.photoGroupIds || [janCode];
      const janPhotos = photoGroups.flatMap((gid: string) => photosState?.janCodeToPhotos?.[gid] || []);
      
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
      
      // Use Variant Context to update Draft State
      const janCode = imagePickerRow.janCode;
      const variantId = imagePickerRow.variantId;
      
      if (janCode && variantId) {
          dispatchBroadcast(update_variant_image({ janCode, variantId, image: candidate.url }));
      } else {
          // Fallback to Inventory Update (e.g. legacy)
          const itemId = imagePickerRow.id;
          const item = $store.inventory.idToItem[itemId];
          const from = item?.image || "";
          dispatchBroadcast(update_field({ id: itemId, field: 'image', from, to: candidate.url }));
      }
      
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
    
    {#if showCelebration}
        <Celebration />
        {#if showReturnToDashboard}
            <div class="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
                <div class="pointer-events-auto mt-64">
                    <button on:click={handleReturnToDashboard} class="bg-white text-blue-600 px-8 py-4 rounded-full font-bold text-xl shadow-2xl hover:scale-105 transition-transform border-4 border-blue-100">
                        Return to Dashboard
                    </button>
                </div>
            </div>
        {/if}
    {/if}

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
             <div class="flex justify-between items-center px-6 py-2 bg-white border-b gap-4">
                <div class="flex-1">
                    <div class="flex items-center justify-between mb-1">
                        <h2 class="text-xl font-bold">Batch Editor ({remainingInBatch} items remaining)</h2>
                        <span class="text-sm text-gray-500">{doneInBatch} / {totalInBatch} Completed</span>
                    </div>
                    <div class="w-full bg-gray-200 rounded-full h-2.5">
                        <div class="bg-blue-600 h-2.5 rounded-full transition-all duration-500" style="width: {progressPercent}%"></div>
                    </div>
                </div>
                <button class="btn-save start-review-btn ml-4" on:click={() => {
                    dispatchBroadcast(recalculate_batch_navigation());
                    dispatchBroadcast(set_current_step(0));
                }}>
                    <span>Start Review</span>
                    <span aria-hidden="true">&rarr;</span>
                </button>
            </div>
             <BulkEditor 
                data={flattenedRows.filter(p => visibleBatchJans.includes(p.janCode))}
                columns={columnConfig}
                keyField="rowId"
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
  :global(.image-picker-img) { width: 100%; height: 90px; object-fit: cover; display: block; }
  .image-picker-item:hover { border-color: #3b82f6; box-shadow: 0 0 0 1px #3b82f6; }
  .modal-actions { display: flex; justify-content: flex-end; margin-top: 1rem; }
  .btn-cancel { padding: 0.5rem 0.75rem; border: 1px solid #d1d5db; border-radius: 6px; background: white; cursor: pointer; }
</style>
