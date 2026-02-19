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
    const winHeight = document.documentElement.clientHeight;
    const winWidth = document.documentElement.clientWidth;

    // Get image aspect ratio
    const img = target.querySelector('img');
    const naturalWidth = img?.naturalWidth || 1;
    const naturalHeight = img?.naturalHeight || 1;
    const ratio = (naturalWidth && naturalHeight) ? naturalWidth / naturalHeight : 1;

    // Define available spaces with 5% margin
    const MARGIN_FACTOR = 0.95;

    const spaces = [
        {
            name: 'top',
            availableW: winWidth,
            availableH: rect.top,
            centerX: winWidth / 2,
            centerY: rect.top / 2
        },
        {
            name: 'bottom',
            availableW: winWidth,
            availableH: winHeight - rect.bottom,
            centerX: winWidth / 2,
            centerY: rect.bottom + (winHeight - rect.bottom) / 2
        },
        {
            name: 'left',
            availableW: rect.left,
            availableH: winHeight,
            centerX: rect.left / 2,
            centerY: winHeight / 2
        },
        {
            name: 'right',
            availableW: winWidth - rect.right,
            availableH: winHeight,
            centerX: rect.right + (winWidth - rect.right) / 2,
            centerY: winHeight / 2
        }
    ];

    let bestSpace = spaces[0];
    let maxArea = 0;
    let bestFit = { width: 0, height: 0 };

    for (const space of spaces) {
        // Calculate max usable dimensions for the container in this space
        const usableW = space.availableW * MARGIN_FACTOR;
        const usableH = space.availableH * MARGIN_FACTOR;

        // Calculate potential image dimensions within this space to determine area
        let fitW = usableW;
        let fitH = fitW / ratio;

        if (fitH > usableH) {
            fitH = usableH;
            fitW = fitH * ratio;
        }

        const area = fitW * fitH;
        if (area > maxArea) {
            maxArea = area;
            bestSpace = space;
            bestFit = { width: fitW, height: fitH };
        }
    }

    // Apply style for the winner
    // We position the center of the fixed overlay at the center of the available space
    // And set the explicit size of the container to the fitted image size
    
    zoomStyle = `
        left: ${bestSpace.centerX}px; 
        top: ${bestSpace.centerY}px; 
        width: ${bestFit.width}px;
        height: ${bestFit.height}px;
        transform: translate(-50%, -50%); 
        position: fixed; 
        z-index: 9999;
    `;

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
