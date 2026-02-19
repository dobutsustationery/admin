<script lang="ts">
  import { fade } from 'svelte/transition';
  import SecureImage from "$lib/components/SecureImage.svelte";

  export let show: boolean = false;
  export let src: string;
  export let alt: string = "";
  export let style: string = "";
  let className: string = "";
  export { className as class };

  // Compute high-res URL for zoom
  $: zoomedSrc = (() => {
      if (!src) return "";
      if (src.includes("drive.google.com/thumbnail")) {
          // Force high resolution for Drive thumbnails
          return src.includes("sz=") ? src.replace(/sz=[^&]+/, "sz=w1600") : `${src}&sz=w1600`;
      } 
      if (src.includes("googleusercontent.com")) {
          // Strip params and request high res
          return src.replace(/=[a-z0-9,-]+$/i, "") + "=w1600";
      }
      return src;
  })();
</script>

{#if show && src}
    <div 
        class="image-preview-overlay {className}"
        {style}
        transition:fade={{ duration: 150 }}
    >
        <SecureImage
            src={zoomedSrc}
            {alt}
            className="zoomed-image"
        />
        {#if alt}
            <div class="alt-text">
                {alt}
            </div>
        {/if}
    </div>
{/if}

<style>
  .image-preview-overlay {
      background: white;
      padding: 0.5rem;
      border-radius: 0.5rem;
      border: 1px solid #e5e7eb;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
      pointer-events: none;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      position: fixed;
      z-index: 9999;
      box-sizing: border-box;
      /* Dimensions are set via inline style */
  }
  
  :global(.image-preview-overlay .zoomed-image) {
      width: 100%;
      height: 100%;
      object-fit: contain;
      border-radius: 0.25rem;
      flex-shrink: 1;
      min-width: 0;
      min-height: 0;
  }

  .alt-text {
      background-color: rgba(0, 0, 0, 0.7);
      color: white;
      font-size: 0.75rem;
      padding: 0.25rem 0.5rem;
      margin-top: 0.25rem;
      border-radius: 0.25rem;
      max-width: 300px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
  }
</style>
