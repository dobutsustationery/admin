<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import type { Item } from "$lib/inventory";
  import ImageThumbnail from "./ImageThumbnail.svelte";

  export let open = false;
  export let associatedItems: any[] = []; // Current variants of the listing
  export let inventory: Record<string, any> = {}; // Full inventory for search
  export let mode: "add" | "remove" | "split" = "add";
  export let janCode = "";
  export let sourceItem: (Item & { id: string }) | null = null; // Item being added or removed
  export let otherVariants: any[] = []; // For remove mode transfer options

  $: if (open) {
    console.log("[VariantModal] Prop Update:", {
      mode,
      janCode,
      sourceItem: sourceItem?.id,
      associatedCount: associatedItems.length,
      searchLen: searchQuery.length,
    });
  }

  const dispatch = createEventDispatcher();

  // Search State
  let searchQuery = "";
  $: allMatches = (
    (searchQuery?.trim()?.length || 0) > 2 && inventory
      ? (() => {
          const q = searchQuery.toLowerCase().trim();
          const entries = Object.entries(inventory);
          const filtered = entries.filter(([key, item]: [string, any]) => {
            const janMatch =
              item.janCode && String(item.janCode).toLowerCase().includes(q);
            const descMatch =
              item.description && item.description.toLowerCase().includes(q);
            const idMatch = key.toLowerCase().includes(q);
            return janMatch || descMatch || idMatch;
          });
          return filtered;
        })()
      : []
  ) as [string, any][];

  $: searchResults = allMatches.slice(0, 50);

  // Proposed Changes State
  let proposedQtys: Record<string, number> = {};
  let pendingRemovals = new Set<string>();
  let selectedItemToAdd: (Item & { id: string }) | null = null;
  let newSubtypeName = "New Variant";
  let newVariantQty = 0;

  let isInitialized = false;
  $: if (open && !isInitialized) {
    console.log("[VariantModal] Opening and initializing...", {
      associatedCount: associatedItems.length,
      mode,
      sourceItemId: sourceItem?.id,
    });

    // 1. Reset all state
    searchQuery = "";
    pendingRemovals = new Set<string>();
    proposedQtys = {};

    // 2. Initialize existing variants
    associatedItems.forEach((item) => {
      proposedQtys[item.id] = item.qty || 0;
    });

    // 3. Initialize addition/split source
    if (mode === "add" && sourceItem) {
      selectedItemToAdd = sourceItem;
      newSubtypeName = sourceItem.subtype || "Default";
      newVariantQty = sourceItem.qty || 0;
    } else {
      selectedItemToAdd = null;
      newSubtypeName = "New Variant";
      newVariantQty = 0;
    }

    isInitialized = true;
  }

  $: if (!open && isInitialized) {
    console.log("[VariantModal] Closing and clearing state.");
    isInitialized = false;
    // Clear to avoid stale data on next open
    proposedQtys = {};
    pendingRemovals = new Set<string>();
    selectedItemToAdd = null;
  }

  // Validation Logic
  // Total available is sum of all variants currently on listing
  // PLUS the quantity of any NEW item being brought in.
  $: totalAvailable = (() => {
    const existingTotal = associatedItems.reduce(
      (sum, i) => sum + (i.qty || 0),
      0,
    );
    if (selectedItemToAdd) {
      const isAlreadyOnListing = associatedItems.some(
        (i) => i.id === selectedItemToAdd?.id,
      );
      // If stealing or splitting a DIFFERENT item, add its quantity to the pool.
      // If splitting an item ALREADY on the listing, it's already in existingTotal.
      return isAlreadyOnListing
        ? existingTotal
        : existingTotal + (selectedItemToAdd.qty || 0);
    }
    return existingTotal;
  })();

  // Total allocated is sum of all proposed quantities for existing items
  // PLUS the quantity assigned to the new variant.
  $: totalAllocated = (() => {
    const existingAllocated = Object.values(proposedQtys).reduce(
      (sum, q) => sum + (q || 0),
      0,
    );
    return existingAllocated + (newVariantQty || 0);
  })();

  $: isAllocationValid = Math.abs(totalAllocated - totalAvailable) < 0.001;

  function toggleRemoval(id: string) {
    console.log("[VariantModal] toggleRemoval:", id);
    const next = new Set(pendingRemovals);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
      proposedQtys[id] = 0; // Zero out qty on removal
    }
    pendingRemovals = next;
  }

  function selectItem(key: string, item: any) {
    console.log("[VariantModal] selectItem:", key, item.description);
    selectedItemToAdd = { ...item, id: key };
    searchQuery = "";

    // If it's a new JAN or an item listed elsewhere, we use its current values as default
    // If it's an item ALREADY on the listing, it becomes a split source.
    newSubtypeName = selectedItemToAdd?.subtype || "Default";
    newVariantQty = 0; // Default new variant to 0 so user re-allocates from source
  }

  function handleSave() {
    const removals = Array.from(pendingRemovals);
    console.log("[VariantModal] handleSave", {
      mode,
      selectedItemId: selectedItemToAdd?.id,
      removals,
      proposedQtys,
    });

    if (mode === "add" && selectedItemToAdd) {
      // Check if we are splitting an existing variant (Same JAN)
      const existingMatchingJan = associatedItems.find(
        (i) => i.janCode === selectedItemToAdd?.janCode,
      );

      if (existingMatchingJan) {
        // CASE A: SPLIT
        dispatch("confirmSplit", {
          sourceId: existingMatchingJan.id,
          sourceSubtype: existingMatchingJan.subtype,
          sourceQty: proposedQtys[existingMatchingJan.id],
          newSubtype: newSubtypeName,
          newQty: newVariantQty,
          janCode: selectedItemToAdd.janCode,
          proposedQtys: { ...proposedQtys },
          removals,
        });
      } else {
        // CASE B: ADD NEW JAN
        dispatch("confirmAdd", {
          itemId: selectedItemToAdd.id,
          subtype: newSubtypeName,
          qty: newVariantQty,
          janCode: selectedItemToAdd.janCode,
          proposedQtys: { ...proposedQtys },
          removals,
        });
      }
    } else {
      // General "Manage" / Edit mode or specifically "Remove" triggered from top level
      dispatch("confirmManage", {
        proposedQtys: { ...proposedQtys },
        removals,
      });
    }
  }

  function handleCancel() {
    dispatch("cancel");
  }
