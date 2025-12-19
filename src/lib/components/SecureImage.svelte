<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getStoredToken } from "$lib/google-photos";

  export let src: string; // The base URL
  export let alt: string = "";
  export let className: string = "";

  let objectUrl: string = "";
  let error = "";
  let loading = true;

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
        src.includes("drive.google.com")
    ) {
      objectUrl = src;
      loading = false;
      return;
    }
    
    // For Google Photos Picker URLs (lh3.googleusercontent...), we need authentication.
    // We cannot use fetch+headers (CORS), so we append access_token to the URL.
    if (src.includes("googleusercontent.com")) {
        const token = getStoredToken();
        if (token && token.access_token) {
            const separator = src.includes('?') ? '&' : '?';
            objectUrl = `${src}${separator}access_token=${token.access_token}`;
        } else {
            objectUrl = src;
        }
        loading = false;
        return;
    }

    try {
      const token = getStoredToken();
      if (!token) {
        throw new Error("No auth token");
      }

      const response = await fetch(src, {
        headers: {
          Authorization: `Bearer ${token.access_token}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to load image: ${response.status}`);
      }

      const blob = await response.blob();
      objectUrl = URL.createObjectURL(blob);
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
    <span class="text-xs text-red-500">Error</span>
  </div>
{:else}
  <img
    src={objectUrl}
    {alt}
    class={className}
    style="width: 100%; height: 100%; object-fit: cover; display: block;"
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
