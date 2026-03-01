<script lang="ts">
  import { activeBanners } from "$lib/banner-store";
  import { store } from "$lib/store";
  import SyncQueueStatusBar from "$lib/components/SyncQueueStatusBar.svelte";

  // The hedgehog progress is global, so we always show it inside the sticky container
  // if it wants to be visible.
  $: syncQueue = $store.syncQueue;
</script>

<div
  class="sticky-banner-container"
  class:has-content={syncQueue?.queuedCount > 0 ||
    syncQueue?.processingCount > 0 ||
    $activeBanners.length > 0}
>
  <!-- Hedgehog Global Sync Status -->
  <SyncQueueStatusBar {syncQueue} />

  <!-- Dynamic Banners from Pages -->
  {#each $activeBanners as banner (banner.id)}
    <svelte:component this={banner.component} {...banner.props} />
  {/each}
</div>

<style>
  .sticky-banner-container {
    position: sticky;
    top: 0;
    left: 0;
    right: 0;
    z-index: 100;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    pointer-events: none;
    margin-bottom: 0;
    transition: padding 0.2s ease;
  }

  .sticky-banner-container.has-content {
    padding: 0.5rem 1rem;
    margin-bottom: 1rem;
  }

  .sticky-banner-container > :global(*) {
    pointer-events: auto;
  }
</style>
