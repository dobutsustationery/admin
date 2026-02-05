<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getStoredToken } from "$lib/google-photos";

  export let src: string; // The base URL
  export let alt: string = "";
  export let className: string = "";
  export let style: string = "";
  export let isUploading: boolean = false;

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
    
    let finalSrc = src;

    // During pending picker->Drive migration we intentionally avoid rendering
    // fragile googleusercontent URLs and keep a loading spinner instead.
    if (isUploading && finalSrc.includes("googleusercontent.com")) {
      loading = true;
      error = "";
      objectUrl = "";
      return;
    }
    
    // Check global token for authenticated Google Photos items
    const token = getStoredToken();
    const driveFileIdMatch = finalSrc.match(/drive\/v3\/files\/([a-zA-Z0-9_-]+)/);
    const driveThumbnailUrl =
      driveFileIdMatch?.[1] ? `https://drive.google.com/thumbnail?id=${driveFileIdMatch[1]}&sz=w3000` : "";
    const resolveDrivePreviewUrl = async () => {
      if (!driveFileIdMatch?.[1]) return driveThumbnailUrl;
      if (!token) return driveThumbnailUrl;
      try {
        const metaRes = await fetch(
          `https://www.googleapis.com/drive/v3/files/${driveFileIdMatch[1]}?fields=thumbnailLink`,
          { headers: { Authorization: `Bearer ${token.access_token}` } }
        );
        if (metaRes.ok) {
          const meta = await metaRes.json();
          if (meta?.thumbnailLink) return meta.thumbnailLink as string;
        }
      } catch {
        // Fall back to static Drive thumbnail URL.
      }
      return driveThumbnailUrl;
    };

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
             const mime = (blob.type || "").toLowerCase();
             const isHeicLike = mime.includes("heic") || mime.includes("heif");
             const isClearlyRenderableImage = /^image\/(png|jpe?g|webp|gif|bmp|svg\+xml|avif)$/.test(mime);
             if (driveThumbnailUrl && (isHeicLike || !isClearlyRenderableImage)) {
                 // Browsers often cannot render HEIC (or unknown binary) blobs directly; Drive thumbnail is renderable.
                 objectUrl = await resolveDrivePreviewUrl();
             } else {
                 objectUrl = URL.createObjectURL(blob);
             }
        });
    } catch (e: any) {
      console.error("SecureImage error:", e);

      if (isGoogleApi && driveThumbnailUrl) {
        // Fallback for transient Drive API auth/format failures.
        objectUrl = await resolveDrivePreviewUrl();
        error = "";
        return;
      }

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
    aria-busy={isUploading}
    class={className}
    style="width: 100%; height: 100%; display: block; {style}"
    referrerpolicy="no-referrer"
    crossorigin={crossOriginVal}
    on:error={() => {
        if (isUploading && objectUrl.includes("googleusercontent.com")) {
            // During picker->Drive migration, avoid flashing a broken image icon.
            // Keep loading state until the durable Drive URL replaces this source.
            loading = true;
            error = "";
            return;
        }
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
