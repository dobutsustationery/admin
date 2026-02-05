<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getStoredToken } from "$lib/google-photos";
  import { getStoredToken as getDriveToken } from "$lib/google-drive";

  export let src: string; // The base URL
  export let alt: string = "";
  export let className: string = "";
  export let style: string = "";
  export let isUploading: boolean = false;

  let objectUrl: string = "";
  let error = "";
  let loading = true;

  import { imageQueue } from "$lib/image-queue";

  let shouldRun = true;
  let loadSeq = 0;

  async function fetchWithRetries(
    url: string,
    options: RequestInit,
    attempts = 4,
    backoffMs = 250,
  ): Promise<Response> {
    let lastError: any;
    for (let i = 0; i < attempts; i++) {
      try {
        const response = await fetch(url, options);
        if (response.ok) return response;
        lastError = new Error(`Failed to load image: ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs * (i + 1)));
      }
    }
    throw lastError || new Error("Failed to load image");
  }

  async function loadImage() {
    const seq = ++loadSeq;
    // Reset state
    loading = true;
    error = "";
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = "";

    // Handle local/generated images directly
    if (src.startsWith("data:") || src.startsWith("blob:")) {
      objectUrl = src;
      if (shouldRun && seq === loadSeq) loading = false;
      return;
    }
    
    let finalSrc = src;
    const driveQueryIdMatch = finalSrc.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    const drivePathIdMatch = finalSrc.match(/\/d\/([a-zA-Z0-9_-]+)/);
    const driveApiIdMatch = finalSrc.match(/drive\/v3\/files\/([a-zA-Z0-9_-]+)/);
    const driveFileId = driveApiIdMatch?.[1] || driveQueryIdMatch?.[1] || drivePathIdMatch?.[1] || "";

    // Normalize Drive URLs so we can always do an authenticated fetch.
    if (driveFileId && !finalSrc.includes("googleapis.com/drive/v3/files/")) {
      finalSrc = `https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`;
    }

    // During pending picker->Drive migration we intentionally avoid rendering
    // fragile googleusercontent URLs and keep a loading spinner instead.
    if (isUploading && finalSrc.includes("googleusercontent.com")) {
      if (shouldRun && seq === loadSeq) {
        loading = true;
        error = "";
        objectUrl = "";
      }
      return;
    }
    
    // Check global token for authenticated Google Photos items
    const token = getStoredToken();
    const driveFileIdMatch = finalSrc.match(/drive\/v3\/files\/([a-zA-Z0-9_-]+)/);
    const driveThumbnailUrl =
      driveFileIdMatch?.[1] ? `https://drive.google.com/thumbnail?id=${driveFileIdMatch[1]}&sz=w3000` : "";

    // Prefer fetching Google URLs and render via object URLs. This avoids flaky
    // direct-image auth behavior on Drive/Photos links. For googleusercontent,
    // we still fall back to direct <img> if fetch path fails.
    const isGoogleApi = finalSrc.includes("googleapis.com");
    const isGoogleusercontent = finalSrc.includes("googleusercontent.com");
    const shouldFetch = isGoogleApi || isGoogleusercontent;

    if (!shouldFetch) {
        // External/Public image (e.g. CDN, Shopify) or Drive Thumbnail. Load directly.
        objectUrl = finalSrc;
        loading = false;
        return;
    }

    // Wrap fetch in Queue
    try {
        await imageQueue.add(async () => {
             const driveToken = getDriveToken();
             const authCandidates = Array.from(
               new Set(
                 [token?.access_token, driveToken?.access_token]
                   .filter(Boolean) as string[]
               )
             );
             const tryFetch = async (authHeader?: string) =>
               await fetchWithRetries(
                 finalSrc,
                 {
                   headers: authHeader ? { Authorization: authHeader } : {},
                   referrerPolicy: "no-referrer",
                 },
                 4,
                 250,
               );

             let response: Response | null = null;
             let lastError: any = null;

             for (const accessToken of authCandidates) {
               try {
                 response = await tryFetch(`Bearer ${accessToken}`);
                 break;
               } catch (error) {
                 lastError = error;
               }
             }

             if (!response) {
               // For non-Drive resources, allow one anonymous attempt as fallback.
               if (!isGoogleApi) {
                 try {
                   response = await tryFetch();
                 } catch (error) {
                   lastError = error;
                 }
               }
             }

             if (!response) {
               throw lastError || new Error("Failed to load image");
             }

             const blob = await response.blob();
             const mime = (blob.type || "").toLowerCase();
             const isHeicLike = mime.includes("heic") || mime.includes("heif");
             // If MIME is missing, try rendering bytes first; do not assume non-renderable.
             const hasKnownRenderableMime = mime
               ? /^image\/(png|jpe?g|webp|gif|bmp|svg\+xml|avif)$/.test(mime)
               : true;
             if (driveThumbnailUrl && (isHeicLike || !hasKnownRenderableMime)) {
                 // Browsers often cannot render HEIC (or unknown binary) blobs directly; Drive thumbnail is renderable.
                 if (shouldRun && seq === loadSeq) objectUrl = driveThumbnailUrl;
             } else {
                 if (shouldRun && seq === loadSeq) objectUrl = URL.createObjectURL(blob);
             }
        });
    } catch (e: any) {
      console.error("SecureImage error:", e);

      // Fallback for googleusercontent links: direct image load when fetch path fails.
      if (isGoogleusercontent) {
        if (shouldRun && seq === loadSeq) {
          objectUrl = finalSrc;
          error = "";
        }
      } else if (e.message.includes("403")) {
        if (shouldRun && seq === loadSeq) {
          if (finalSrc.includes("/ppa/")) {
            error = "Link Expired";
          } else {
            error = "Access Denied";
          }
        }
      } else {
        if (shouldRun && seq === loadSeq) error = "Error";
      }
    } finally {
      if (shouldRun && seq === loadSeq) loading = false;
    }
  }

  $: if (src) {
    loadImage();
  }

  // Determine crossorigin attribute: 'anonymous' for known CORS-supporting hosts (e.g. Shopify),
  // but NULL for drive.google.com (cookies) and googleusercontent.com (PPA - often fails CORS check or requires no-header).
  $: crossOriginVal = ((objectUrl && objectUrl.includes("cdn.shopify.com")) ? "anonymous" : null) as "anonymous" | null;

  onDestroy(() => {
    shouldRun = false;
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
