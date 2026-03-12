<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { createEventDispatcher } from "svelte";
  import { getStoredToken } from "$lib/google-photos";
  import { getStoredToken as getDriveToken } from "$lib/google-drive";
  import {
    extractGoogleDriveFileId,
    toGoogleDrivePublicImageUrl,
    SIZE_SUFFIXES,
    applyGoogleSizeSuffix,
    type ImageSize,
  } from "$lib/drive-url";

  export let src: string; // The base URL
  export let alt: string = "";
  export let className: string = "";
  export let style: string = "";
  export let isUploading: boolean = false;
  /** Semantic size hint. Controls the Google image-size suffix requested.
   *  thumbnail (=s200): grids, tables, chips, queues
   *  preview   (=s800): detail panes, standard modals
   *  full      (=s0):   zoom / fullscreen / high-detail views
   */
  export let size: ImageSize = "full";

  let objectUrl: string = "";
  let error = "";
  let loading = true;

  import { imageQueue } from "$lib/image-queue";

  let shouldRun = true;
  let loadSeq = 0;
  const dispatch = createEventDispatcher<{ loadsuccess: { src: string } }>();

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
        await new Promise((resolve) =>
          setTimeout(resolve, backoffMs * (i + 1)),
        );
      }
    }
    throw lastError || new Error("Failed to load image");
  }

  async function fetchImageData(targetSize: ImageSize): Promise<string | null> {
    let finalSrc = toGoogleDrivePublicImageUrl(src);
    const driveFileId = extractGoogleDriveFileId(finalSrc);

    const isStableDriveGoogleusercontent = finalSrc.includes(
      "googleusercontent.com/d/",
    );
    if (
      isUploading &&
      finalSrc.includes("googleusercontent.com") &&
      !isStableDriveGoogleusercontent
    ) {
      return null;
    }

    const token = getStoredToken();
    const driveFullSizeUrl = driveFileId
      ? `https://lh3.googleusercontent.com/d/${driveFileId}${SIZE_SUFFIXES[targetSize]}`
      : "";

    const isGoogleApi = finalSrc.includes("googleapis.com");
    const isGoogleusercontent = finalSrc.includes("googleusercontent.com");
    const isDrivePublic =
      finalSrc.includes("drive.google.com/") ||
      finalSrc.includes("drive.usercontent.google.com/") ||
      finalSrc.includes("lh3.googleusercontent.com/d/");
    const shouldFetch = isGoogleApi || isGoogleusercontent;
    const requestSrc =
      isDrivePublic && driveFullSizeUrl
        ? driveFullSizeUrl
        : applyGoogleSizeSuffix(finalSrc, targetSize);

    if (isDrivePublic) {
      return requestSrc;
    }

    if (!shouldFetch) {
      return requestSrc;
    }

    let resultUrl = "";
    await imageQueue.add(async () => {
      const driveToken = getDriveToken();
      const authCandidates = isDrivePublic
        ? []
        : Array.from(
            new Set(
              [token?.access_token, driveToken?.access_token].filter(
                Boolean,
              ) as string[],
            ),
          );
      const tryFetch = async (authHeader?: string) =>
        await fetchWithRetries(
          requestSrc,
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
        try {
          response = await tryFetch();
        } catch (error) {
          lastError = error;
        }
      }

      if (!response) {
        throw lastError || new Error("Failed to load image");
      }

      const blob = await response.blob();
      resultUrl = URL.createObjectURL(blob);
    });
    return resultUrl;
  }

  async function loadImage() {
    const seq = ++loadSeq;
    loading = true;
    error = "";
    if (objectUrl && !objectUrl.startsWith("data:"))
      URL.revokeObjectURL(objectUrl);
    objectUrl = "";

    if (src.startsWith("data:") || src.startsWith("blob:")) {
      objectUrl = src;
      if (shouldRun && seq === loadSeq) loading = false;
      return;
    }

    try {
      if (size === "full") {
        const previewUrl = await fetchImageData("preview");
        if (!shouldRun || seq !== loadSeq) {
          if (previewUrl && previewUrl.startsWith("blob:"))
            URL.revokeObjectURL(previewUrl);
          return;
        }
        if (!previewUrl) {
          if (shouldRun && seq === loadSeq) {
            loading = true;
            error = "";
          }
          return;
        }

        objectUrl = previewUrl;
        loading = false;

        const fullUrl = await fetchImageData("full");
        if (!shouldRun || seq !== loadSeq) {
          if (fullUrl && fullUrl.startsWith("blob:"))
            URL.revokeObjectURL(fullUrl);
          return;
        }
        if (!fullUrl) return;

        const img = new Image();
        img.src = fullUrl;
        try {
          await img.decode();
        } catch (err) {
          // ignore
        }

        if (!shouldRun || seq !== loadSeq) {
          if (fullUrl && fullUrl.startsWith("blob:"))
            URL.revokeObjectURL(fullUrl);
          return;
        }

        const oldUrl = objectUrl;
        objectUrl = fullUrl;
        if (oldUrl && oldUrl.startsWith("blob:")) URL.revokeObjectURL(oldUrl);
      } else {
        const url = await fetchImageData(size);
        if (!shouldRun || seq !== loadSeq) {
          if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
          return;
        }
        if (!url) {
          if (shouldRun && seq === loadSeq) {
            loading = true;
            error = "";
          }
          return;
        }
        objectUrl = url;
        loading = false;
      }
    } catch (e: any) {
      console.error("SecureImage error:", e);
      if (e.message.includes("403")) {
        if (shouldRun && seq === loadSeq) {
          let finalSrc = toGoogleDrivePublicImageUrl(src);
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
      if (shouldRun && seq === loadSeq && loading) {
        if (objectUrl) loading = false;
      }
    }
  }

  $: if (src) {
    loadImage();
  }

  // Determine crossorigin attribute: 'anonymous' for known CORS-supporting hosts (e.g. Shopify),
  // but NULL for drive.google.com (cookies) and googleusercontent.com (PPA - often fails CORS check or requires no-header).
  $: crossOriginVal = (
    objectUrl && objectUrl.includes("cdn.shopify.com") ? "anonymous" : null
  ) as "anonymous" | null;
  $: referrerPolicyVal = "no-referrer" as ReferrerPolicy;

  onDestroy(() => {
    shouldRun = false;
    if (objectUrl && !objectUrl.startsWith("data:")) {
      URL.revokeObjectURL(objectUrl);
    }
  });
</script>

{#if loading}
  <div class="secure-image-loading {className}">
    <span class="loading-text">Loading...</span>
  </div>
{:else if error}
  <div class="secure-image-error {className}">
    <span class="error-text" title={error}>
      {error}
    </span>
  </div>
{:else}
  <img
    src={objectUrl}
    {alt}
    aria-busy={isUploading}
    class="secure-image-ready {className}"
    style="width: 100%; height: 100%; display: block; {style}"
    referrerpolicy={referrerPolicyVal}
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
      dispatch("loadsuccess", { src: objectUrl });
    }}
  />
{/if}

<style>
  .secure-image-loading {
    background-color: #e5e7eb; /* gray-200 */
    animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .loading-text {
    font-size: 0.75rem; /* text-xs */
    color: #9ca3af; /* gray-400 */
  }

  .secure-image-error {
    background-color: #fee2e2; /* red-100 */
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.5rem; /* p-2 */
    text-align: center;
  }

  .error-text {
    font-size: 0.75rem; /* text-xs */
    color: #ef4444; /* red-500 */
    font-weight: 500; /* font-medium */
    overflow: hidden;
    text-overflow: ellipsis;
    padding-left: 0.25rem;
    padding-right: 0.25rem;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.5;
    }
  }
</style>
