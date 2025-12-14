<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { getStoredToken } from "$lib/google-photos";

  export let src: string; // The base URL
  export let alt: string = "";
  export let className: string = "";

  let objectUrl: string = "";
  let error = "";
  let loading = true;

  onMount(async () => {
    // Handle local/generated images directly
    if (src.startsWith('data:') || src.startsWith('blob:')) {
        objectUrl = src;
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
  });

  onDestroy(() => {
    if (objectUrl) {
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
  <img src={objectUrl} {alt} class={className} style="width: 100%; height: 100%; object-fit: cover; display: block;" />
{/if}
