<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getStoredToken } from "$lib/google-photos";

  export let src: string; // The base URL
  export let alt: string = "";
  export let className: string = "";
  export let style: string = "";
  export let isUploading: boolean = false;
  export let fillParent: boolean = true; 

  let objectUrl: string = "";
  let error = "";
  let loading = true;

  import { imageQueue } from "$lib/image-queue";

  async function loadImage() {
    // Reset state
    // Reset state but KEEP objectUrl for overlay effect until new one is ready
    loading = true;
    error = "";
    // if (objectUrl) URL.revokeObjectURL(objectUrl); // Don't revoke yet!
    // objectUrl = ""; // Keep it!

    // Handle local/generated images directly
    // Also bypass fetch for Google and Drive URLs to avoid CORS (they don't need Auth header if public/token in URL)
    // CRITICAL: googleapis.com contains Drive API links (files.get) which REQUIRE Auth headers.
    // googleusercontent.com (Photos) might or might not, but we usually try auth.
    // So we only bypass if it's NOT one of those.
    const needsAuth = src.includes("googleusercontent.com") || src.includes("googleapis.com");
    
    if (
        src.startsWith("data:") || 
        src.startsWith("blob:") || 
        !needsAuth
    ) {
      if (objectUrl && objectUrl !== src) URL.revokeObjectURL(objectUrl);
      objectUrl = src;
      loading = false;
      return;
    }
    
    // Check global token for authenticated Google Photos items
    const token = getStoredToken();
    if (!token && src.includes("googleusercontent.com")) {
         console.warn("[SecureImage] No token available for", src);
         // Should we error or try anonymous?
         // Many drive links ARE public. Let's try queueing it plainly?
         // But the logic below assumes we need auth if it gets here.
         // Let's assume if we have a token, we use it. If not, we try without?
    }

    // Wrap fetch in Queue
    try {
             const headers: any = {};
             
             // Simple Auth Rule: If it's a Drive API URL, it needs the token.
             // We generally assume other URLs (public web, data URIs) do not need the token 
             // or will fail CORS if we send it unexpectedly.
             if (token && src.includes("googleapis.com/drive")) {
                 headers.Authorization = `Bearer ${token.access_token}`;
                 console.log(`[SecureImage] Fetching Drive URL with Auth: ${src}`);
             } else if (token && src.includes("googleusercontent.com")) {
                 // Try adding auth for lh3 links too, as they might be private Picker links
                 headers.Authorization = `Bearer ${token.access_token}`;
                 console.log(`[SecureImage] Fetching Google Content URL with Auth: ${src}`);
             }
             
             const response = await fetch(src, {
                headers,
                referrerPolicy: "no-referrer"
             });

             if (!response.ok) {
                 const errText = await response.text();
                 console.error(`[SecureImage] Fetch Failed: ${response.status} ${response.statusText} - Body: ${errText}`);
                 throw new Error(`Failed to load image: ${response.status} - ${errText.substring(0, 100)}`);
             }

             const blob = await response.blob();
             if (objectUrl) URL.revokeObjectURL(objectUrl); // Revoke OLD one now
             objectUrl = URL.createObjectURL(blob);
    } catch (e: any) {
      console.error("SecureImage error:", e);
      error = e.message;
      dispatch("error", { message: error, src });
    } finally {
      loading = false;
    }
  }

  import { createEventDispatcher } from "svelte";
  const dispatch = createEventDispatcher();

  $: if (src) {
    loadImage();
  }

  onDestroy(() => {
    if (objectUrl && !objectUrl.startsWith("data:")) {
      URL.revokeObjectURL(objectUrl);
    }
  });
</script>


<div class="secure-image-wrapper {fillParent ? 'fill' : 'auto'}">
    {#if loading || isUploading}
      <div class="spinner-overlay">
        <div class="spinner-container">
            <svg class="spinner-icon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
        </div>
      </div>
    {/if}

    {#if error && !loading && !isUploading}
      <div
        class="{className} error-container"
        style="{fillParent ? 'width: 100%; height: 100%;' : ''} {style}"
      >
        <span class="error-text" title={error}>
          {error === "Failed to load image: 403" ? "Access Expired" : "Error"}
        </span>
      </div>
    {:else if objectUrl}
      <img
        src={objectUrl}
        {alt}
        class={className}
        style="{fillParent ? 'width: 100%; height: 100%; object-fit: contain;' : 'max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain;'} display: block; {style}"
        referrerpolicy="no-referrer"
        on:error={() => {
            console.error("Image failed to load:", objectUrl);
            error = "Failed to load image";
            loading = false;
            URL.revokeObjectURL(objectUrl);
            objectUrl = ""; 
        }}
        on:load={() => {
            loading = false;
            error = "";
        }}
      />
    {/if}
</div>

<style>
    .secure-image-wrapper {
        position: relative;
        /* Default to auto, classes will override */
    }
    .secure-image-wrapper.fill {
        width: 100%;
        height: 100%;
    }
    .secure-image-wrapper.auto {
        width: auto;
        height: auto;
        display: inline-block; /* Or block depending on need, inline-block allows centering in text */
    }

    .spinner-overlay {
        /* ... existing styles ... */
        position: absolute;
        inset: 0;
        top: 0; 
        left: 0; 
        right: 0; 
        bottom: 0;
        background-color: rgba(0, 0, 0, 0.2);
        z-index: 10;
        display: flex;
        align-items: center;
        justify-content: center;
        pointer-events: none;
        border-radius: 0.5rem; /* rounded-lg equivalent */
    }

    .spinner-container {
        background-color: rgba(255, 255, 255, 0.8);
        border-radius: 9999px; /* full rounded */
        padding: 0.25rem;
        box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
    }

    .spinner-icon {
        animation: spin 1s linear infinite;
        height: 1.25rem; /* h-5 */
        width: 1.25rem;  /* w-5 */
        color: #4b5563; /* text-gray-600 */
    }

    .error-container {
        background-color: #fee2e2; /* bg-red-100 */
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0.5rem;
        text-align: center;
    }

    .error-text {
        font-size: 0.75rem; /* text-xs */
        color: #ef4444; /* text-red-500 */
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        padding-left: 0.25rem;
        padding-right: 0.25rem;
    }

    @keyframes spin {
        from {
            transform: rotate(0deg);
        }
        to {
            transform: rotate(360deg);
        }
    }
</style>
