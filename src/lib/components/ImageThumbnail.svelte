<script lang="ts">
  import { fade } from 'svelte/transition';
  import SecureImage from "$lib/components/SecureImage.svelte";

  export let src: string;
  export let alt: string = "";
  // Size props can be CSS values (e.g. "100%", "300px", "10rem")
  export let width: string = "100%";
  export let height: string = "100%";
  
  // Fit mode: 
  // 'contain' = maintain aspect ratio, show full image, letterbox
  // 'cover' = fill container, crop image
  export let fit: "contain" | "cover" = "cover";
  
  // Optional specific class overrides
  export let className: string = "";
  
  // Zoom functionality
  export let zoomable: boolean = true;

  let isHovered = false;
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let zoomStyle = "";

  function handleMouseEnter(e: MouseEvent) {
    if (!zoomable) return;
    
    // Clear any pending leave
    if (hoverTimer) clearTimeout(hoverTimer);
    
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const mouseY = rect.top + (rect.height / 2);
    const winHeight = window.innerHeight;
    
    // Calculate position
    const outputRectWidth = 400; // Expected generic width of zoom tooltip
    
    // Default style: Centered vertically relative to mouse/element, but pushed to side?
    // Inherited logic was Above/Below. Let's stick to that as it works well for grids.
    
    const spaceAbove = rect.top;
    const spaceBelow = winHeight - rect.bottom;
    
    // Default style: Centered horizontally
    let style = "left: 50%; transform: translateX(-50%); position: fixed; z-index: 9999;";
    let availableHeight = 0;

    // Prefer side with more space
    if (spaceAbove > spaceBelow) {
        // Show ABOVE
        // Bottom is fixed to just above the element
        const bottomPos = winHeight - rect.top + 10;
        style += ` bottom: ${bottomPos}px; top: auto;`;
        availableHeight = rect.top - 20; // 20px padding from screen top
    } else {
        // Show BELOW
        const topPos = rect.bottom + 10;
        style += ` top: ${topPos}px; bottom: auto;`;
        availableHeight = winHeight - rect.bottom - 20; // 20px padding from screen bottom
    }
    
    // Enforce constraints
    style += ` max-height: ${availableHeight}px;`;
    
    zoomStyle = style;

    // Small delay to prevent flashing
    hoverTimer = setTimeout(() => {
        isHovered = true;
    }, 200);
  }

  function handleMouseLeave() {
     if (hoverTimer) clearTimeout(hoverTimer);
     isHovered = false;
  }

  // Compute high-res URL for zoom
  $: zoomedSrc = (() => {
      if (src.includes("drive.google.com/thumbnail")) {
          // Force high resolution for Drive thumbnails
          // Check if already has sz param? Assuming we append or replace.
          // Simplest is to append, last param wins usually or it's unique.
          return src.includes("sz=") ? src.replace(/sz=[^&]+/, "sz=w1600") : `${src}&sz=w1600`;
      } 
      if (src.includes("googleusercontent.com")) {
          // Strip params and request high res
          return src.replace(/=[a-z0-9,-]+$/i, "") + "=w1600";
      }
      // For others, use original source (often high res enough)
      return src;
  })();
</script>

<div 
  class="thumbnail-container {className}" 
  style="width: {width}; height: {height};"
  on:mouseenter={handleMouseEnter}
  on:mouseleave={handleMouseLeave}
  role="figure"
>
  <div class="image-wrapper">
    <SecureImage 
      {src} 
      {alt} 
      className="secure-image"
      style="object-fit: {fit};"
    />
  </div>
</div>

{#if isHovered && zoomable}
    <div 
        class="zoom-overlay"
        style={zoomStyle}
        transition:fade={{ duration: 150 }}
    >
                <SecureImage
                    src={zoomedSrc}
                    alt={alt}
                    className="zoomed-image"
                />        {#if alt}
            <div class="bg-black/70 text-white text-xs px-2 py-1 mt-1 rounded max-w-[300px] truncate">
                {alt}
            </div>
        {/if}
    </div>
{/if}

<style>
  .thumbnail-container {
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    position: relative;
    background-color: #f3f4f6; /* bg-gray-100 */
    border-radius: 0.5rem;   /* rounded-lg */
    border: 1px solid #e5e7eb; /* border-gray-200 */
    cursor: pointer;
  }

  .image-wrapper {
    width: 100%;
    height: 100%;
    display: flex; /* flex needed to properly center absolute positioned children or contained images */
  }
  
  .zoom-overlay {
      background: white;
      padding: 0.5rem;
      border-radius: 0.5rem;
      border: 1px solid #e5e7eb;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1); /* shadow-xl */
      pointer-events: none; /* Pass through clicks */
      display: flex;
      flex-direction: column;
      align-items: center;
      width: auto;
      max-width: 90vw; /* Max constrained */
      /* max-height handled by inline style */
  }
  
  /* Deep selector to constrain the image inside the overlay */
  :global(.zoom-overlay .zoomed-image) {
      max-height: 100%; /* Fill the container's calculated max-height */
      width: auto;
      object-fit: contain;
      border-radius: 0.25rem;
  }
</style>
