<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import ImageThumbnail from "$lib/components/ImageThumbnail.svelte";

  export let item: any;
  export let col: any;
  export let index: number;

  const dispatch = createEventDispatcher();

  $: imageUrl = item[col.field];

  function handleClick() {
    dispatch("imagePick");
  }
</script>

<div 
    class="image-cell" 
    on:click={handleClick}
    role="button"
    tabindex="0"
    on:keydown={(e) => e.key === 'Enter' && handleClick()}
>
    {#if imageUrl}
        <ImageThumbnail src={imageUrl} alt="Thumbnail" />
    {:else}
        <span class="placeholder">Add</span>
    {/if}
</div>

<style>
    .image-cell {
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        padding: 2px;
    }
    
    .image-cell:hover {
        background-color: #f3f4f6;
    }

    .placeholder {
        color: #9ca3af;
        font-size: 0.75rem;
        font-style: italic;
    }
</style>
