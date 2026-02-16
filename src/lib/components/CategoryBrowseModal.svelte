<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";
  import { fade, fly } from "svelte/transition";

  export let isOpen = false;
  export let currentCategory = "";

  const dispatch = createEventDispatcher();

  let searchTerm = "";
  let categories: string[] = [];
  let loading = true;
  let error = "";

  // Shopify Taxonomy URL (TXT format is easier to parse as line-by-line)
  // Using the stable path from the main branch
  const TAXONOMY_URL =
    "https://raw.githubusercontent.com/Shopify/product-taxonomy/main/dist/en/categories.txt";

  onMount(async () => {
    try {
      const response = await fetch(TAXONOMY_URL);
      if (!response.ok)
        throw new Error(`Failed to fetch taxonomy: ${response.statusText}`);
      const text = await response.text();

      // Parse TXT: Skip header/metadata lines
      // Each line is "ID : Category > Path" (e.g. "123 : Apparel > Shirts")
      categories = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
          const parts = line.split(":");
          return parts.length > 1 ? parts[parts.length - 1].trim() : line;
        })
        .filter((cat) => cat.includes(" > "));

      loading = false;
    } catch (err: any) {
      error = err.message;
      loading = false;
    }
  });

  $: filtered = categories
    .filter((c) => c.toLowerCase().includes(searchTerm.toLowerCase()))
    .slice(0, 100); // Limit to 100 for performance

  function select(cat: string) {
    dispatch("select", cat);
    close();
  }

  function close() {
    isOpen = false;
    dispatch("close");
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }
</script>

{#if isOpen}
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <div
    class="modal-backdrop"
    on:click|self={close}
    on:keydown={handleKeydown}
    transition:fade={{ duration: 200 }}
  >
    <div class="modal category-modal" transition:fly={{ y: 20, duration: 300 }}>
      <div class="modal-header">
        <h3 class="modal-title">Shopify Product Taxonomy</h3>
        <button class="btn-close" on:click={close}>&times;</button>
      </div>

      <div class="search-container">
        <input
          type="text"
          placeholder="Search Shopify categories (e.g. 'Stationery' or 'Pens')..."
          bind:value={searchTerm}
          class="search-input"
          autofocus
        />
      </div>

      <div class="categories-content">
        {#if loading}
          <div class="loading-state">
            <span class="spinner"></span>
            <p>Loading Shopify taxonomy...</p>
          </div>
        {:else if error}
          <div class="error-state">
            <p>Error: {error}</p>
            <button class="btn-retry" on:click={() => location.reload()}
              >Retry</button
            >
          </div>
        {:else}
          <div class="categories-list">
            {#each filtered as cat}
              <button
                class="category-item {cat === currentCategory ? 'active' : ''}"
                on:click={() => select(cat)}
              >
                {cat}
              </button>
            {:else}
              <div class="empty-state">
                No categories matching "{searchTerm}"
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="modal-footer">
        <p class="taxonomy-info">Source: Shopify Product Taxonomy (Latest)</p>
        <button class="btn-secondary" on:click={close}>Cancel</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
    backdrop-filter: blur(2px);
  }

  .modal {
    background: white;
    width: 90%;
    max-width: 600px;
    max-height: 80vh;
    border-radius: 12px;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.2);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .modal-header {
    padding: 1rem 1.5rem;
    border-bottom: 1px solid #eee;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .modal-title {
    margin: 0;
    font-size: 1.2rem;
    font-weight: 600;
    color: #333;
  }

  .btn-close {
    background: none;
    border: none;
    font-size: 1.5rem;
    cursor: pointer;
    color: #999;
  }

  .search-container {
    padding: 1rem 1.5rem;
    background: #f9f9f9;
    border-bottom: 1px solid #eee;
  }

  .search-input {
    width: 100%;
    padding: 0.8rem 1rem;
    border: 1px solid #ddd;
    border-radius: 6px;
    font-size: 1rem;
    outline: none;
    transition: border-color 0.2s;
  }

  .search-input:focus {
    border-color: #008060;
    box-shadow: 0 0 0 2px rgba(0, 128, 96, 0.1);
  }

  .categories-content {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem 0;
    min-height: 300px;
  }

  .categories-list {
    display: flex;
    flex-direction: column;
  }

  .category-item {
    padding: 0.8rem 1.5rem;
    text-align: left;
    background: none;
    border: none;
    border-bottom: 1px solid #f5f5f5;
    cursor: pointer;
    font-size: 0.95rem;
    color: #444;
    transition: background 0.1s;
  }

  .category-item:hover {
    background: #f0f7f5;
    color: #008060;
  }

  .category-item.active {
    background: #008060;
    color: white;
    font-weight: 500;
  }

  .loading-state,
  .error-state,
  .empty-state {
    padding: 3rem 1.5rem;
    text-align: center;
    color: #666;
  }

  .spinner {
    display: inline-block;
    width: 30px;
    height: 30px;
    border: 3px solid rgba(0, 128, 96, 0.1);
    border-top-color: #008060;
    border-radius: 50%;
    animation: spin 1s linear infinite;
    margin-bottom: 1rem;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .modal-footer {
    padding: 1rem 1.5rem;
    border-top: 1px solid #eee;
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: #f9f9f9;
  }

  .taxonomy-info {
    font-size: 0.75rem;
    color: #999;
    margin: 0;
  }

  .btn-secondary {
    padding: 0.5rem 1rem;
    border: 1px solid #ddd;
    background: white;
    border-radius: 6px;
    cursor: pointer;
    font-weight: 500;
  }

  .btn-secondary:hover {
    background: #f5f5f5;
  }
</style>

