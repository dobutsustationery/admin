<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { ImportPlan, PlanConflict, PlanMatch, PlanNewItem } from '$lib/import-logic';

  export let plan: ImportPlan;

  const dispatch = createEventDispatcher();

  function resolveConflict(conflict: PlanConflict) {
    dispatch('resolve', conflict);
  }

  function commit() {
    dispatch('commit');
  }

  function cancel() {
    dispatch('cancel');
  }

  $: totalItems = plan.summary.totalRows;
  $: validItems = plan.summary.validRows;
  $: hasConflicts = plan.conflicts.length > 0;
  $: readyToCommit = !hasConflicts && (plan.matches.length > 0 || plan.newItems.length > 0);
</script>

<div class="summary-container">
  <div class="header">
      <h2>Import Summary</h2>
      <div class="stats">
          <div class="stat">
              <span class="val">{plan.summary.totalQty}</span>
              <span class="label">Total Qty</span>
          </div>
          <div class="stat">
              <span class="val">{plan.matches.length}</span>
              <span class="label">Matches</span>
          </div>
          <div class="stat">
              <span class="val">{plan.newItems.length}</span>
              <span class="label">New Items</span>
          </div>
          <div class="stat warning" class:active={hasConflicts}>
              <span class="val">{plan.conflicts.length}</span>
              <span class="label">Conflicts</span>
          </div>
      </div>
  </div>

  {#if hasConflicts}
      <div class="section conflicts">
          <h3>⚠️ Needs Attention ({plan.conflicts.length})</h3>
          <p class="help-text">These JAN codes match multiple subtypes. Please specify quantities.</p>
          <div class="list">
              {#each plan.conflicts as conflict}
                  <div class="item-row conflict">
                      <div class="info">
                          <strong>{conflict.janCode}</strong>
                          <span>Total: {conflict.totalQty}</span>
                      </div>
                      <button class="btn-resolve" on:click={() => resolveConflict(conflict)}>
                          Resolve
                      </button>
                  </div>
              {/each}
          </div>
      </div>
  {/if}

  <div class="columns">
      <div class="section">
          <h3>✅ Ready to Update ({plan.matches.length})</h3>
          <div class="list scrollable">
              {#each plan.matches as match}
                  <div class="item-row">
                      <div class="info">
                          <strong>{match.item.description}</strong>
                          <span class="sub">{match.janCode} {match.item.subtype ? `(${match.item.subtype})` : ''}</span>
                      </div>
                      <span class="qty">+{match.addQty}</span>
                  </div>
              {/each}
          </div>
      </div>

      <div class="section">
          <h3>🆕 New Items ({plan.newItems.length})</h3>
          <div class="list scrollable">
              {#each plan.newItems as item}
                  <div class="item-row">
                      <div class="info">
                          <strong>Unknown Item</strong>
                          <span class="sub">{item.janCode}</span>
                      </div>
                      <span class="qty">+{item.qty}</span>
                  </div>
              {/each}
          </div>
      </div>
  </div>

  <div class="footer-actions">
      <button class="btn-cancel" on:click={cancel}>Cancel Import</button>
      <button class="btn-commit" disabled={!readyToCommit} on:click={commit}>
          {hasConflicts ? 'Resolve Conflicts First' : 'Confirm & Update Inventory'}
      </button>
  </div>
</div>

<style>
  .summary-container {
      background: white;
      border-radius: 8px;
      padding: 24px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  }

  .header {
      margin-bottom: 24px;
      border-bottom: 1px solid #e5e7eb;
      padding-bottom: 16px;
  }
  
  h2 { margin-top: 0; margin-bottom: 16px; }
  h3 { margin-top: 0; font-size: 1.1em; }

  .stats {
      display: flex;
      gap: 24px;
  }

  .stat {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 12px 24px;
      background: #f9fafb;
      border-radius: 6px;
  }

  .stat.warning.active {
      background: #fef2f2;
      color: #dc2626;
      border: 1px solid #fecaca;
  }

  .val { font-size: 1.5em; font-weight: bold; }
  .label { font-size: 0.85em; color: #6b7280; }

  .columns {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      margin-bottom: 24px;
  }

  .section {
      background: #f9fafb;
      border-radius: 6px;
      padding: 16px;
  }

  .conflicts {
      background: #fff1f2;
      border: 1px solid #fecaca;
      margin-bottom: 24px;
  }

  .help-text { font-size: 0.9em; color: #b91c1c; margin-bottom: 12px; }

  .list {
      display: flex;
      flex-direction: column;
      gap: 8px;
  }

  .list.scrollable {
      max-height: 300px;
      overflow-y: auto;
  }

  .item-row {
      background: white;
      padding: 10px;
      border-radius: 4px;
      border: 1px solid #e5e7eb;
      display: flex;
      justify-content: space-between;
      align-items: center;
  }

  .item-row.conflict {
      border-left: 4px solid #dc2626;
  }

  .info { display: flex; flex-direction: column; }
  .sub { font-size: 0.8em; color: #6b7280; }
  .qty { font-weight: bold; color: #059669; }

  .btn-resolve {
      background: #dc2626;
      color: white;
      border: none;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
  }

  .footer-actions {
      display: flex;
      justify-content: flex-end;
      gap: 16px;
      padding-top: 16px;
      border-top: 1px solid #e5e7eb;
  }

  .btn-cancel {
      background: #e5e7eb;
      color: #374151;
      border: none;
      padding: 10px 20px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 500;
  }

  .btn-commit {
      background: #059669;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 500;
  }

  .btn-commit:disabled {
      background: #d1fae5;
      color: #065f46;
      cursor: not-allowed;
  }
</style>
