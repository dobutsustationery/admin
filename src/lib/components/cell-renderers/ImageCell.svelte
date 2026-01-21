<script lang="ts">
  export let item: any;
  export let col: any; // Column Config

  $: src = item[col.field] || item._thumbnail;
</script>

<div class="cell-image-container">
    {#if src}
        <img src={src} alt="Validation" class="cell-image" loading="lazy" />
    {:else}
        <div class="no-image">No Img</div>
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

    .no-image {
        font-size: 0.7rem;
        color: #9ca3af;
    }
</style>
