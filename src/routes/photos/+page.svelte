<script lang="ts">
  import { onMount } from "svelte";
  import {
    initiateOAuthFlow,
    handleOAuthCallback,
    isAuthenticated,
    joinSharedAlbum,
    listMediaItems,
    getStoredToken,
    clearToken,
  } from "$lib/google-photos";
  import type { Album, MediaItem } from "$lib/google-photos";

  let isConnected = false;
  let shareUrl = "";
  let albums: Album[] = [];
  let selectedAlbum: Album | null = null;
  let photos: MediaItem[] = [];
  let loading = false;
  let error = "";

  onMount(() => {
    // Check for OAuth callback
    handleOAuthCallback();
    isConnected = isAuthenticated();
  });

  function handleConnect() {
    initiateOAuthFlow();
  }

  function handleDisconnect() {
    clearToken();
    isConnected = false;
    albums = [];
    selectedAlbum = null;
    photos = [];
  }

  function extractShareToken(url: string): string | null {
    // Example: https://photos.google.com/share/AF1QipP9...
    // The token is the part after /share/ and before any ? or /
    const match = url.match(/photos\.google\.com\/share\/([^/?]+)/);
    return match ? match[1] : null;
  }

  async function handleAddAlbum() {
    error = "";
    const token = extractShareToken(shareUrl);

    if (!token) {
      error = "Invalid Google Photos shared album URL";
      return;
    }

    loading = true;
    try {
      const album = await joinSharedAlbum(token);
      // Check if already exists
      if (!albums.find((a) => a.id === album.id)) {
        albums = [...albums, album];
      }
      shareUrl = "";

      // Select the newly added album
      selectAlbum(album);
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }

  async function selectAlbum(album: Album) {
    selectedAlbum = album;
    loading = true;
    error = "";
    photos = [];

    try {
      photos = await listMediaItems(album.id);
    } catch (e: any) {
      error = e.message;
    } finally {
      loading = false;
    }
  }
</script>

<div class="p-8 max-w-6xl mx-auto">
  <h1 class="text-3xl font-bold mb-8">Google Photos Integration</h1>

  {#if !isConnected}
    <div class="bg-white p-8 rounded-lg shadow-md text-center">
      <p class="mb-6 text-gray-600">
        Connect to Google Photos to access your shared albums.
      </p>
      <button
        on:click={handleConnect}
        class="bg-blue-600 text-white px-6 py-3 rounded-md font-medium hover:bg-blue-700 transition"
      >
        Connect Google Photos
      </button>
    </div>
  {:else}
    <div class="grid grid-cols-1 md:grid-cols-3 gap-8">
      <!-- Sidebar / Album List -->
      <div class="md:col-span-1 space-y-6">
        <div class="bg-white p-6 rounded-lg shadow-md">
          <div class="flex justify-between items-center mb-4">
            <h2 class="text-xl font-semibold">Albums</h2>
            <button
              on:click={handleDisconnect}
              class="text-sm text-red-600 hover:text-red-800"
            >
              Disconnect
            </button>
          </div>

          <div class="mb-4">
            <input
              type="text"
              bind:value={shareUrl}
              placeholder="Paste shared album URL"
              class="w-full border rounded px-3 py-2 mb-2"
            />
            <button
              on:click={handleAddAlbum}
              disabled={!shareUrl || loading}
              class="w-full bg-green-600 text-white px-3 py-2 rounded hover:bg-green-700 disabled:opacity-50"
            >
              Add Album
            </button>
          </div>

          {#if error && !selectedAlbum}
            <div class="text-red-500 text-sm mb-4">{error}</div>
          {/if}

          <div class="space-y-2">
            {#each albums as album}
              <button
                on:click={() => selectAlbum(album)}
                class="w-full text-left p-3 rounded border transition {selectedAlbum?.id ===
                album.id
                  ? 'bg-blue-50 border-blue-500'
                  : 'hover:bg-gray-50 border-gray-200'}"
              >
                <div class="font-medium truncate">{album.title}</div>
                <div class="text-xs text-gray-500">
                  {album.mediaItemsCount} items
                </div>
              </button>
            {/each}
            {#if albums.length === 0}
              <p class="text-gray-400 text-sm italic text-center py-4">
                No albums added yet
              </p>
            {/if}
          </div>
        </div>
      </div>

      <!-- Main Content / Photo Grid -->
      <div class="md:col-span-2">
        {#if selectedAlbum}
          <div class="bg-white p-6 rounded-lg shadow-md">
            <h2 class="text-xl font-semibold mb-4">{selectedAlbum.title}</h2>

            {#if error}
              <div class="p-4 bg-red-50 text-red-700 rounded mb-4">
                {error}
              </div>
            {/if}

            {#if loading}
              <div class="flex justify-center p-12">
                <div
                  class="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"
                ></div>
              </div>
            {:else if photos.length > 0}
              <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                {#each photos as photo}
                  <div
                    class="aspect-square bg-gray-100 rounded overflow-hidden relative group"
                  >
                    <img
                      src="{photo.baseUrl}=w400-h400-c"
                      alt="Thumbnail"
                      class="w-full h-full object-cover"
                      referrerpolicy="no-referrer"
                    />
                    <div
                      class="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-10 transition-all"
                    ></div>
                  </div>
                {/each}
              </div>
            {:else}
              <div class="text-center py-12 text-gray-500">
                No photos found in this album.
              </div>
            {/if}
          </div>
        {:else}
          <div
            class="bg-white p-12 rounded-lg shadow-md text-center text-gray-400"
          >
            Select an album to view photos
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
