<script lang="ts">
  import ImageThumbnail from "./ImageThumbnail.svelte";
  import type { ImageSize } from "$lib/drive-url";

  export let src: string;
  export let alt: string;
  let dimensions: { source: string; width: number; height: number } | undefined;

  function loaded(
    event: CustomEvent<{ width: number; height: number; size: ImageSize }>,
  ) {
    if (event.detail.size !== "full") return;
    dimensions = {
      source: src,
      width: event.detail.width,
      height: event.detail.height,
    };
  }
</script>

<div class="repair-image">
  {#key src}
    <ImageThumbnail
      {src}
      {alt}
      size="full"
      width="100%"
      height="320px"
      fit="contain"
      on:loadsuccess={loaded}
    />
  {/key}
  <p class="dimensions">
    {#if dimensions?.source === src}{dimensions.width} × {dimensions.height} px{:else}Loading
      dimensions…{/if}
  </p>
</div>

<style>
  .dimensions {
    margin: 0.4rem 0 0;
    color: #555;
    font-size: 0.9rem;
  }
</style>
