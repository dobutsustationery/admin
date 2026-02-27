<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import type { Item } from "$lib/inventory";

  export let open = false;
  export let mode: "add" | "split" | "remove" = "add";
  export let janCode = "";
  export let sourceItem: (Item & { id: string }) | null = null;
  export let otherVariants: any[] = []; // Potential targets for transfer

  // Modal State
  let subtypeName = "New Variant";
  let qty = 0;

  // For split mode
  let sourceSubtypeName = "";
  let sourceQty = 0;
  let totalAvailable = 0;

  // For remove mode
  let transferTargetId = "";

  const dispatch = createEventDispatcher();

  $: if (open) {
    if (mode === "split" && sourceItem) {
      sourceSubtypeName = sourceItem.subtype || "Default";
      sourceQty = sourceItem.qty;
      totalAvailable = sourceItem.qty;
      subtypeName = "New Variant";
      qty = 0;
    } else if (mode === "remove" && sourceItem) {
      subtypeName = sourceItem.subtype || "Default";
      qty = sourceItem.qty;
      // Default to first other variant
      if (otherVariants.length > 0) {
        transferTargetId = otherVariants[0].id;
      }
    } else if (sourceItem) {
      subtypeName = sourceItem.subtype || "Default";
      qty = sourceItem.qty;
    } else {
      subtypeName = "New Variant";
      qty = 0;
    }
  }

  function handleSave() {
    if (mode === "split") {
      if (sourceQty + qty !== totalAvailable) {
        alert(`Total quantity must equal ${totalAvailable}`);
        return;
      }
      dispatch("confirmSplit", {
        sourceId: sourceItem?.id,
        sourceSubtype: sourceSubtypeName,
        sourceQty,
        newSubtype: subtypeName,
        newQty: qty,
      });
    } else if (mode === "remove") {
      dispatch("confirmRemove", {
        sourceId: sourceItem?.id,
        targetId: transferTargetId,
        qty: qty,
      });
    } else {
      dispatch("confirmAdd", {
        itemId: sourceItem?.id,
        subtype: subtypeName,
        qty,
      });
    }
  }

  function handleCancel() {
    dispatch("cancel");
  }

  function balanceSource() {
    if (mode === "split") {
      sourceQty = Math.max(0, totalAvailable - qty);
    }
  }

  function balanceNew() {
    if (mode === "split") {
      qty = Math.max(0, totalAvailable - sourceQty);
    }
  }
</script>

{#if open}
  <div class="modal-backdrop">
    <div class="modal">
      <div class="modal-header">
        <h3 class="modal-title">
          {#if mode === "split"}Split Variant{:else if mode === "remove"}Remove
            Variant{:else}Add Variant{/if} ({janCode})
        </h3>
      </div>

      <div class="modal-body">
        {#if mode === "split" && sourceItem}
          <div class="split-warning">
            Splitting existing inventory for JAN {janCode}. Total available:
            <strong>{totalAvailable}</strong>
          </div>

          <div class="variant-form">
            <div class="form-group">
              <label for="split-source-name">Original Subtype Name</label>
              <input
                id="split-source-name"
                type="text"
                bind:value={sourceSubtypeName}
              />
            </div>
            <div class="form-group">
              <label for="split-source-qty">Original Quantity</label>
              <input
                id="split-source-qty"
                type="number"
                bind:value={sourceQty}
                on:input={balanceNew}
                min="0"
                max={totalAvailable}
              />
            </div>

            <div class="divider"></div>

            <div class="form-group">
              <label for="split-new-name">New Subtype Name</label>
              <input
                id="split-new-name"
                type="text"
                bind:value={subtypeName}
                placeholder="e.g. Red, XL, etc."
              />
            </div>
            <div class="form-group">
              <label for="split-new-qty">New Quantity</label>
              <input
                id="split-new-qty"
                type="number"
                bind:value={qty}
                on:input={balanceSource}
                min="0"
                max={totalAvailable}
              />
            </div>
          </div>
        {:else if mode === "remove" && sourceItem}
          <div class="split-warning">
            Removing variant <strong>{subtypeName}</strong>. Current quantity:
            <strong>{qty}</strong>
          </div>

          <div class="variant-form">
            <div class="form-group">
              <label for="remove-transfer-target">Transfer quantity to:</label>
              <select id="remove-transfer-target" bind:value={transferTargetId}>
                <option value="">(None - leave as unlisted inventory)</option>
                {#each otherVariants as v}
                  <option value={v.id}>{v.subtype || "Default"} ({v.id})</option
                  >
                {/each}
              </select>
            </div>

            {#if transferTargetId}
              <div class="transfer-info">
                All {qty} units will be merged into the selected variant.
              </div>
            {/if}
          </div>
        {:else if sourceItem}
          <div class="transfer-info">
            Transferring item <strong>{sourceItem.id}</strong>
            {#if sourceItem.handle}
              from listing <strong>{sourceItem.handle}</strong>
            {:else}
              from unlisted inventory
            {/if}
          </div>

          <div class="variant-form">
            <div class="form-group">
              <label for="add-subtype-name">Subtype Name</label>
              <input
                id="add-subtype-name"
                type="text"
                bind:value={subtypeName}
              />
            </div>
            <div class="form-group">
              <label for="add-qty">Quantity</label>
              <input id="add-qty" type="number" bind:value={qty} min="0" />
            </div>
          </div>
        {:else}
          <div class="error">
            No inventory found for JAN {janCode}.
          </div>
        {/if}
      </div>

      <div class="modal-actions">
        <button class="btn-cancel" on:click={handleCancel}>Cancel</button>
        <button class="btn-save" on:click={handleSave} disabled={!sourceItem}>
          Confirm
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
    max-width: 450px;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
  }
  .modal-header {
    margin-bottom: 1.5rem;
  }
  .modal-title {
    font-weight: 600;
    font-size: 1.2rem;
    margin: 0;
  }
  .modal-body {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .split-warning,
  .transfer-info {
    padding: 0.75rem;
    background: #fef3c7;
    border-left: 4px solid #f59e0b;
    font-size: 0.9rem;
    color: #92400e;
    line-height: 1.4;
  }
  .variant-form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .form-group label {
    font-size: 0.85rem;
    font-weight: 600;
    color: #4b5563;
  }
  .form-group input,
  .form-group select {
    padding: 0.5rem;
    border: 1px solid #d1d5db;
    border-radius: 4px;
    font-size: 0.95rem;
  }
  .divider {
    height: 1px;
    background: #e5e7eb;
    margin: 0.5rem 0;
  }
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 2rem;
    gap: 0.75rem;
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
  .error {
    color: #ef4444;
    font-weight: 500;
  }
</style>
