<script lang="ts">
  import type { ListingProposal } from "$lib/listing-creation-slice";
  import { store } from "$lib/store";
  import { update_proposal_field } from "$lib/listing-creation-slice";
  
  export let proposal: ListingProposal;
  export let onApprove: () => void;
  
  function update(field: keyof ListingProposal, value: any) {
      store.dispatch(update_proposal_field({ 
          janCode: proposal.janCode, 
          field, 
          value 
      }));
  }
</script>

<div class="grid grid-cols-1 md:grid-cols-3 gap-6 bg-white p-6 rounded-lg shadow-lg">
    <!-- Left: Images -->
    <div class="col-span-1 border-r pr-6">
        <h3 class="font-bold text-gray-500 text-sm mb-2">PHOTOS (Group: {proposal.janCode})</h3>
        <!-- Placeholder for Carousel -->
        <div class="aspect-square bg-gray-100 rounded flex items-center justify-center text-gray-400">
            [Image Carousel Here]
        </div>
    </div>
    
    <!-- Center: Form -->
    <div class="col-span-1 md:col-span-2 flex flex-col gap-4">
        <div>
            <label class="block text-sm font-medium text-gray-700">Title</label>
            <input 
                type="text" 
                value={proposal.title} 
                on:input={(e) => update('title', e.currentTarget.value)}
                class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm border p-2"
            />
        </div>
        
        <div>
            <label class="block text-sm font-medium text-gray-700">Description</label>
            <textarea 
                rows="5"
                value={proposal.bodyHtml} 
                on:input={(e) => update('bodyHtml', e.currentTarget.value)}
                class="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm border p-2"
            ></textarea>
        </div>
        
        <!-- Actions -->
        <div class="mt-auto flex justify-end gap-3 pt-6 border-t">
            <button class="px-4 py-2 border rounded text-gray-600 hover:bg-gray-50">Skip</button>
            <button on:click={onApprove} class="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 font-bold">
                Approve & Publish
            </button>
        </div>
    </div>
</div>