</script>

{#if open}
  <div class="modal-backdrop">
    <div class="modal">
      <div class="modal-header">
        <h3 class="modal-title">
          {#if mode === "split"}Split Variant{:else if mode === "remove"}Remove
            Variant{:else}Add Variant{/if}
          {#if janCode}({janCode}){/if}
        </h3>
      </div>

      <div class="modal-body">
        {#if mode === "remove" && sourceItem}
          <div class="transfer-warning">
            Removing variant <strong>{sourceItem.subtype || "Default"}</strong>.
            All quantities must be re-allocated below.
          </div>
          {#if otherVariants.length > 0}
            <div class="transfer-quick-fix">
              <button
                class="quick-btn"
                on:click={() => {
                  if (otherVariants[0]) {
                    proposedQtys[otherVariants[0].id] += sourceItem?.qty || 0;
                    proposedQtys[sourceItem?.id || ""] = 0;
                  }
                }}
              >
                Transfer all {sourceItem.qty} to {otherVariants[0].subtype ||
                  "Default"}
              </button>
            </div>
          {/if}
        {/if}

        {#if mode === "add"}
          <div class="search-section">
            <label for="variant-search">Search Inventory to Add:</label>
            <input
              id="variant-search"
              type="text"
              placeholder="Search JAN or Title..."
              bind:value={searchQuery}
              on:input={(e) =>
                console.log(
                  "[VariantModal] Input event:",
                  e.currentTarget.value,
                )}
              class="search-input"
              autocomplete="off"
            />
            {#if searchResults.length > 0}
              <div class="search-results">
                {#each searchResults as [key, item]}
                  <button
                    class="result-item"
                    on:click={() => selectItem(key, item)}
                  >
                    <div class="result-thumb">
                      {#if item.image}
                        <ImageThumbnail
                          src={item.image}
                          alt={item.description}
                          width="30px"
                          height="30px"
                        />
                      {/if}
                    </div>
                    <div class="result-info">
                      <span class="result-jan">{item.janCode}</span>
                      <span class="result-desc">{item.description}</span>
                      <span class="result-meta">
                        {item.subtype || "Default"} - Qty: {item.qty}
                        {item.handle
                          ? `(Listed: ${item.handle})`
                          : "(Unlisted)"}
                      </span>
                    </div>
                  </button>
                {/each}
              </div>
            {/if}
          </div>

          {#if selectedItemToAdd}
            <div class="selected-item-box">
              <div class="item-header">
                <strong>Target:</strong>
                {selectedItemToAdd.description} ({selectedItemToAdd.janCode})
              </div>

              <div class="form-grid">
                <div class="form-group">
                  <label for="new-subtype">Subtype Name</label>
                  <input
                    id="new-subtype"
                    type="text"
                    bind:value={newSubtypeName}
                  />
                </div>
                <div class="form-group">
                  <label for="new-qty">Quantity</label>
                  <input
                    id="new-qty"
                    type="number"
                    bind:value={newVariantQty}
                  />
                </div>
              </div>
            </div>
          {/if}
        {/if}

        <div class="allocation-section">
          <div class="flex items-center justify-between mb-2">
            <h4 class="section-title m-0">
              Final Listing Variants & Allocations
            </h4>
            <div
              class="allocation-summary {isAllocationValid
                ? 'text-green-600'
                : 'text-red-600'}"
            >
              Total: <strong>{totalAllocated}</strong> / {totalAvailable}
            </div>
          </div>
          <div class="allocation-list">
            {#each associatedItems as item}
              <div
                class="allocation-row"
                class:is-source={selectedItemToAdd &&
                  item.id === selectedItemToAdd.id}
                class:is-removed={pendingRemovals.has(item.id)}
              >
                <div class="flex items-center gap-3">
                  <div class="alloc-thumb">
                    {#if item.image}
                      <ImageThumbnail
                        src={item.image}
                        alt={item.subtype}
                        width="32px"
                        height="32px"
                      />
                    {/if}
                  </div>
                  <div class="alloc-info">
                    <div class="flex items-center gap-2">
                      <span class="alloc-subtype"
                        >{item.subtype || "Default"}</span
                      >
                      {#if pendingRemovals.has(item.id)}
                        <span class="removed-badge">Removing</span>
                      {/if}
                    </div>
                    <span class="alloc-id">{item.id}</span>
                  </div>
                </div>
                <div class="alloc-input-group">
                  {#if !pendingRemovals.has(item.id)}
                    <label for="qty-{item.id}">Qty:</label>
                    <input
                      id="qty-{item.id}"
                      type="number"
                      bind:value={proposedQtys[item.id]}
                    />
                    <button
                      class="row-remove-btn"
                      on:click={(e) => {
                        e.stopPropagation();
                        toggleRemoval(item.id);
                      }}
                      title="Remove Variant"
                    >
                      ✕
                    </button>
                  {:else}
                    <button
                      class="row-restore-btn"
                      on:click={() => toggleRemoval(item.id)}>Restore</button
                    >
                  {/if}
                </div>
              </div>
            {/each}

            {#if selectedItemToAdd}
              {@const newItemId = selectedItemToAdd.id}
              {#if !associatedItems.find((i) => i.id === newItemId)}
                <div class="allocation-row is-new">
                  <div class="flex items-center gap-3">
                    <div class="alloc-thumb">
                      {#if selectedItemToAdd.image}
                        <ImageThumbnail
                          src={selectedItemToAdd.image}
                          alt={newSubtypeName}
                          width="32px"
                          height="32px"
                        />
                      {/if}
                    </div>
                    <div class="alloc-info">
                      <span class="alloc-subtype">{newSubtypeName} (New)</span>
                      <span class="alloc-id">{newItemId}</span>
                    </div>
                  </div>
                  <div class="alloc-input-group">
                    <span class="alloc-label">Qty:</span>
                    <span class="qty-preview">{newVariantQty}</span>
                  </div>
                </div>
              {/if}
            {/if}
          </div>
        </div>
      </div>

      <div class="modal-actions">
        <button class="btn-cancel" on:click={handleCancel}>Cancel</button>
        <button
          class="btn-save"
          on:click={handleSave}
          disabled={!isAllocationValid ||
            (mode === "add" &&
              !selectedItemToAdd &&
              pendingRemovals.size === 0)}
        >
          Confirm Changes
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
  }
  .modal {
    background: white;
    padding: 1.5rem;
    border-radius: 8px;
    width: 100%;
    max-width: 600px;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
  }
  .modal-header {
    margin-bottom: 1.5rem;
    border-bottom: 1px solid #eee;
    padding-bottom: 0.75rem;
  }
  .modal-title {
    font-weight: 600;
    font-size: 1.25rem;
    margin: 0;
  }
  .modal-body {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  /* Search */
  .search-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .search-input {
    width: 100%;
    padding: 0.6rem;
    border: 1px solid #d1d5db;
    border-radius: 4px;
  }
  .search-results {
    background: white;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
    max-height: 200px;
    overflow-y: auto;
  }
  .result-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.5rem;
    border: none;
    background: none;
    text-align: left;
    cursor: pointer;
    border-bottom: 1px solid #f3f4f6;
  }
  .result-item:hover {
    background: #f9fafb;
  }
  .result-info {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .result-jan {
    font-weight: 600;
    font-size: 0.85rem;
  }
  .result-desc {
    font-size: 0.8rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .result-meta {
    font-size: 0.75rem;
    color: #6b7280;
  }

  .transfer-warning {
    padding: 0.75rem;
    background: #fef2f2;
    border-left: 4px solid #ef4444;
    font-size: 0.85rem;
    color: #991b1b;
  }

  .transfer-quick-fix {
    margin-top: -0.5rem;
  }

  .quick-btn {
    background: #f3f4f6;
    border: 1px solid #d1d5db;
    padding: 0.35rem 0.75rem;
    border-radius: 4px;
    font-size: 0.8rem;
    cursor: pointer;
    transition: all 0.2s;
  }
  .quick-btn:hover {
    background: #e5e7eb;
    border-color: #9ca3af;
  }

  /* Selected Item */
  .selected-item-box {
    background: #eff6ff;
    border: 1px solid #bfdbfe;
    padding: 1rem;
    border-radius: 6px;
  }
  .item-header {
    font-size: 0.9rem;
    margin-bottom: 0.75rem;
  }
  .form-grid {
    display: grid;
    grid-template-columns: 1fr 100px;
    gap: 1rem;
  }

  /* Allocation */
  .section-title {
    font-size: 0.9rem;
    font-weight: 600;
    color: #374151;
    margin: 0 0 0.75rem 0;
    text-transform: uppercase;
    letter-spacing: 0.025em;
  }
  .allocation-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    overflow: hidden;
  }
  .allocation-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem;
    background: #fff;
    border-bottom: 1px solid #f3f4f6;
  }
  .allocation-row.is-removed {
    background: #fef2f2;
    opacity: 0.8;
  }
  .removed-badge {
    font-size: 0.65rem;
    background: #fee2e2;
    color: #991b1b;
    padding: 0.1rem 0.4rem;
    border-radius: 9999px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .row-remove-btn {
    background: none;
    border: none;
    color: #9ca3af;
    cursor: pointer;
    font-size: 0.8rem;
    padding: 0.25rem;
    margin-left: 0.5rem;
  }
  .row-remove-btn:hover {
    color: #ef4444;
  }
  .row-restore-btn {
    background: #f3f4f6;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    padding: 0.2rem 0.5rem;
    font-size: 0.75rem;
    cursor: pointer;
  }
  .row-restore-btn:hover {
    background: #e5e7eb;
  }
  .allocation-row:last-child {
    border-bottom: none;
  }
  .flex {
    display: flex;
  }
  .items-center {
    align-items: center;
  }
  .justify-between {
    justify-content: space-between;
  }
  .gap-2 {
    gap: 0.5rem;
  }
  .gap-3 {
    gap: 0.75rem;
  }
  .mb-2 {
    margin-bottom: 0.5rem;
  }
  .m-0 {
    margin: 0;
  }
  .text-green-600 {
    color: #16a34a;
  }
  .text-red-600 {
    color: #dc2626;
  }
  .allocation-summary {
    font-size: 0.85rem;
  }
  .allocation-row.is-source {
    background: #fffbeb;
  }
  .allocation-row.is-new {
    background: #ecfdf5;
  }
  .alloc-info {
    display: flex;
    flex-direction: column;
  }
  .alloc-subtype {
    font-weight: 600;
    font-size: 0.9rem;
  }
  .alloc-id {
    font-size: 0.7rem;
    color: #9ca3af;
    font-family: monospace;
  }
  .alloc-thumb {
    width: 32px;
    height: 32px;
    background: #f3f4f6;
    border-radius: 4px;
    overflow: hidden;
    flex-shrink: 0;
  }
  .alloc-label {
    font-size: 0.8rem;
    font-weight: 600;
    color: #6b7280;
  }
  .alloc-input-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .alloc-input-group input {
    width: 70px;
    padding: 0.3rem;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    text-align: center;
  }

  .form-group label {
    font-size: 0.8rem;
    font-weight: 600;
    color: #4b5563;
    display: block;
    margin-bottom: 0.25rem;
  }
  .form-group input {
    width: 100%;
    padding: 0.4rem;
    border: 1px solid #d1d5db;
    border-radius: 4px;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 2rem;
    gap: 0.75rem;
    padding-top: 1rem;
    border-top: 1px solid #eee;
  }
  .btn-cancel {
    padding: 0.5rem 1rem;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    background: white;
    cursor: pointer;
    font-weight: 500;
  }
  .btn-save {
    padding: 0.5rem 1.5rem;
    border-radius: 6px;
    background: #2563eb;
    color: white;
    border: none;
    cursor: pointer;
    font-weight: 600;
  }
  .btn-save:disabled {
    background: #9ca3af;
    cursor: not-allowed;
  }
</style>
