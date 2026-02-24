<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getStoredToken } from "$lib/google-photos";
  import { getStoredToken as getDriveToken } from "$lib/google-drive";
  import {
    extractGoogleDriveFileId,
    toGoogleDrivePublicImageUrl,
    SIZE_SUFFIXES,
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

    let finalSrc = toGoogleDrivePublicImageUrl(src);
    const driveFileId = extractGoogleDriveFileId(finalSrc);

    // During pending picker->Drive migration we intentionally avoid rendering
    // fragile expiring googleusercontent URLs and keep a loading spinner instead.
    const isStableDriveGoogleusercontent = finalSrc.includes(
      "googleusercontent.com/d/",
    );
    if (
      isUploading &&
      finalSrc.includes("googleusercontent.com") &&
      !isStableDriveGoogleusercontent
    ) {
      if (shouldRun && seq === loadSeq) {
        loading = true;
        error = "";
        objectUrl = "";
      }
      return;
    }

    // Check global token for authenticated Google Photos items
    const token = getStoredToken();
    const driveFullSizeUrl = driveFileId
      ? `https://lh3.googleusercontent.com/d/${driveFileId}${SIZE_SUFFIXES[size]}`
      : "";

    // Prefer fetching Google URLs and render via object URLs. This avoids flaky
    // direct-image auth behavior on Drive/Photos links. For googleusercontent,
    // we still fall back to direct <img> if fetch path fails.
    const isGoogleApi = finalSrc.includes("googleapis.com");
    const isGoogleusercontent = finalSrc.includes("googleusercontent.com");
    const isDrivePublic =
      finalSrc.includes("drive.google.com/") ||
      finalSrc.includes("drive.usercontent.google.com/") ||
      finalSrc.includes("lh3.googleusercontent.com/d/");
    const shouldFetch = isGoogleApi || isGoogleusercontent;
    const requestSrc =
      isDrivePublic && driveFullSizeUrl ? driveFullSizeUrl : finalSrc;

    // Drive public images must be loaded directly via <img>; browser fetch() is CORS-blocked.
    if (isDrivePublic) {
      objectUrl = requestSrc;
      loading = false;
      return;
    }

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
        if (shouldRun && seq === loadSeq) objectUrl = URL.createObjectURL(blob);
      });
    } catch (e: any) {
      console.error("SecureImage error:", e);

      if (e.message.includes("403")) {
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
  <div
    class="{className} bg-gray-200 animate-pulse flex items-center justify-center"
  >
    <span class="text-xs text-gray-400">Loading...</span>
  </div>
{:else if error}
  <div
    class="{className} bg-red-100 flex items-center justify-center p-2 text-center"
  >
    <span
      class="text-xs text-red-500 font-medium overflow-hidden text-ellipsis px-1"
      title={error}
    >
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
    }}
  />
{/if}
