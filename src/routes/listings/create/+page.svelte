<script lang="ts">
  import { store } from "$lib/store";
  import { onMount } from "svelte";
  import { generate_proposals, start_batch, generate_descriptions_for_batch } from "$lib/listing-creation-slice";
  import { goto } from '$app/navigation';

  import { initiateOAuthFlow, isAuthenticated } from "$lib/google-drive";
  import { set_drive_connection_status } from "$lib/listing-creation-slice";

  // Subscribe to state
  $: listingCreation = $store.listingCreation;
  $: photosState = $store.photos;
  $: proposals = Object.values(listingCreation.proposals) as any[];
  $: activeBatchJans = listingCreation.activeBatchJans;
  $: currentStep = listingCreation.currentStepIndex;
  $: driveStatus = listingCreation.driveConnectionStatus;
  
  // Derived
  $: hasOrganizedPhotos = photosState && photosState.janCodeToPhotos && Object.keys(photosState.janCodeToPhotos).length > 0;
  $: draftCount = proposals.filter(p => p.status === 'draft').length;
  $: activeProposal = activeBatchJans.length > 0 ? listingCreation.proposals[activeBatchJans[currentStep]] : null;
  
  // Redirect if Active Proposal Found
  $: if (activeProposal) {
      goto(`/listing-detail?mode=create&jan=${activeProposal.janCode}`);
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
  });
  
  function handleGenerate() {
      store.dispatch(generate_proposals());
  }
  
  function handleStartBatch() {
      // Pick top 10 drafts
      const drafts = proposals.filter(p => p.status === 'draft').slice(0, 10);
      const ids = drafts.map(p => p.janCode);
      store.dispatch(start_batch({ janCodes: ids }));
      store.dispatch(generate_descriptions_for_batch(ids));
      // Redirect handled by reactive statement above
  }

  function handleConnect() {
      initiateOAuthFlow(window.location.href);
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
