<script lang="ts">
  import { store } from "$lib/store";
  import { onMount } from "svelte";
  import { generate_proposals, start_batch, approve_proposal_thunk } from "$lib/listing-creation-slice";
  import ProposalCard from "./ProposalCard.svelte";

  // Subscribe to state
  $: listingCreation = $store.listingCreation;
  $: proposals = Object.values(listingCreation.proposals);
  $: activeBatchJans = listingCreation.activeBatchJans;
  $: currentStep = listingCreation.currentStepIndex;
  
  // Derived
  $: draftCount = proposals.filter(p => p.status === 'draft').length;
  $: activeProposal = activeBatchJans.length > 0 ? listingCreation.proposals[activeBatchJans[currentStep]] : null;
  
  function handleGenerate() {
      store.dispatch(generate_proposals());
  }
  
  function handleStartBatch() {
      // Pick top 10 drafts
      const drafts = proposals.filter(p => p.status === 'draft').slice(0, 10);
      const ids = drafts.map(p => p.janCode);
      store.dispatch(start_batch({ janCodes: ids }));
  }
</script>

<div class="container mx-auto p-6">
    <h1 class="text-3xl font-bold mb-6">Create Listings</h1>
    
    {#if activeProposal}
        <!-- Active Batch View -->
        <div class="mb-4 flex justify-between items-center">
            <span class="text-gray-600">Reviewing {currentStep + 1} of {activeBatchJans.length}</span>
            <div class="w-1/3 bg-gray-200 rounded-full h-2.5">
                <div class="bg-blue-600 h-2.5 rounded-full" style="width: {((currentStep) / activeBatchJans.length) * 100}%"></div>
            </div>
        </div>
        
        <ProposalCard 
            proposal={activeProposal} 
            onApprove={() => store.dispatch(approve_proposal_thunk(activeProposal.janCode))}
        />
        
    {:else}
        <!-- Dashboard / Empty State -->
        {#if draftCount > 0}
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
                <button on:click={handleGenerate} class="text-blue-600 hover:underline">
                    Scan for new items
                </button>
            </div>
        {/if}
    
    {/if}
</div>
