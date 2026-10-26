<script lang="ts">
  import { activeBanners } from "$lib/banner-store";
  import { store } from "$lib/store";
  import SyncQueueStatusBar from "$lib/components/SyncQueueStatusBar.svelte";

  import { onDestroy } from "svelte";
  import {
    collection,
    query,
    orderBy,
    limit,
    onSnapshot,
  } from "firebase/firestore";
  import { firestore } from "$lib/firebase";
  import { user } from "$lib/user-store";
  let scan: any = null;
  let scanError = "";
  let listeningFor = "";
  let stopScan = () => {};
  $: if (($user?.uid || "") !== listeningFor) {
    stopScan();
    listeningFor = $user?.uid || "";
    scan = null;
    scanError = "";
    if (listeningFor)
      stopScan = onSnapshot(
        query(
          collection(firestore, "amazon_catalog_scans"),
          orderBy("startedAt", "desc"),
          limit(1),
        ),
        (snapshot) => {
          scan = snapshot.docs[0]?.data() || null;
          scanError = "";
        },
        (error) => {
          scanError = `Amazon scan progress unavailable: ${error.message}`;
        },
      );
  }
  onDestroy(() => stopScan());

  // The hedgehog progress is global, so we always show it inside the sticky container
  // if it wants to be visible.
  $: syncQueue = $store.syncQueue;
</script>

<div
  class="sticky-banner-container"
  class:has-content={syncQueue?.queuedCount > 0 ||
    syncQueue?.processingCount > 0 ||
    $activeBanners.length > 0 ||
    scan?.status === "running" ||
    Boolean(scanError)}
>
  <!-- Hedgehog Global Sync Status -->
  <SyncQueueStatusBar {syncQueue} {scan} />
  {#if scanError}<p role="alert">{scanError}</p>{/if}

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
