<script lang="ts">
  import { onMount } from 'svelte';
  import { store } from "$lib/store";
  import OrderImportPicker from '$lib/components/OrderImportPicker.svelte';
  
  onMount(() => {
    console.log('DEBUG: OrderImportPage Mounted');
  });
  import OrderImportSummary from '$lib/components/OrderImportSummary.svelte';
  import SubtypeResolutionModal from '$lib/components/SubtypeResolutionModal.svelte';
  import { parseImportData, analyzeImport, type ImportPlan, type PlanConflict } from '$lib/import-logic';
  import { fetchSpreadsheetData, getStoredToken } from '$lib/google-drive';
  import { createAction } from "@reduxjs/toolkit";

  // Action creator - recreate here or import from inventory.ts if exported
  // We added it inline in inventory.ts? Ah, createAction creates the action creator. 
  // We need to export it from inventory.ts or redefine exact signature.
  // Ideally we should have exported `batch_update_inventory` from inventory.ts
  
  // Checking inventory.ts... we didn't export it const! We added r.addCase(createAction...).
  // This means we need to construct it manually as `{ type: 'batch_update_inventory', payload: ... }`
  // OR update inventory.ts to export the action creator. 
  // Let's manually construct for now to avoid switching files again, it's safer.
  const batch_update_inventory = (payload: any) => ({ type: "batch_update_inventory", payload });

  let step: 'PICK' | 'SUMMARY' | 'SUCCESS' = 'PICK';
  let plan: ImportPlan | null = null;
  let activeConflict: PlanConflict | null = null;
  let loading = false;

  async function handleSelect(event: CustomEvent) {
    loading = true;
    try {
        const { content } = event.detail;
        console.log(`DEBUG: Received content length: ${content ? content.length : 0}`);
        
        // Parse
        const parsedItems = parseImportData(content);
        if (parsedItems.length === 0) {
           alert("No valid items found in file. Please ensure it has JAN codes.");
           return;
        }

        // Analyze
        const state = store.getState();
        plan = analyzeImport(parsedItems, state.inventory);
        step = 'SUMMARY';
    } catch (e) {
        console.error("Import failed", e);
        alert("Failed to processing file: " + e);
    } finally {
        loading = false;
    }
  }

  function handleResolve(event: CustomEvent) {
    activeConflict = event.detail;
  }

  function saveResolution(event: CustomEvent) {
    if (!activeConflict || !plan) return;
    
    const { allocations } = event.detail; // { subtype: qty }

    // Convert allocations into PlanMatches and remove conflict
    // activeConflict has `currentSubtypes` items.
    
    for (const [subtype, qty] of Object.entries(allocations)) {
        if (qty > 0) {
            const item = activeConflict.currentSubtypes.find(i => (i.subtype || 'default') === subtype);
            if (item) {
                plan.matches.push({
                    janCode: activeConflict.janCode,
                    item: item,
                    addQty: qty as number
                });
            }
        }
    }

    // Remove from conflicts
    plan.conflicts = plan.conflicts.filter(c => c !== activeConflict);
    activeConflict = null;
    
    // Force reactivity
    plan = { ...plan };
  }

  function handleCommit() {
    if (!plan) return;

    // Prepare payload
    const updates = plan.matches.map(m => {
        // We need the ID for the item. Accessing via state if needed, 
        // but `m.item` should be the reference from state.
        // Wait, `Item` interface doesn't have ID property!
        // `inventory.ts`: `idToItem: { [key: string]: Item }`.
        // We need to find the KEY for the item.
        
        // This is tricky. `analyzeImport` returned `item` object reference.
        // We need to find the key. 
        // Let's iterate store to find key matching ref? Or structure `Item` to have ID?
        // `analyzeImport` should probably return Key or ID.
        
        // Let's assume we can re-find it or `analyzeImport` needs update.
        // Quick fix: scan `idToItem` for the object reference.
        const state = store.getState();
        const key = Object.keys(state.inventory.idToItem).find(k => state.inventory.idToItem[k] === m.item);
        if (!key) throw new Error("Could not find item key for " + m.janCode);
        
        return {
            id: key,
            qty: m.addQty
        };
    });

    const newItems = plan.newItems; // { janCode, qty }

    store.dispatch(batch_update_inventory({
        updates,
        newItems,
        timestamp: { seconds: Math.floor(Date.now() / 1000) }
    }));
    
    step = 'SUCCESS';
  }

  function reset() {
     step = 'PICK';
     plan = null;
     activeConflict = null;
  }
</script>

<div class="page-container">
  <h1>Order Import</h1>
  
  {#if step === 'PICK'}
    <div class="step-container">
        <OrderImportPicker on:select={handleSelect} />
    </div>
  
  {:else if step === 'SUMMARY' && plan}
    <div class="step-container">
        <OrderImportSummary 
            plan={plan} 
            on:resolve={handleResolve}
            on:commit={handleCommit}
            on:cancel={reset}
        />
    </div>

  {:else if step === 'SUCCESS'}
     <div class="success-view">
         <div class="icon">🎉</div>
         <h2>Import Successful</h2>
         <p>Inventory has been updated.</p>
         <button class="btn-primary" on:click={reset}>Import Another</button>
     </div>
  {/if}

  {#if activeConflict}
     <SubtypeResolutionModal 
        janCode={activeConflict.janCode}
        totalQty={activeConflict.totalQty}
        subtypes={activeConflict.currentSubtypes}
        on:save={saveResolution}
        on:cancel={() => activeConflict = null}
     />
  {/if}
</div>

<style>
  .page-container {
      max-width: 1000px;
      margin: 0 auto;
      padding: 20px;
  }
  
  h1 { margin-bottom: 30px; color: #111827; }

  .step-container { margin-bottom: 40px; }

  .success-view {
      text-align: center;
      padding: 60px;
      background: white;
      border-radius: 8px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  }

  .icon { font-size: 4em; margin-bottom: 20px; }
  
  .btn-primary {
      background: #2563eb;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 1.1em;
      margin-top: 20px;
  }
</style>
