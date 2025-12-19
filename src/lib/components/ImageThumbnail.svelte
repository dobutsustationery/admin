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
    
    const spaceAbove = mouseY;
    const spaceBelow = winHeight - mouseY;
    
    let style = "left: 50%; transform: translateX(-50%); position: fixed; z-index: 9999;";
    
    if (spaceAbove > spaceBelow) {
        // Show ABOVE
        style += ` bottom: ${winHeight - rect.top + 10}px; top: auto;`;
    } else {
        // Show BELOW
        style += ` top: ${rect.bottom + 10}px; bottom: auto;`;
    }
    
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
</script>

<div 
  class="thumbnail-container {className}" 
  style="width: {width}; height: {height};"
  on:mouseenter={handleMouseEnter}
  on:mouseleave={handleMouseLeave}
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
            src={src.includes("drive.google.com") ? `${src}&sz=w800` : `${src}=w800`}
            alt={alt} 
            className="zoomed-image"
        />
        {#if alt}
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
      max-width: 80vh; /* Max constrained */
      max-height: 50vh;
  }
  
  /* Deep selector to constrain the image inside the overlay */
  :global(.zoom-overlay .zoomed-image) {
      max-height: 45vh;
      width: auto;
      object-fit: contain;
      border-radius: 0.25rem;
  }
</style>
