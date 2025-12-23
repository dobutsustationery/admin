<script lang="ts">
  import { page } from '$app/stores';
  import { store } from '$lib/store';
  import type { ListingImage } from '$lib/listings-slice';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';

  // State
  let searchTerm = '';
  let matchingHandles: string[] = [];
  
  // Derived state from URL
  $: handle = $page.url.searchParams.get('handle') || '';
  
  // Data Logic
  $: listing = $store.listings.handleToListing[handle];
  $: associatedItems = Object.entries($store.listings.idToHandle || {})
      .filter(([id, h]) => h === handle)
      .map(([id]) => $store.inventory.idToItem[id])
      .filter(Boolean);

  // Computed display values
  $: price = associatedItems.length > 0 && associatedItems[0].price 
      ? `€${associatedItems[0].price.toFixed(2)} EUR` 
      : 'Price not set';
      
  $: stockCount = associatedItems.reduce((sum, item) => sum + (item.qty || 0), 0);

  // Search Logic
  function handleSearch() {
      if (!searchTerm) {
          matchingHandles = [];
          return;
      }
      const q = searchTerm.toLowerCase();
      matchingHandles = Object.keys($store.listings.handleToListing).filter(h => h.toLowerCase().includes(q));
      
      // Automatic navigation if exact match or only one result
      if (matchingHandles.length === 1) {
          goto(`/listing-detail?handle=${matchingHandles[0]}`);
          searchTerm = '';
          matchingHandles = [];
      }
  }
  
  function selectHandle(h: string) {
      goto(`/listing-detail?handle=${h}`);
      searchTerm = '';
      matchingHandles = [];
  }

  // Image Gallery State
  let selectedImageIndex = 0;
  $: images = listing ? listing.images.slice().sort((a: ListingImage, b: ListingImage) => a.position - b.position) : [];
  $: mainImage = images[selectedImageIndex] || (associatedItems[0] ? { url: associatedItems[0].image, altText: 'Main product image' } : null);

</script>

