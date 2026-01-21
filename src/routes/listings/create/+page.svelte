<script lang="ts">
  import { store } from "$lib/store";
  import { onMount } from "svelte";
  import { 
      generate_proposals, 
      start_batch, 
      generate_descriptions_for_batch, 
      set_current_step,
      recalculate_batch_navigation 
  } from "$lib/listing-creation-slice";
  import { goto } from '$app/navigation';

  import { initiateOAuthFlow, isAuthenticated } from "$lib/google-drive";
  import { set_drive_connection_status, update_proposal_field } from "$lib/listing-creation-slice";
  import BulkEditor, { type ColumnConfig } from "$lib/components/BulkEditor.svelte";
  import { generateHandle } from "$lib/handle-utils";
  import ViewCell from "$lib/components/cell-renderers/ViewCell.svelte";
  import { broadcast } from "$lib/redux-firestore";
  import { firestore } from "$lib/firebase";
  import { user } from "$lib/user-store";

  // Subscribe to state
  $: listingCreation = $store.listingCreation;
  $: photosState = $store.photos;
  $: proposals = Object.values(listingCreation.proposals) as any[];
  $: activeBatchJans = listingCreation.activeBatchJans;
  $: originalBatchJans = listingCreation.originalBatchJans;
  $: visibleBatchJans = (originalBatchJans && originalBatchJans.length > 0) ? originalBatchJans : activeBatchJans;
  
  $: driveStatus = listingCreation.driveConnectionStatus;
  

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
       const thumb = photos && photos.length > 0 ? (photos[0].baseUrl || photos[0].thumbnailLink) : null;
       
       // Flatten Variant Data (taking first variant for grid display)
       const firstVariant = p.variants && p.variants.length > 0 ? p.variants[0] : null;
       // We need to look up inventory item to get weight, country, qty? 
       // Proposal has `inventoryItemIds`. 
       // We can iterate inventory. But for now, let's map what we have or accept blanks.
       // The `ListingProposal` doesn't strictly copy all fields.
       // We might need to look up the inventory item again.
       
       return { 
           ...p, 
           _thumbnail: thumb,
           option1Value: firstVariant ? firstVariant.option1Value : "",
           // For simple display, using janCode as id mostly.
           id: firstVariant ? firstVariant.itemId : p.janCode, 
           // weight: ?, countryOfOrigin: ? <- Not in Proposal currently, would need lookup.
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
      dispatchBroadcast(start_batch({ janCodes: ids }));
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
      { field: 'bodyHtml', header: 'Body (HTML)', width: 300, type: 'text' },
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
                <button class="bg-blue-600 text-white px-4 py-2 rounded font-bold hover:bg-blue-700" on:click={() => {
                    dispatchBroadcast(recalculate_batch_navigation());
                    dispatchBroadcast(set_current_step(0));
                }}>
                    Start Review &rarr;
                </button>
            </div>
             <BulkEditor 
                data={enrichedProposals.filter(p => visibleBatchJans.includes(p.janCode))}
                columns={columnConfig}
                keyField="janCode"
                on:commit={(e) => handleCommit(e.detail.id, e.detail.field, e.detail.value, e.detail.index)}
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
