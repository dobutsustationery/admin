<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { Item } from '$lib/inventory';

  export let janCode: string;
  export let totalQty: number;
  export let subtypes: Item[];
  
  const dispatch = createEventDispatcher();

  // Track allocation for each subtype
  // Key: item.subtype (or item ID/key?)
  // Let's use item key from subtypes list if available, or just index
  // Actually we need to match it back to the Item.
  // We'll create a local state for quantities.
  
  let allocations: Record<string, number> = {};
  
  // Initialize allocations to 0
  subtypes.forEach(s => {
      // Construct a unique key for the item to track allocation
      // Assuming subtypes list has unique subtypes for this JAN
      allocations[s.subtype || 'default'] = 0;
  });

  // Derived state
  $: allocatedSum = Object.values(allocations).reduce((a, b) => a + b, 0);
  $: remaining = totalQty - allocatedSum;
  $: isValid = remaining === 0;

  function handleSave() {
    if (!isValid) return;
    
    // Map back to specific items
    // We return a map of { itemKey: allocatedQty }
    // We need to know the itemKey for each subtype.
    // The passed `subtypes` are `Item` objects. We need their IDs (keys) from the store.
    // But `Item` interface in `inventory.ts` doesn't strictly have the ID inside it (it's key-value in store).
    // The logic in `import-logic.ts` passed `Item[]`.
    // We should probably pass `{ key: string, item: Item }[]` to be safe.
    // Ideally the parent handles the mapping. We'll verify this later. 
    // For now assuming we return `{ subtype: qty }` mapping is enough for parent to resolve.
    
    dispatch('save', { allocations });
  }

  function handleCancel() {
    dispatch('cancel');
  }
</script>

<div class="modal-backdrop">
  <div class="modal">
    <h3>Resolve Subtypes</h3>
    <div class="info">
        <p><strong>JAN:</strong> {janCode}</p>
        <p><strong>Total Received:</strong> {totalQty}</p>
        <p class:error={remaining !== 0}><strong>Remaining to Allocate:</strong> {remaining}</p>
    </div>

    <div class="subtype-list">
        {#each subtypes as item}
            <div class="row">
                <div class="label">
                    <span class="subtype-name">{item.subtype || 'Main'}</span>
                    <span class="desc">{item.description}</span>
                </div>
                <input 
                    type="number" 
                    min="0" 
                    max={totalQty}
                    bind:value={allocations[item.subtype || 'default']} 
                />
            </div>
        {/each}
    </div>

    <div class="actions">
        <button class="btn-cancel" on:click={handleCancel}>Cancel</button>
        <button class="btn-save" on:click={handleSave} disabled={!isValid}>
            Confirm Allocation
        </button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    top: 0; left: 0;
    width: 100vw; height: 100vh;
    background: rgba(0,0,0,0.5);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
  }

  .modal {
    background: white;
    padding: 24px;
    border-radius: 8px;
    width: 500px;
    max-width: 90%;
    box-shadow: 0 4px 6px rgba(0,0,0,0.1);
  }

  h3 { margin-top: 0; }

  .info {
      background: #f3f4f6;
      padding: 12px;
      border-radius: 6px;
      margin-bottom: 20px;
  }

  .info p { margin: 4px 0; }
  .error { color: #dc2626; font-weight: bold; }

  .row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      padding-bottom: 8px;
      border-bottom: 1px solid #e5e7eb;
  }

  .label {
      display: flex;
      flex-direction: column;
  }
  
  .subtype-name { font-weight: 500; }
  .desc { font-size: 0.85em; color: #6b7280; }

  input {
      width: 80px;
      padding: 8px;
      border: 1px solid #d1d5db;
      border-radius: 4px;
  }

  .actions {
      display: flex;
      justify-content: flex-end;
      gap: 12px;
      margin-top: 24px;
  }

  button {
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      border: none;
      font-weight: 500;
  }

  .btn-cancel { background: #e5e7eb; color: #374151; }
  .btn-save { background: #2563eb; color: white; }
  .btn-save:disabled { background: #9ca3af; cursor: not-allowed; }
</style>
