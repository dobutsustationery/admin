<script lang="ts">
  import { page } from '$app/stores';
  import { store } from '$lib/store';
  import { update_listing, add_listing_image, remove_listing_image, type ListingImage } from '$lib/listings-slice';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { broadcast } from '$lib/redux-firestore';
  import { firestore } from '$lib/firebase';
  import { user } from '$lib/user-store';
  import { ensureFolderStructure, uploadImageToDrive, getStoredToken, initiateOAuthFlow } from '$lib/google-drive';

  // State
  let searchTerm = '';
  let matchingHandles: string[] = [];
  let fileInput: HTMLInputElement;
  let uploadingImageId: string | null = null;
  let replacingImagePosition: number | null = null;
  
  // Derived state from URL
  $: handle = $page.url.searchParams.get('handle') || '';
  
  // Data Logic
  $: listing = $store.listings.handleToListing[handle];
  $: associatedItems = Object.entries($store.listings.idToHandle || {})
      .filter(([id, h]) => h === handle)
      .map(([id]) => {
          const item = $store.inventory.idToItem[id];
          return item ? { ...item, id } : null;
      })
      .filter((item): item is NonNullable<typeof item> => !!item);

  // Subtype State
  let selectedSubtypeId: string | null = null;
  
  // Initialize selection
  $: if (associatedItems.length > 0 && selectedSubtypeId === null && !hoveredImage) {
      selectedSubtypeId = associatedItems[0].id; // Default to first
  }

  // Split Images
  // Subtype Images: specific images linked to inventory items
  $: subtypeImageUrls = new Set(associatedItems.map(i => i.image).filter(Boolean));
  $: galleryImages = listing 
      ? listing.images.filter((img: ListingImage) => !subtypeImageUrls.has(img.url)).sort((a: ListingImage, b: ListingImage) => a.position - b.position) 
      : [];

  // Hover State
  let hoveredImage: ListingImage | null = null;
  
  // Hero Image Logic
  // Priority: 
  // 1. Hovered Gallery Image
  // 2. Selected Subtype Image
  // 3. First Gallery Image
  $: mainImageObj = (() => {
      if (hoveredImage) return hoveredImage;
      
      if (selectedSubtypeId) {
          const item = associatedItems.find(i => i.id === selectedSubtypeId);
          if (item && item.image) {
              // Find matching ListingImage if exists, else mock
              const existing = listing?.images.find((img: ListingImage) => img.url === item.image);
              return existing || { url: item.image, altText: item.subtype || 'Subtype Image', id: 'subtype-'+item.id, position: -1 };
          }
      }
      
      return galleryImages.length > 0 ? galleryImages[0] : null;
  })();

  // Interaction Handlers
  function handleSubtypeSelect(id: string) {
      selectedSubtypeId = id;
      hoveredImage = null; // Clear hover override if clicking
  }

  function handleThumbnailHover(img: ListingImage) {
      hoveredImage = img;
  }
  
  function handleThumbnailLeave() {
      hoveredImage = null;
  }

  // Editing Handlers
  function handleTitleBlur(e: Event) {
      const newTitle = (e.target as HTMLElement).innerText;
      if (listing && newTitle !== listing.title && $user.uid) {
          broadcast(firestore, $user.uid, update_listing({ handle, changes: { title: newTitle } }));
      }
  }

  function handleDescriptionBlur(e: Event) {
      const newDesc = (e.target as HTMLElement).innerHTML;
      if (listing && newDesc !== listing.bodyHtml && $user.uid) {
          broadcast(firestore, $user.uid, update_listing({ handle, changes: { bodyHtml: newDesc } }));
      }
  }

  // Image Actions
  function deleteImage(e: MouseEvent, img: ListingImage) {
      e.stopPropagation(); // Prevent selection
      if (!listing) return;
      if (confirm('Are you sure you want to remove this image?') && $user.uid) {
           broadcast(firestore, $user.uid, remove_listing_image({ handle, imageId: img.id }));
      }
  }

  import { update_field } from '$lib/inventory';

  // ... (existing imports)

  // Subtype Actions
  function deleteSubtypeImage(e: MouseEvent, item: any) {
      e.stopPropagation();
      if (!confirm(`Remove image association for ${item.subtype}?`)) return;
      
      if ($user.uid) {
          broadcast(firestore, $user.uid, update_field({ 
              id: item.id, 
              field: 'image', 
              from: item.image, 
              to: '' 
          }));
      }
  }

  // Reuse validation/state logic, but add a flag or separate state if needed because 
  // replacing a subtype image is different from replacing a generic gallery image.
  // Actually, we can just use the same upload flow and detect if we are targeting a subtype.
  
  let replacingSubtypeId: string | null = null;

  async function triggerSubtypeReplace(e: MouseEvent, item: any) {
      e.stopPropagation();
      replacingSubtypeId = item.id;
      fileInput.click();
  }

  // Update existing triggerReplace to clear subtype flag
  async function triggerReplace(e: MouseEvent, img: ListingImage) {
      e.stopPropagation();
      uploadingImageId = img.id;
      replacingImagePosition = img.position;
      replacingSubtypeId = null; // Ensure we are not in subtype mode
      fileInput.click();
  }

  async function handleFileUpload(event: Event) {
      const target = event.target as HTMLInputElement;
      if (!target.files || target.files.length === 0 || (!uploadingImageId && !replacingSubtypeId) || !listing) return;
      
      const file = target.files[0];
      
      try {
          const token = getStoredToken();
          if (!token) {
              initiateOAuthFlow();
              return;
          }
          
          const folders = await ensureFolderStructure(token.access_token);
          const result = await uploadImageToDrive(file, `replace_${handle}_${Date.now()}.jpg`, folders.processedId, token.access_token);
          const newUrl = result.thumbnailLink || result.webViewLink;

          if ($user.uid) {
              if (replacingSubtypeId) {
                  // Subtype Replacement Mode
                  // 1. Update the inventory item to point to the new URL
                  // 2. Add the new image to the listing if it's not strictly required by the data model 
                  //    but usually good to have in valid listing images.
                  //    Actually, for subtypes, we just update the item.image field.
                  const item = associatedItems.find(i => i.id === replacingSubtypeId);
                  if (item) {
                      broadcast(firestore, $user.uid, update_field({
                          id: item.id,
                          field: 'image',
                          from: item.image,
                          to: newUrl
                      }));
                      
                      // Optional: Add to listing images if we want it in the gallery too?
                      // The current logic filters listing images if they match subtype URLs.
                      // So if we add it, it won't show in gallery if it matches.
                      // Ideally we should add it to listing images so it exists in the 'listing' context too.
                      const newImage: ListingImage = {
                          id: crypto.randomUUID(),
                          url: newUrl,
                          position: listing.images.length, // Append to end
                          altText: `${listing.title} - ${item.subtype}`
                      };
                      broadcast(firestore, $user.uid, add_listing_image({ handle, image: newImage }));
                  }
              } else if (uploadingImageId) {
                   // Standard Listing Image Replacement (Existing Logic)
                   const oldImageId = uploadingImageId;
                   const oldPosition = replacingImagePosition || 0;
                   
                   broadcast(firestore, $user.uid, remove_listing_image({ handle, imageId: oldImageId }));
                   
                   const newImage: ListingImage = {
                       id: crypto.randomUUID(),
                       url: newUrl,
                       position: oldPosition,
                       altText: listing.title
                   };
                   broadcast(firestore, $user.uid, add_listing_image({ handle, image: newImage }));
              }
          }
          
      } catch (e) {
          console.error("Upload failed", e);
          alert("Failed to upload image. Check console.");
      } finally {
          uploadingImageId = null;
          replacingImagePosition = null;
          replacingSubtypeId = null;
          if (fileInput) fileInput.value = "";
      }
  }

  // Computed display values
  $: price = associatedItems.length > 0 && associatedItems[0].price 
      ? `€${associatedItems[0].price.toFixed(2)} EUR` 
      : 'Price not set';
      
  $: stockCount = associatedItems.reduce((sum, item) => sum + (item.qty || 0), 0);

  // Search Logic (Unchanged)
  function handleSearch() {
      if (!searchTerm) {
          matchingHandles = [];
          return;
      }
      const q = searchTerm.toLowerCase();
      matchingHandles = Object.keys($store.listings.handleToListing).filter(h => h.toLowerCase().includes(q));
      
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
               <!-- Hero Image -->
               <div class="main-image-container">
                   {#if mainImageObj && mainImageObj.url}
                       <img src={mainImageObj.url} alt={mainImageObj.altText} class="main-image" />
                   {:else}
                       <span class="no-image-text">No image available</span>
                   {/if}
               </div>

               <!-- Gallery Thumbnails (Images Not Associated with Subtypes) -->
               {#if galleryImages.length > 0}
                   <div class="section-label">Gallery Images</div>
                   <div class="thumbnails-grid">
                       {#each galleryImages as img}
                           <div 
                                class="thumbnail-wrapper"
                                on:mouseenter={() => handleThumbnailHover(img)}
                                on:mouseleave={handleThumbnailLeave}
                           >
                               <button class="thumbnail-btn">
                                   <img src={img.url} alt={img.altText} class="thumbnail-img" />
                               </button>
                               
                               <!-- Hover Overlay -->
                               <div class="thumb-overlay">
                                   <button class="overlay-btn delete" on:click={(e) => deleteImage(e, img)} title="Delete">
                                       ✕
                                   </button>
                                   <button class="overlay-btn upload" on:click={(e) => triggerReplace(e, img)} title="Replace">
                                       ⬆
                                   </button>
                               </div>
                           </div>
                       {/each}
                   </div>
               {/if}
               
               <!-- Subtype Images Section -->
               {#if associatedItems.length > 0}
                   <div class="section-label mt-4">Subtype Images</div>
                   <div class="subtype-list">
                       {#each associatedItems as item}
                           {#if item.image}
                               <div class="subtype-row">
                                   <span class="subtype-label">{item.subtype || 'Default'}</span>
                                   <div class="subtype-thumb-wrapper">
                                       <button 
                                          class="subtype-thumb-btn {selectedSubtypeId === item.id ? 'selected' : ''}"
                                          on:click={() => handleSubtypeSelect(item.id)}
                                          title={item.subtype}
                                       >
                                           <img src={item.image} alt={item.subtype} class="thumbnail-img" />
                                       </button>
                                       <div class="subtype-overlay">
                                           <button class="overlay-btn delete" on:click={(e) => deleteSubtypeImage(e, item)} title="Unlink Image">
                                               ✕
                                           </button>
                                           <button class="overlay-btn upload" on:click={(e) => triggerSubtypeReplace(e, item)} title="Replace Image">
                                               ⬆
                                           </button>
                                       </div>
                                   </div>
                               </div>
                           {:else}
                               <!-- Placeholder for subtypes without images? Or skip? User said "shown for each subtype" -->
                               <div class="subtype-row">
                                   <span class="subtype-label">{item.subtype || 'Default'}</span>
                                   <div class="subtype-placeholder">No Image</div>
                               </div>
                           {/if}
                       {/each}
                   </div>
               {/if}
          </div>

          <!-- Right Column: Details -->
          <div class="details-column">
               <div class="title-block">
                   <h1 
                      class="listing-title editable" 
                      contenteditable="true"
                      on:blur={handleTitleBlur}
                   >{listing.title}</h1>
                   <div class="listing-price">{price}</div>
                   <div class="tax-note">Taxes included.</div>
               </div>
               
               <div 
                  class="description-block editable"
                  contenteditable="true"
                  on:blur={handleDescriptionBlur}
               >
                   {@html listing.bodyHtml}
               </div>

               <!-- Subtypes / Options -->
               {#if associatedItems.length > 1}
                  <div class="options-block">
                      <label class="option-label">{listing.option1Name || 'Option'}</label>
                      <div class="options-list">
                          {#each associatedItems as item}
                              <button 
                                  class="option-btn {item.qty > 0 ? 'available' : 'unavailable'} {selectedSubtypeId === item.id ? 'active' : ''}"
                                  on:click={() => handleSubtypeSelect(item.id)}
                              >
                                  {item.subtype || 'Default'}
                              </button>
                          {/each}
                      </div>
                  </div>
               {/if}
               
               <!-- Actions & Quantity (Unchanged) -->
               <div class="quantity-block">
                   <label class="option-label">Quantity</label>
                   <div class="quantity-selector">
                       <button class="qty-btn">-</button>
                       <div class="qty-value">1</div>
                       <button class="qty-btn">+</button>
                   </div>
               </div>

               <div class="actions-block">
                   <button class="btn-add-cart">Add to cart</button>
                   <button class="btn-buy-shop">Buy with <span class="shop-logo">shop</span></button>
                   <div class="payment-options"><a href="#" class="payment-link">More payment options</a></div>
               </div>
               
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
  
  <!-- Hidden File Input for Replacements -->
  <input 
      type="file" 
      accept="image/*" 
      class="hidden-input"
      bind:this={fileInput}
      on:change={handleFileUpload}
  />
</div>

<style>
  .container { max-width: 1200px; margin: 0 auto; padding: 2rem; font-family: sans-serif; color: #333; }
  .hidden-input { display: none; }
  
  /* Sections */
  .section-label { font-size: 0.85rem; font-weight: 600; color: #6b7280; margin-bottom: 0.5rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .mt-4 { margin-top: 1rem; }

  /* Search Header (Same) */
  .search-header { margin-bottom: 2rem; display: flex; flex-direction: column; gap: 0.5rem; position: relative; }
  .search-bar-row { display: flex; gap: 0.5rem; }
  .search-input { border: 1px solid #ccc; border-radius: 4px; padding: 0.5rem 1rem; width: 100%; max-width: 400px; font-size: 1rem; }
  .search-input:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2); }
  .back-btn { background: #f3f4f6; padding: 0.5rem 1rem; border-radius: 4px; border: none; cursor: pointer; }
  .back-btn:hover { background: #e5e7eb; }
  .search-results { position: absolute; top: 100%; left: 0; width: 100%; max-width: 400px; background: white; border: 1px solid #e5e7eb; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); border-radius: 4px; z-index: 10; max-height: 240px; overflow-y: auto; }
  .result-item { width: 100%; text-align: left; padding: 0.5rem 1rem; background: none; border: none; cursor: pointer; }
  .result-item:hover { background: #eff6ff; }

  /* Layout */
  .listing-content { display: flex; flex-direction: column; gap: 3rem; }
  @media (min-width: 768px) { .listing-content { flex-direction: row; align-items: flex-start; } }
  .image-column { width: 100%; flex-shrink: 0; display: flex; flex-direction: column; gap: 1rem; }
  @media (min-width: 768px) { .image-column { width: 30%; } }
  .details-column { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1.5rem; }

  /* Images */
  .main-image-container { aspect-ratio: 1 / 1; width: 100%; background: #f9fafb; border-radius: 8px; overflow: hidden; border: 1px solid #f3f4f6; display: flex; align-items: center; justify-content: center; margin-bottom: 1rem; }
  .main-image { width: 100%; height: 100%; object-fit: contain; }
  .no-image-text { color: #9ca3af; }
  
  .thumbnails-grid { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  
  .thumbnail-wrapper { position: relative; width: 23%; aspect-ratio: 1 / 1; }
  .thumbnail-btn { width: 100%; height: 100%; border: 1px solid #e5e7eb; border-radius: 4px; overflow: hidden; cursor: pointer; padding: 0; background: white; opacity: 1; transition: opacity 0.2s; position: relative; }
  .thumbnail-btn.selected { border-color: #3b82f6; box-shadow: 0 0 0 1px #3b82f6; }
  .thumbnail-img { width: 100%; height: 100%; object-fit: cover; }
  
  /* Hover Overlay */
  .thumb-overlay { position: absolute; top: 0; right: 0; display: flex; gap: 2px; opacity: 0; transition: opacity 0.2s; background: rgba(0,0,0,0.5); padding: 2px; border-bottom-left-radius: 4px; }
  .thumbnail-wrapper:hover .thumb-overlay { opacity: 1; }
  .overlay-btn { background: none; border: none; color: white; cursor: pointer; font-size: 0.75rem; width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; }
  .overlay-btn:hover { color: #ffa; }
  .overlay-btn.delete:hover { color: #ff9999; }

  /* Editing */
  .editable { border: 1px dashed transparent; padding: 2px; transition: border-color 0.2s; border-radius: 2px; }
  .editable:hover { border-color: #cbd5e1; }
  .editable:focus { outline: none; border-color: #3b82f6; background: #f8fafc; }

  /* Typography & Details */
  .title-block { margin-bottom: 0.5rem; }
  .listing-title { font-size: 2.25rem; font-weight: 400; line-height: 1.1; color: #111827; margin: 0 0 0.5rem 0; }
  .listing-price { font-size: 1.25rem; color: #374151; font-weight: 500; }
  .tax-note { font-size: 0.875rem; color: #6b7280; margin-top: 0.25rem; }
  .description-block :global(p) { margin-bottom: 1em; line-height: 1.6; color: #4b5563; }
  .description-block :global(ul) { margin-bottom: 1em; padding-left: 1.5em; }

  /* Options */
  .options-block { display: flex; flex-direction: column; gap: 0.5rem; }
  .option-label { font-size: 0.875rem; font-weight: 500; color: #374151; }
  .options-list { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .option-btn { padding: 0.5rem 1rem; border: 1px solid #d1d5db; border-radius: 9999px; font-size: 0.875rem; background: white; cursor: pointer; }
  .option-btn.available { color: #1f2937; border-color: #d1d5db; }
  .option-btn.available:hover { border-color: #9ca3af; }
  .option-btn.active { background: #1f2937; color: white; border-color: #1f2937; } /* Selected Subtype Style */
  .option-btn.unavailable { background: #f9fafb; color: #9ca3af; border-color: #e5e7eb; cursor: not-allowed; }

  /* Quantity & Actions */
  .quantity-block { display: flex; flex-direction: column; gap: 0.5rem; }
  .quantity-selector { display: flex; align-items: center; width: 140px; border: 1px solid #d1d5db; border-radius: 4px; }
  .qty-btn { padding: 0.5rem 0.75rem; background: none; border: none; font-size: 1.2rem; color: #6b7280; cursor: pointer; }
  .qty-btn:hover { background: #f9fafb; }
  .qty-value { flex: 1; text-align: center; color: #374151; }
  .actions-block { display: flex; flex-direction: column; gap: 0.75rem; margin-top: 1rem; }
  .btn-add-cart { width: 100%; padding: 0.75rem 1.5rem; border: 1px solid #111827; background: white; color: #111827; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; cursor: pointer; transition: background 0.2s; }
  .btn-add-cart:hover { background: #f9fafb; }
  .btn-buy-shop { width: 100%; padding: 0.75rem 1.5rem; border: none; background: #5a31f4; color: white; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 0.5rem; transition: background 0.2s; }
  .btn-buy-shop:hover { background: #4820e0; }
  .shop-logo { font-weight: bold; font-style: italic; }
  .payment-options { text-align: center; }
  .payment-link { font-size: 0.875rem; color: #6b7280; text-decoration: underline; text-decoration-color: #9ca3af; }
  .payment-link:hover { color: #1f2937; }

  /* Misc */
  .stock-status { display: flex; align-items: center; gap: 0.5rem; color: #ea580c; font-size: 0.875rem; margin-top: 0.5rem; }
  .stock-dot { width: 8px; height: 8px; background: #f97316; border-radius: 50%; }
  .not-found, .empty-state { text-align: center; padding: 5rem 0; color: #6b7280; }
  .not-found-text, .empty-text { font-size: 1.25rem; }
  .handle-text { font-family: monospace; color: #374151; }
  .link-btn { margin-top: 1rem; color: #2563eb; background: none; border: none; text-decoration: underline; cursor: pointer; font-size: 1rem; }
  .link-btn:hover { color: #1d4ed8; }

  /* Subtype List Styles */
  .subtype-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
  }
  .subtype-row {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 0.25rem 0;
  }
  .subtype-label {
      font-size: 0.875rem;
      font-weight: 500;
      color: #374151;
      width: 80px; /* Fixed width for alignment */
      text-align: right;
  }
  .subtype-thumb-btn {
      width: 64px;
      height: 64px;
      border: 1px solid #e5e7eb;
      border-radius: 4px;
      overflow: hidden;
      cursor: pointer;
      padding: 0;
      background: white;
      opacity: 0.8;
      transition: all 0.2s;
  }
  .subtype-thumb-btn:hover {
      opacity: 1;
      border-color: #9ca3af;
  }
  .subtype-thumb-btn.selected {
      opacity: 1;
      border-color: #3b82f6;
      box-shadow: 0 0 0 2px #3b82f6;
  }
  .subtype-placeholder {
      width: 64px;
      height: 64px;
      background: #f3f4f6;
      border: 1px dashed #d1d5db;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.7rem;
      color: #9ca3af;
      text-align: center;
      padding: 4px;
  }
  .subtype-thumb-wrapper {
      position: relative;
      width: 64px;
      height: 64px;
  }
  .subtype-overlay {
      position: absolute;
      top: 0;
      right: 0;
      display: flex;
      gap: 1px;
      opacity: 0;
      transition: opacity 0.2s;
      background: rgba(0,0,0,0.6);
      padding: 2px;
      border-bottom-left-radius: 4px;
  }
  .subtype-thumb-wrapper:hover .subtype-overlay {
      opacity: 1;
  }
</style>
