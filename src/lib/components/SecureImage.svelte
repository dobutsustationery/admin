<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getStoredToken } from "$lib/google-photos";

  export let src: string; // The base URL
  export let alt: string = "";
  export let className: string = "";
  export let style: string = "";

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
    // Also bypass fetch for Google and Drive URLs to avoid CORS (they don't need Auth header if public/token in URL)
    if (
        src.startsWith("data:") || 
        src.startsWith("blob:") || 
        !src.includes("googleusercontent.com")
    ) {
      objectUrl = src;
      loading = false;
      return;
    }
    
    // Check global token for authenticated Google Photos items
    const token = getStoredToken();
    if (!token && src.includes("googleusercontent.com")) {
         // Should we error or try anonymous?
         // Many drive links ARE public. Let's try queueing it plainly?
         // But the logic below assumes we need auth if it gets here.
         // Let's assume if we have a token, we use it. If not, we try without?
    }

    // Wrap fetch in Queue
    try {
        await imageQueue.add(async () => {
             const headers: any = {};
             if (token) {
                 headers.Authorization = `Bearer ${token.access_token}`;
             }
             
             const response = await fetch(src, {
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
      error = e.message;
    } finally {
      loading = false;
    }
  }

  $: if (src) {
    loadImage();
  }

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
      {error === "Failed to load image: 403" ? "Access Expired" : "Error"}
    </span>
  </div>
{:else}
  <img
    src={objectUrl}
    {alt}
    class={className}
    style="width: 100%; height: 100%; display: block; {style}"
    referrerpolicy="no-referrer"
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
