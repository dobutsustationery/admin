<script lang="ts">
  import { fade } from 'svelte/transition';
  import SecureImage from "$lib/components/SecureImage.svelte";
  import ImagePreviewOverlay from "$lib/components/ImagePreviewOverlay.svelte";

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
  
  // Upload status
  export let isUploading: boolean = false;

  let isHovered = false;
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let zoomStyle = "";

  function handleMouseEnter(e: MouseEvent) {
    if (!zoomable) return;
    
    // Clear any pending leave
    if (hoverTimer) clearTimeout(hoverTimer);
    
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const winHeight = window.innerHeight;
    
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
    
    // Pass constraint to image via CSS variable, reserving space for text/padding (approx 40px)
    // We don't constrain the container height directly, we let content drive it up to the limit.
    style += ` --max-img-height: ${Math.max(100, availableHeight - 40)}px;`;
    
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
  role="figure"
>
  <div class="image-wrapper">
    <SecureImage 
      {src} 
      {alt} 
      {isUploading}
      className="secure-image"
      style="object-fit: {fit};"
    />
  </div>
</div>

<ImagePreviewOverlay 
    show={isHovered && zoomable}
    {src}
    {alt}
    style={zoomStyle}
    class="pointer-events-none"
/>

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
</style>
