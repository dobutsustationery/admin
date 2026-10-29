<script lang="ts">
  import ImageThumbnail from "./ImageThumbnail.svelte";
  import { shopifyDiffImageUrl } from "$lib/shopify-diff-images";
  export let value: unknown;
  export let sourceUrls: string[] = [];
  export let alt = "Product image";
  $: src = shopifyDiffImageUrl(value, sourceUrls);
</script>

{#if src}
  <a
    class="diff-image"
    href={src}
    target="_blank"
    rel="noreferrer"
    aria-label={`Open ${alt}`}
  >
    <ImageThumbnail {src} {alt} width="80px" height="80px" fit="contain" />
    <small>Open full size</small>
  </a>
{:else}
  <span class="missing-image">No image</span>
{/if}

<style>
  .diff-image {
    display: inline-flex;
    flex-direction: column;
    gap: 0.3rem;
    align-items: center;
    text-decoration: none;
  }
  small {
    font-size: 0.75rem;
  }
  .missing-image {
    color: #6b7280;
  }
</style>
