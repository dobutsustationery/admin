<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getStoredToken } from "$lib/google-photos";

  export let src: string; // The base URL
  export let alt: string = "";
  export let className: string = "";
  export let style: string = "";
  export const isUploading: boolean = false;

  let objectUrl: string = "";
  let error = "";
  let loading = true;

  import { imageQueue } from "$lib/image-queue";

  async function loadImage() {
    // Reset state
    loading = true;
    error = "";
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = "";

    // Handle local/generated images directly
    if (src.startsWith("data:") || src.startsWith("blob:")) {
      objectUrl = src;
      loading = false;
      return;
    }
    
    // Rewrite Google Drive API links to Thumbnail links (which handle Auth better via cookies/public access)
    // and avoid CORS/Auth header issues with raw API fetch.
    let finalSrc = src;
    if (src.includes("googleapis.com/drive/v3/files/")) {
        const match = src.match(/files\/([a-zA-Z0-9_-]+)/);
        if (match && match[1]) {
            finalSrc = `https://drive.google.com/thumbnail?id=${match[1]}&sz=w3000`;
        }
    }

    // Google Photos/Picker googleusercontent URLs often require a size suffix.
    // If missing, load failures/403 are common. Add a safe default render size.
    if (finalSrc.includes("googleusercontent.com") && !finalSrc.match(/=[a-z0-9,-]+$/i)) {
      finalSrc = `${finalSrc}=w2000`;
    }
    
    // Check global token for authenticated Google Photos items
    const token = getStoredToken();

    // Only fetch googleapis endpoints. googleusercontent (PPA/lh3) does not provide
    // CORS headers for JS fetch, so it must load via plain <img src>.
    const isGoogleApi = finalSrc.includes("googleapis.com");
    const isGoogleusercontent = finalSrc.includes("googleusercontent.com");
    const shouldFetch = isGoogleApi;

    if (!shouldFetch) {
        // External/Public image (e.g. CDN, Shopify) or Drive Thumbnail. Load directly.
        objectUrl = finalSrc;
        loading = false;
        return;
    }

    // Wrap fetch in Queue
    try {
        await imageQueue.add(async () => {
             const headers: any = {};
             
             // PPA (Photos Picker API) URLs (on googleusercontent.com) REQUIRE Authentication.
             if (token) {
                 const isGoogle = isGoogleApi || isGoogleusercontent;
                 if (isGoogle) {
                     headers.Authorization = `Bearer ${token.access_token}`;
                 }
             }
             
             const response = await fetch(finalSrc, {
                headers,
                referrerPolicy: "no-referrer"
             });

             if (!response.ok) {
                 throw new Error(`Failed to load image: ${response.status}`);
             }

             const blob = await response.blob();
             objectUrl = URL.createObjectURL(blob);
        });
    } catch (e: any) {
      console.error("SecureImage error:", e);

      // Fallback for googleusercontent links: try direct image loading if auth-fetch fails.
      if (isGoogleusercontent) {
        objectUrl = finalSrc;
        error = "";
      } else if (e.message.includes("403")) {
        if (finalSrc.includes("/ppa/")) {
          error = "Link Expired";
        } else {
          error = "Access Denied";
        }
      } else {
        error = "Error";
      }
    } finally {
      loading = false;
    }
  }

  $: if (src) {
    loadImage();
  }

  // Determine crossorigin attribute: 'anonymous' for known CORS-supporting hosts (e.g. Shopify),
  // but NULL for drive.google.com (cookies) and googleusercontent.com (PPA - often fails CORS check or requires no-header).
  $: crossOriginVal = ((objectUrl && objectUrl.includes("cdn.shopify.com")) ? "anonymous" : null) as "anonymous" | null;

  onDestroy(() => {
    if (objectUrl && !objectUrl.startsWith("data:")) {
      URL.revokeObjectURL(objectUrl);
    }
  });
</script>

{#if loading}
  <div
    class="{className} bg-gray-200 animate-pulse flex items-center justify-center"
  >
    <span class="text-xs text-gray-400">Loading...</span>
  </div>
{:else if error}
  <div
    class="{className} bg-red-100 flex items-center justify-center p-2 text-center"
  >
    <span class="text-xs text-red-500 font-medium overflow-hidden text-ellipsis px-1" title={error}>
      {error}
    </span>
  </div>
{:else}
  <img
    src={objectUrl}
    {alt}
    class={className}
    style="width: 100%; height: 100%; display: block; {style}"
    referrerpolicy="no-referrer"
    crossorigin={crossOriginVal}
    on:error={() => {
        console.error("Image failed to load:", objectUrl);
        error = "Failed to load image";
        loading = false;
    }}
    on:load={() => {
        loading = false;
        error = "";
    }}
  />
{/if}
