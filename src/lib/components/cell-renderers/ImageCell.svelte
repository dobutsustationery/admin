<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import SecureImage from "$lib/components/SecureImage.svelte";

  export let item: any;
  export let col: any; // Column Config

  $: src = item[col.field] || item._thumbnail;

  const dispatch = createEventDispatcher();

  function handlePick() {
      dispatch("imagePick", { item, col });
  }
</script>

<div class="cell-image-container">
    {#if src}
        <button class="cell-image-btn" on:click={handlePick} title="Pick image">
            <SecureImage src={src} alt="Validation" className="cell-image" />
        </button>
    {:else}
        <button class="no-image" on:click={handlePick} title="Pick image">No Img</button>
    {/if}
</div>

<style>
    .cell-image-container {
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 2px;
    }

    .cell-image {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        border-radius: 2px;
    }

    .cell-image-btn {
        border: none;
        background: transparent;
        padding: 0;
        cursor: pointer;
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .no-image {
        font-size: 0.7rem;
        color: #9ca3af;
        border: none;
        background: transparent;
        cursor: pointer;
        padding: 0;
    }
</style>