<div class="container">
  <!-- Search Header -->
  <div class="search-header">
      <div class="search-bar-row">
           <input 
              class="search-input" 
              type="text" 
              placeholder="Search by handle..." 
              bind:value={searchTerm}
              on:input={handleSearch}
              on:keydown={(e) => e.key === 'Enter' && handleSearch()}
           />
           <button class="back-btn" on:click={() => goto('/shopify-products')}>Back to List</button>
      </div>
      
      {#if matchingHandles.length > 0 && searchTerm}
          <div class="search-results">
              {#each matchingHandles as h}
                  <button class="result-item" on:click={() => selectHandle(h)}>
                      {h}
                  </button>
              {/each}
          </div>
      {/if}
  </div>

  {#if listing}
      <div class="listing-content">
          <!-- Left Column: Images -->
          <div class="image-column">
               <div class="main-image-container">
                   {#if mainImage && mainImage.url}
                       <img src={mainImage.url} alt={mainImage.altText} class="main-image" />
                   {:else}
                       <span class="no-image-text">No image available</span>
                   {/if}
               </div>
               
               <!-- Thumbnails -->
               {#if images.length > 1}
                   <div class="thumbnails-grid">
                       {#each images as img, i}
                           <button 
                              class="thumbnail-btn {selectedImageIndex === i ? 'selected' : ''}"
                              on:click={() => selectedImageIndex = i}
                           >
                               <img src={img.url} alt={img.altText} class="thumbnail-img" />
                           </button>
                       {/each}
                   </div>
               {/if}
          </div>

          <!-- Right Column: Details -->
          <div class="details-column">
               <div class="title-block">
                   <h1 class="listing-title">{listing.title}</h1>
                   <div class="listing-price">{price}</div>
                   <div class="tax-note">Taxes included.</div>
               </div>
               
               <div class="description-block">
                   {@html listing.bodyHtml}
               </div>

               <!-- Subtypes / Options -->
               {#if associatedItems.length > 1}
                  <div class="options-block">
                      <label class="option-label">{listing.option1Name || 'Option'}</label>
                      <div class="options-list">
                          {#each associatedItems as item}
                              <button class="option-btn {item.qty > 0 ? 'available' : 'unavailable'}">
                                  {item.subtype || 'Default'}
                              </button>
                          {/each}
                      </div>
                  </div>
               {/if}
               
               <!-- Quantity (Mock) -->
               <div class="quantity-block">
                   <label class="option-label">Quantity</label>
                   <div class="quantity-selector">
                       <button class="qty-btn">-</button>
                       <div class="qty-value">1</div>
                       <button class="qty-btn">+</button>
                   </div>
               </div>

               <!-- Actions -->
               <div class="actions-block">
                   <button class="btn-add-cart">
                       Add to cart
                   </button>
                   <button class="btn-buy-shop">
                       Buy with <span class="shop-logo">shop</span>
                   </button>
                   <div class="payment-options">
                       <a href="#" class="payment-link">More payment options</a>
                   </div>
               </div>
               
               <!-- Stock Status -->
               {#if stockCount > 0 && stockCount < 10}
                   <div class="stock-status">
                       <span class="stock-dot"></span>
                       Low stock: {stockCount} left
                   </div>
               {/if}
          </div>
      </div>
  {:else if handle}
      <div class="not-found">
          <p class="not-found-text">Listing not found for handle: <span class="handle-text">{handle}</span></p>
          <button class="link-btn" on:click={() => goto('/shopify-products')}>Return to Product List</button>
      </div>
  {:else}
       <div class="empty-state">
          <p class="empty-text">Search for a listing handle to view details.</p>
      </div>
  {/if}
</div>

<style>
  .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 2rem;
      font-family: sans-serif;
      color: #333;
  }

  /* Search Header */
  .search-header {
      margin-bottom: 2rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      position: relative;
  }
  .search-bar-row {
      display: flex;
      gap: 0.5rem;
  }
  .search-input {
      border: 1px solid #ccc;
      border-radius: 4px;
      padding: 0.5rem 1rem;
      width: 100%;
      max-width: 400px;
      font-size: 1rem;
  }
  .search-input:focus {
      outline: none;
      border-color: #3b82f6;
      box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
  }
  .back-btn {
      background: #f3f4f6;
      padding: 0.5rem 1rem;
      border-radius: 4px;
      border: none;
      cursor: pointer;
  }
  .back-btn:hover {
      background: #e5e7eb;
  }
  .search-results {
      position: absolute;
      top: 100%;
      left: 0;
      width: 100%;
      max-width: 400px;
      background: white;
      border: 1px solid #e5e7eb;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
      border-radius: 4px;
      z-index: 10;
      max-height: 240px;
      overflow-y: auto;
  }
  .result-item {
      width: 100%;
      text-align: left;
      padding: 0.5rem 1rem;
      background: none;
      border: none;
      cursor: pointer;
  }
  .result-item:hover {
      background: #eff6ff;
  }

  /* Listing Content Layout */
  .listing-content {
      display: flex;
      flex-direction: column;
      gap: 3rem;
  }
  @media (min-width: 768px) {
      .listing-content {
          flex-direction: row;
          align-items: flex-start;
      }
  }

  /* Left Column */
  .image-column {
      width: 100%;
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      gap: 1rem;
  }
  @media (min-width: 768px) {
      .image-column {
           width: 30%;
      }
  }

  .main-image-container {
      aspect-ratio: 1 / 1;
      width: 100%;
      background: #f9fafb;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid #f3f4f6;
      display: flex;
      align-items: center;
      justify-content: center;
  }
  .main-image {
      width: 100%;
      height: 100%;
      object-fit: contain;
  }
  .no-image-text {
      color: #9ca3af;
  }

  /* Thumbnails */
  .thumbnails-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
  }
  .thumbnail-btn {
      width: 23%; /* Approx 1/4th */
      aspect-ratio: 1 / 1;
      border: 1px solid #e5e7eb;
      border-radius: 4px;
      overflow: hidden;
      cursor: pointer;
      padding: 0;
      background: white;
      opacity: 0.7;
      transition: opacity 0.2s;
  }
  .thumbnail-btn:hover {
      opacity: 1;
  }
  .thumbnail-btn.selected {
      opacity: 1;
      border-color: #3b82f6;
      box-shadow: 0 0 0 1px #3b82f6;
  }
  .thumbnail-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
  }

  /* Right Column */
  .details-column {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
  }
  .title-block {
      margin-bottom: 0.5rem;
  }
  .listing-title {
      font-size: 2.25rem;
      font-weight: 400;
      line-height: 1.1;
      color: #111827;
      margin: 0 0 0.5rem 0;
  }
  .listing-price {
      font-size: 1.25rem;
      color: #374151;
      font-weight: 500;
  }
  .tax-note {
      font-size: 0.875rem;
      color: #6b7280;
      margin-top: 0.25rem;
  }
  
  .description-block :global(p) {
      margin-bottom: 1em;
      line-height: 1.6;
      color: #4b5563;
  }
  .description-block :global(ul) {
      margin-bottom: 1em;
      padding-left: 1.5em;
  }
  
  /* Options */
  .options-block {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
  }
  .option-label {
      font-size: 0.875rem;
      font-weight: 500;
      color: #374151;
  }
  .options-list {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
  }
  .option-btn {
      padding: 0.5rem 1rem;
      border: 1px solid #d1d5db;
      border-radius: 9999px;
      font-size: 0.875rem;
      background: white;
      cursor: pointer;
  }
  .option-btn.available {
      color: #1f2937;
      border-color: #d1d5db;
  }
  .option-btn.available:hover {
     border-color: #9ca3af;
  }
  .option-btn.unavailable {
      background: #f9fafb;
      color: #9ca3af;
      border-color: #e5e7eb;
      cursor: not-allowed;
  }

  /* Quantity */
  .quantity-block {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
  }
  .quantity-selector {
      display: flex;
      align-items: center;
      width: 140px;
      border: 1px solid #d1d5db;
      border-radius: 4px;
  }
  .qty-btn {
      padding: 0.5rem 0.75rem;
      background: none;
      border: none;
      font-size: 1.2rem;
      color: #6b7280;
      cursor: pointer;
  }
  .qty-btn:hover {
      background: #f9fafb;
  }
  .qty-value {
      flex: 1;
      text-align: center;
      color: #374151;
  }

  /* Actions */
  .actions-block {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      margin-top: 1rem;
  }
  .btn-add-cart {
      width: 100%;
      padding: 0.75rem 1.5rem;
      border: 1px solid #111827;
      background: white;
      color: #111827;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      cursor: pointer;
      transition: background 0.2s;
  }
  .btn-add-cart:hover {
      background: #f9fafb;
  }
  .btn-buy-shop {
      width: 100%;
      padding: 0.75rem 1.5rem;
      border: none;
      background: #5a31f4;
      color: white;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      transition: background 0.2s;
  }
  .btn-buy-shop:hover {
      background: #4820e0;
  }
  .shop-logo {
      font-weight: bold;
      font-style: italic;
  }
  .payment-options {
      text-align: center;
  }
  .payment-link {
      font-size: 0.875rem;
      color: #6b7280;
      text-decoration: underline;
      text-decoration-color: #9ca3af;
  }
  .payment-link:hover {
      color: #1f2937;
  }

  /* Stock Status */
  .stock-status {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      color: #ea580c; /* Orange-600 */
      font-size: 0.875rem;
      margin-top: 0.5rem;
  }
  .stock-dot {
      width: 8px;
      height: 8px;
      background: #f97316; /* Orange-500 */
      border-radius: 50%;
  }

  /* Empty / Not Found */
  .not-found, .empty-state {
      text-align: center;
      padding: 5rem 0;
      color: #6b7280;
  }
  .not-found-text, .empty-text {
      font-size: 1.25rem;
  }
  .handle-text {
      font-family: monospace;
      color: #374151;
  }
  .link-btn {
      margin-top: 1rem;
      color: #2563eb;
      background: none;
      border: none;
      text-decoration: underline;
      cursor: pointer;
      font-size: 1rem;
  }
  .link-btn:hover {
      color: #1d4ed8;
  }
</style>
