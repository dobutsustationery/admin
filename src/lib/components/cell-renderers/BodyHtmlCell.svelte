<script lang="ts">
  import { createEventDispatcher } from "svelte";

  export let item: any;
  export let col: any;

  const dispatch = createEventDispatcher();

  function openEditor() {
    dispatch("editHtml", { item });
  }
</script>

<div class="cell-container">
  <button class="body-btn" on:click={openEditor} title="Edit description">
    {#if item[col.field]}
      <span class="body-preview">{item[col.field].replace(/<[^>]+>/g, "").slice(0, 48) || "Edit"}</span>
    {:else}
      <span class="body-placeholder">Add HTML</span>
    {/if}
  </button>
</div>

<style>
  .cell-container {
    display: flex;
    align-items: center;
    height: 100%;
    width: 100%;
    padding: 0 0.5rem;
  }
  .body-btn {
    width: 100%;
    text-align: left;
    border: none;
    background: transparent;
    cursor: pointer;
    padding: 0.25rem 0;
    color: #1f2937;
  }
  .body-preview {
    display: inline-block;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .body-placeholder {
    color: #9ca3af;
  }
</style>
