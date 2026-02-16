<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { flip } from "svelte/animate";
  import { cubicOut } from "svelte/easing";
  import { fade } from "svelte/transition";
  import SecureImage from '$lib/components/SecureImage.svelte';
  import CategoryBrowseModal from './CategoryBrowseModal.svelte';
  
  export let listing: { title: string; bodyHtml: string; option1Name?: string; productCategory?: string } | null = null;
  export let images: any[] = []; // ListingImage[]
  export let associatedItems: any[] = []; // (Item & {id: string})[]
  export let knownCategories: string[] = [];
  export let selectedSubtypeId: string | null = null;
  export let readOnly = false;
  export let isCreationMode = false; // Toggle for "Approve" button vs "Add to cart"
  export let isGeneratingTitle: boolean = false;
  export let isGeneratingDescription = false;
  
  const dispatch = createEventDispatcher();
  
  // Validation
  $: isPriceValid = associatedItems.length > 0 && (associatedItems[0].price || 0) > 0;
  $: normalizedCategories = knownCategories.map(c => c.trim()).filter(Boolean);
  $: categorySet = new Set(normalizedCategories);
  $: isCategoryValid = !!(listing && listing.productCategory && categorySet.has(listing.productCategory));
  $: isReadyToApprove = isPriceValid && isCategoryValid;

  // Category Autocomplete State
  let showCategoryDropdown = false;
  let showCategoryBrowser = false;
  let categorySearchTerm = '';
  // Initialize search term from prop if not interacting
  let isCategoryInteracting = false;
  $: if (listing && listing.productCategory !== undefined && !isCategoryInteracting) {
      if (categorySearchTerm !== listing.productCategory) {
          categorySearchTerm = listing.productCategory;
      }
  }
  
  let categoryError = '';
  $: filteredCategories = categorySearchTerm 
      ? normalizedCategories.filter(c => c.toLowerCase().includes(categorySearchTerm.toLowerCase())).slice(0, 100)
      : normalizedCategories.slice(0, 20);

  let hoveredImage: any | null = null;
  let draggingId: string | null = null;
  let dragOverId: string | null = null;
  let previewOrderIds: string[] | null = null;

  // Subtype DnD State
  let draggingSubtypeId: string | null = null;
  let dragOverSubtypeId: string | null = null;
  let previewSubtypeOrderIds: string[] | null = null;

  // Split Images
  // Subtype Images: specific images linked to inventory items
  // We show ALL images in the gallery to allow reordering.
  $: subtypeImageUrls = new Set(associatedItems.map(i => {
      if (i.variantImage) return i.variantImage;
      // Resolve implicit photo group image to ensure consistent filtering in Draft mode
      if (i.photoGroupKey) {
          const groupImg = images.find(img => img.sourceGroup === i.photoGroupKey);
          if (groupImg) return groupImg.url;
      }
      return i.image;
  }).filter(Boolean));
  
  // Dedupe images by ID to prevent crash
  $: uniqueImages = Array.from(new Map((images || []).map(img => [img.id, img])).values());
  
  $: galleryImages = uniqueImages
      .filter((img) => !subtypeImageUrls.has(img.url) || img.isListingOnly)
      .sort((a, b) => a.position - b.position);

  $: displayedGalleryImages = (() => {
      if (!previewOrderIds || previewOrderIds.length === 0) {
          return galleryImages;
      }
      const byId = new Map(galleryImages.map(img => [img.id, img]));
      const ordered: any[] = [];
      previewOrderIds.forEach(id => {
          const img = byId.get(id);
          if (img) {
              ordered.push(img);
              byId.delete(id);
          }
      });
      return [...ordered, ...Array.from(byId.values())];
  })();

  // Dedupe subtypes to prevent crash
  $: uniqueAssociatedItems = Array.from(new Map(associatedItems.map(item => [item.variantId || item.id, item])).values());

  $: displayedSubtypes = (() => {
      if (!previewSubtypeOrderIds || previewSubtypeOrderIds.length === 0) {
          return uniqueAssociatedItems;
      }
      // Use variantId or id as key
      const byId = new Map(uniqueAssociatedItems.map(item => [item.variantId || item.id, item]));
      const ordered: any[] = [];
      previewSubtypeOrderIds.forEach(id => {
          const item = byId.get(id);
          if (item) {
              ordered.push(item);
              byId.delete(id);
          }
      });
      return [...ordered, ...Array.from(byId.values())];
  })();

  // Hero Image Logic
  $: mainImageObj = (() => {
      if (hoveredImage) return hoveredImage;
      
      if (selectedSubtypeId) {
          const item = associatedItems.find(i => (i.variantId || i.id) === selectedSubtypeId);
          if (item) {
              // 1. Explicit Override
              if (item.variantImage) {
                  const existing = images.find(img => img.url === item.variantImage);
                  return existing || { url: item.variantImage, altText: item.subtype, id: 'subtype-ovr-'+(item.variantId||item.id), position: -1 };
              }
              
              // 2. Photo Group (from Gallery)
              if (item.photoGroupKey) {
                  const groupImg = images.find(img => img.sourceGroup === item.photoGroupKey);
                  if (groupImg) return groupImg;
              }

              // 3. Inventory Image (Fallback)
              if (item.image) {
                  const existing = images.find(img => img.url === item.image);
                  return existing || { url: item.image, altText: item.subtype, id: 'subtype-inv-'+(item.variantId||item.id), position: -1 };
              }
          }
      }
      
      return galleryImages.length > 0 ? galleryImages[0] : null;
  })();

  // Interaction Handlers
  function handleSubtypeSelect(id: string) {
      dispatch('selectSubtype', id);
  }

  // Subtype DnD Handlers
  function handleSubtypeDragStart(e: DragEvent, item: any) {
      if (readOnly) return;
      const key = item.variantId || item.id;
      draggingSubtypeId = key;
      previewSubtypeOrderIds = displayedSubtypes.map(i => i.variantId || i.id);
      
      e.dataTransfer?.setData("text/plain", key);
      // Optional: Custom drag image
  }

  function handleSubtypeDragOver(e: DragEvent, targetId: string) {
      if (readOnly) return;
      e.preventDefault();
      if (!draggingSubtypeId) return;
      if (!targetId || targetId === draggingSubtypeId || !previewSubtypeOrderIds) return;
      
      dragOverSubtypeId = targetId;
      
      const next = previewSubtypeOrderIds.slice();
      const fromIndex = next.indexOf(draggingSubtypeId);
      const toIndex = next.indexOf(targetId);
      
      if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return;
      
      next.splice(fromIndex, 1);
      next.splice(toIndex, 0, draggingSubtypeId);
      previewSubtypeOrderIds = next;
  }

  function handleSubtypeDrop(e: DragEvent) {
      if (readOnly) return;
      e.preventDefault();
      if (draggingSubtypeId && previewSubtypeOrderIds) {
          dispatch('reorderSubtypes', { order: previewSubtypeOrderIds });
      }
      draggingSubtypeId = null;
      dragOverSubtypeId = null;
      previewSubtypeOrderIds = null;
  }

  function handleThumbnailHover(img: any) {
      hoveredImage = img;
  }
  
  function handleThumbnailLeave() {
      hoveredImage = null;
  }

  // Editing Handlers
  function handleTitleBlur(e: Event) {
      if (readOnly) return;
      const newTitle = (e.target as HTMLElement).innerText;
      if (listing && newTitle !== listing.title) {
          dispatch('updateTitle', newTitle);
      }
  }

  function handleDescriptionBlur(e: Event) {
      if (readOnly || isGeneratingDescription) return;
      const newDesc = (e.target as HTMLElement).innerHTML;
      if (listing && newDesc !== listing.bodyHtml) {
          dispatch('updateDescription', newDesc);
      }
  }

  function handlePriceChange(e: Event) {
      if (readOnly) return;
      const target = e.target as HTMLInputElement;
      const newPrice = parseFloat(target.value);
      if (!isNaN(newPrice)) {
          dispatch('updatePrice', newPrice);
      }
  }

  function handleCategoryFocus() {
      if (readOnly) return;
      isCategoryInteracting = true;
      showCategoryDropdown = true;
  }
  
  function handleCategoryBlur() {
      // Delay to allow click on dropdown option
      setTimeout(() => {
          showCategoryDropdown = false;
          isCategoryInteracting = false;
          const trimmed = categorySearchTerm.trim();
          if (!listing) return;
          if (!trimmed) {
              categoryError = "Category required";
              categorySearchTerm = listing.productCategory || "";
              return;
          }
          if (!categorySet.has(trimmed)) {
              categoryError = "Select a valid Shopify category";
              categorySearchTerm = listing.productCategory || "";
              return;
          }
          categoryError = '';
          if (trimmed !== listing.productCategory) {
              dispatch('updateCategory', trimmed);
          }
      }, 200);
  }
  
  function handleCategoryInput(e: Event) {
      if (readOnly) return;
      categorySearchTerm = (e.target as HTMLInputElement).value;
      categoryError = '';
      showCategoryDropdown = true;
  }
  
  function selectCategory(cat: string) {
      categorySearchTerm = cat;
      categoryError = '';
      dispatch('updateCategory', cat);
      showCategoryDropdown = false;
      isCategoryInteracting = false;
  }

  // Image Actions
  function deleteImage(e: MouseEvent, img: any) {
      e.stopPropagation();
      if (readOnly) return;
      if (confirm('Are you sure you want to remove this image?')) {
           dispatch('deleteImage', img);
      }
  }

  function deleteSubtypeImage(e: MouseEvent, item: any) {
      e.stopPropagation();
      if (readOnly) return;
      if (confirm(`Remove image association for ${item.subtype}?`)) {
           dispatch('deleteSubtypeImage', item);
      }
  }

  function triggerReplace(e: MouseEvent, img: any) {
      e.stopPropagation();
      if (readOnly) return;
      dispatch('replaceImage', img);
  }

  function triggerSubtypeReplace(e: MouseEvent, item: any) {
      e.stopPropagation();
      if (readOnly) return;
      dispatch('replaceSubtypeImage', item);
  }

  function handleDragStart(e: DragEvent, img: any) {
      if (readOnly) return;
      draggingId = img.id;
      previewOrderIds = galleryImages.map(g => g.id);
      e.dataTransfer?.setData("text/plain", img.id);
      e.dataTransfer?.setDragImage((e.target as HTMLElement), 40, 40);
  }

  function handleDragOver(e: DragEvent, targetId?: string) {
      if (readOnly) return;
      e.preventDefault();
      if (!draggingId) return;
      const targetEl = e.currentTarget as HTMLElement;
      if (targetEl.classList.contains("dragging")) return;
      if (!targetId || targetId === draggingId || !previewOrderIds) return;
      dragOverId = targetId;
      const next = previewOrderIds.slice();
      const fromIndex = next.indexOf(draggingId);
      const toIndex = next.indexOf(targetId);
      if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return;
      next.splice(fromIndex, 1);
      next.splice(toIndex, 0, draggingId);
      previewOrderIds = next;
  }

  function handleDrop(e: DragEvent) {
      if (readOnly) return;
      e.preventDefault();
      if (!draggingId) return;
      if (dragOverId && dragOverId !== draggingId) {
          dispatch('reorderImages', { sourceId: draggingId, targetId: dragOverId });
      }
      draggingId = null;
      dragOverId = null;
      previewOrderIds = null;
  }

  function handleDragEnd() {
      draggingId = null;
      dragOverId = null;
      previewOrderIds = null;
  }

  function handleQtyChange(e: Event, item: any) {
      const val = parseInt((e.target as HTMLInputElement).value, 10);
      if (!isNaN(val) && val >= 0) {
          dispatch('updateVariantQty', { id: item.variantId || item.id, qty: val });
      }
  }
  
  function handleSubtypeBlur(e: Event, item: any) {
      const newVal = (e.target as HTMLElement).innerText.trim();
      if (newVal !== (item.subtype || 'Default')) {
          const id = item.variantId || item.id;
          dispatch('updateVariantValue', { id, value: newVal });
      }
  }

  // Computed display values
  $: price = associatedItems.length > 0 && associatedItems[0].price 
      ? `€${associatedItems[0].price.toFixed(2)} EUR` 
      : 'Price not set';
      
  $: stockCount = associatedItems.reduce((sum, item) => sum + (item.qty || 0), 0);
</script>

{#if listing}
  <div class="listing-content">
      <!-- Left Column: Images -->
      <div class="image-column">
           <!-- Hero Image -->
           <div class="main-image-container">
               {#if mainImageObj && mainImageObj.url}
                   <SecureImage src={mainImageObj.url} alt={mainImageObj.altText} className="main-image" />
               {:else}
                   <span class="no-image-text">No image available</span>
               {/if}
           </div>

           <!-- Gallery Thumbnails (Images Not Associated with Subtypes) -->
           {#if galleryImages.length > 0 || !readOnly}
               <div class="section-label">Gallery Images</div>
               <div class="thumbnails-grid" role="list" on:dragover={handleDragOver} on:drop={handleDrop}>
                   {#each displayedGalleryImages as img, i (img.id || `gallery-${i}`)}
                       <div 
                            class="thumbnail-container"
                            class:dragging={draggingId === img.id}
                            class:drag-over={dragOverId === img.id}
                            data-image-id={img.id}
                            draggable={!readOnly}
                            role="listitem"
                            animate:flip={{ duration: 300, easing: cubicOut }}
                            on:dragstart={(e) => handleDragStart(e, img)}
                            on:dragover={(e) => handleDragOver(e, img.id)}
                            on:drop={handleDrop}
                            on:dragend={handleDragEnd}
                            on:mouseenter={() => handleThumbnailHover(img)}
                            on:mouseleave={handleThumbnailLeave}
                       >
                           <div class="thumbnail-btn">
                               <SecureImage src={img.url} alt={img.altText} className="thumbnail-img" />
                           </div>
                           
                           <!-- Hover Overlay -->
                           {#if !readOnly}
                           <div class="thumb-overlay">
                               <button class="overlay-btn delete" on:click={(e) => deleteImage(e, img)} title="Delete">
                                   ✕
                               </button>
                               <button class="overlay-btn upload" on:click={(e) => triggerReplace(e, img)} title="Replace">
                                   ⬆
                               </button>
                           </div>
                           {/if}
                       </div>
                   {/each}
                   
                   {#if !readOnly}
                       <div class="thumbnail-container">
                           <button class="thumbnail-btn add-btn" on:click={() => dispatch('addImage')} title="Add Image">
                               <span class="plus-icon">+</span>
                           </button>
                       </div>
                   {/if}
               </div>
           {/if}
           
           <!-- Subtype Images Section -->
           {#if associatedItems.length > 0}
               <div class="section-label mt-4">Subtype Images</div>
               {#if isCreationMode}
                   <div class="subtype-header-row">
                       <span class="subtype-label-header">Variant</span>
                       <span class="subtype-qty-header">Alloc.</span>
                       <span class="subtype-img-header">Image</span>
                   </div>
               {/if}
               <div class="subtype-list">
                   {#each associatedItems as item, i (i)}
                       {@const subtypeImg = (item.variantImage ? { url: item.variantImage } : null) || 
                           (item.photoGroupKey ? images.find(img => img.sourceGroup === item.photoGroupKey) : null) || 
                           (item.image ? { url: item.image } : null)
                       }
                       <div class="subtype-row">
                           <span 
                               class="subtype-label {!readOnly ? 'editable' : ''}"
                               contenteditable={!readOnly}
                               on:blur={(e) => handleSubtypeBlur(e, item)}
                           >{item.subtype || 'Default'}</span>
                           
                           {#if isCreationMode}
                               <input 
                                   type="number" 
                                   min="0" 
                                   class="subtype-qty-input"
                                   value={item.allocatedQty !== undefined ? item.allocatedQty : 0}
                                   on:input={(e) => handleQtyChange(e, item)}
                                   placeholder="Qty"
                                   title="Allocated Quantity"
                               />
                           {/if}

                           {#if subtypeImg}
                               <div class="subtype-thumb-wrapper">
                                   <button 
                                      class="subtype-thumb-btn {selectedSubtypeId === (item.variantId || item.id) ? 'selected' : ''}"
                                      on:click={() => !readOnly ? dispatch('replaceSubtypeImage', item) : handleSubtypeSelect(item.variantId || item.id)}
                                      on:mouseenter={() => handleThumbnailHover(subtypeImg)}
                                      on:mouseleave={handleThumbnailLeave}
                                      title={!readOnly ? "Click to Replace Image" : item.subtype}
                                   >
                                       <SecureImage src={subtypeImg.url} alt={item.subtype} className="thumbnail-img" />
                                   </button>
                                   {#if !readOnly}
                                   <div class="subtype-overlay">
                                       <button class="overlay-btn delete" on:click={(e) => deleteSubtypeImage(e, item)} title="Unlink Image">
                                           ✕
                                       </button>
                                       <button class="overlay-btn upload" on:click={(e) => triggerSubtypeReplace(e, item)} title="Replace Image">
                                           ⬆
                                       </button>
                                   </div>
                                   {/if}
                               </div>
                           {:else}
                               <button 
                                   type="button"
                                   class="subtype-placeholder" 
                                   on:click={() => !readOnly ? dispatch('replaceSubtypeImage', item) : null} 
                                   style="cursor: {!readOnly ? 'pointer' : 'default'}"
                                   disabled={readOnly}
                               >
                                   No Image
                               </button>
                           {/if}
                       </div>
                   {/each}
               </div>
           {/if}
      </div>

      <!-- Right Column: Details -->
      <div class="details-column">
           <div class="title-block">
               <h1 
                  class="listing-title {readOnly ? '' : 'editable'}"
                  class:generating={isGeneratingTitle}
                  contenteditable={!readOnly}
                  on:blur={handleTitleBlur}
               >{listing.title}</h1>
               <!-- Price Input (Parsed correctly) -->
               <div class="listing-price-container {(!isPriceValid && !readOnly) ? 'invalid' : ''}">
                   <span class="currency">€</span>
                   {#if readOnly}
                       <span class="price-val">{associatedItems[0]?.price?.toFixed(2) || '0.00'}</span>
                   {:else}
                       <input 
                           type="number" 
                           class="price-input editable" 
                           step="0.01" 
                           min="0"
                           value={associatedItems[0]?.price || 0} 
                           on:change={handlePriceChange}
                           title="Price in EUR"
                       />
                   {/if}
                   <span class="currency">EUR</span>
               </div>
               <div class="tax-note">Taxes included.</div>
           </div>
           
           <!-- Product Category -->
           <div class="category-block">
               <span class="field-label">Category</span>
               {#if readOnly}
                    <span class="category-val">{listing.productCategory || 'Uncategorized'}</span>
               {:else}
                       <div class="category-input-wrapper {(!isCategoryValid || !!categoryError) ? 'invalid' : ''}" style="position: relative;">
                       <input 
                           type="text" 
                           class="category-input editable" 
                           bind:value={categorySearchTerm}
                           on:input={handleCategoryInput}
                           on:focus={handleCategoryFocus}
                           on:blur={handleCategoryBlur}
                           placeholder="Search or type category..."
                       />
                       <button 
                           class="category-add-btn" 
                           type="button"
                           title="Browse Shopify Taxonomy"
                           on:click={() => showCategoryBrowser = true}
                       >
                           +
                       </button>
                       {#if showCategoryDropdown}
                           <div class="category-dropdown" role="listbox">
                               {#if filteredCategories.length === 0}
                                   <div class="category-option empty" aria-disabled="true">
                                       No matching categories
                                   </div>
                               {:else}
                                   {#each filteredCategories as cat}
                                       <!-- svelte-ignore a11y-click-events-have-key-events -->
                                       <div 
                                           class="category-option" 
                                           role="option" 
                                           aria-selected={cat === categorySearchTerm}
                                           on:mousedown|preventDefault={() => selectCategory(cat)}
                                           on:keydown={(e) => e.key === 'Enter' && selectCategory(cat)}
                                           tabindex="0"
                                       >
                                           {cat}
                                       </div>
                                   {/each}
                               {/if}
                           </div>
                       {/if}
                       {#if categoryError}
                           <span class="category-error">{categoryError}</span>
                       {/if}
                   </div>
               {/if}
           </div>
           
           <div 
              class="description-block {readOnly ? '' : 'editable'}"
              contenteditable={!readOnly}
              on:blur={handleDescriptionBlur}
           >
               {@html listing.bodyHtml}
           </div>

           <!-- Subtypes / Options -->
           {#if associatedItems.length > 1}
              <div class="options-block">
                  <span class="option-label">{listing.option1Name || 'Option'}</span>
                  <div class="options-list" role="list">
                      {#each displayedSubtypes as item (item.variantId || item.id)}
                          <button 
                              class="option-btn {item.qty > 0 ? 'available' : 'unavailable'} {selectedSubtypeId === (item.variantId || item.id) ? 'active' : ''}"
                              draggable={!readOnly}
                              animate:flip={{ duration: 300, easing: cubicOut }}
                              on:click={() => handleSubtypeSelect(item.variantId || item.id)}
                              on:dragstart={(e) => handleSubtypeDragStart(e, item)}
                              on:dragover={(e) => handleSubtypeDragOver(e, item.variantId || item.id)}
                              on:drop={(e) => handleSubtypeDrop(e)}
                          >
                              {item.subtype || 'Default'}
                          </button>
                      {/each}
                  </div>
              </div>
           {/if}
           
           <!-- Actions & Quantity -->
           {#if isCreationMode}
               <div class="actions-block">
                   <button class="btn-buy-shop" on:click={() => dispatch('approve')} disabled={!isReadyToApprove}>
                       Approve & Publish
                   </button>
                   <button class="btn-drop" on:click={() => dispatch('drop')}>
                       Drop Proposal
                   </button>
               </div>
           {:else}
               <div class="quantity-block">
                   <span class="option-label">Quantity</span>
                   <div class="quantity-selector">
                       <button class="qty-btn">-</button>
                       <div class="qty-value">1</div>
                       <button class="qty-btn">+</button>
                   </div>
               </div>

               <div class="actions-block">
                   <button class="btn-add-cart">Add to cart</button>
                   <button class="btn-buy-shop">Buy with <span class="shop-logo">shop</span></button>
                   <div class="payment-options"><button class="payment-link" type="button">More payment options</button></div>
               </div>
           {/if}
           
           {#if stockCount > 0 && stockCount < 10}
               <div class="stock-status">
                   <span class="stock-dot"></span>
                   Low stock: {stockCount} left
               </div>
           {/if}
      </div>
  </div>
{/if}

<style>
  /* Sections */
  .section-label { font-size: 0.85rem; font-weight: 600; color: #6b7280; margin-bottom: 0.5rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .mt-4 { margin-top: 1rem; }

  /* Layout */
  .listing-content { display: flex; flex-direction: column; gap: 3rem; }
  @media (min-width: 768px) { .listing-content { flex-direction: row; align-items: flex-start; } }
  .image-column { width: 100%; flex-shrink: 0; display: flex; flex-direction: column; gap: 1rem; }
  @media (min-width: 768px) { .image-column { width: 30%; } }
  .details-column { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1.5rem; }

  /* Images */
  .main-image-container { 
       width: 100%; 
       height: auto;
       aspect-ratio: 1 / 1; 
       max-width: 400px; /* Constraint width */
       background: #f9fafb; 
       border-radius: 8px; 
       overflow: hidden; 
       border: 1px solid #f3f4f6; 
       display: flex; 
       align-items: center; 
       justify-content: center; 
       margin-bottom: 1rem; 
       align-self: center; /* Center in column */
  }
  :global(.main-image) { width: 100%; height: 100%; object-fit: contain; }
  .no-image-text { color: #9ca3af; }
  
  .thumbnails-grid { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  
  .thumbnail-container { position: relative; width: 23%; aspect-ratio: 1 / 1; }
  .thumbnail-container[draggable="true"] { cursor: grab; }
  .thumbnail-container[draggable="true"]:active { cursor: grabbing; }
  .thumbnail-container.drag-over { outline: 2px dashed #3b82f6; outline-offset: 2px; background: rgba(59, 130, 246, 0.08); }
  .thumbnail-container.dragging { opacity: 0.6; transition: none; }
  .thumbnail-btn { width: 100%; height: 100%; border: 1px solid #e5e7eb; border-radius: 4px; overflow: hidden; cursor: grab; padding: 0; background: white; opacity: 1; transition: opacity 0.2s; position: relative; user-select: none; }
  .thumbnail-btn :global(img) { pointer-events: none; }
  :global(.thumbnail-btn.selected) { border-color: #3b82f6; box-shadow: 0 0 0 1px #3b82f6; }
  :global(.thumbnail-img) { width: 100%; height: 100%; object-fit: cover; }
  
  /* Hover Overlay */
  .thumb-overlay { position: absolute; top: 0; right: 0; display: flex; gap: 2px; opacity: 0; transition: opacity 0.2s; background: rgba(0,0,0,0.5); padding: 2px; border-bottom-left-radius: 4px; }
  .thumbnail-container:hover .thumb-overlay { opacity: 1; }
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
  .listing-title.generating { opacity: 0.65; animation: titlePulse 1.4s ease-in-out infinite; }
  @keyframes titlePulse {
      0% { opacity: 0.55; }
      50% { opacity: 0.95; }
      100% { opacity: 0.55; }
  }
  
  /* Updated Price Styling */
  .listing-price-container { 
      font-size: 1.25rem; 
      color: #374151; 
      font-weight: 500; 
      display: flex; 
      align-items: center; 
      gap: 4px;
  }
  .price-input {
      font-size: inherit;
      font-weight: inherit;
      color: inherit;
      border: 1px dashed transparent;
      padding: 0 2px;
      width: 100px;
      background: transparent;
  }
  .price-input:focus {
      outline: none;
      border-color: #3b82f6;
      background: #f8fafc;
  }
  
  .tax-note { font-size: 0.875rem; color: #6b7280; margin-top: 0.25rem; }

  /* Category Input */
  .category-block { margin-bottom: 1rem; display: flex; flex-direction: column; gap: 0.25rem; }
  .field-label { font-size: 0.75rem; color: #6b7280; text-transform: uppercase; font-weight: 600; letter-spacing: 0.05em; }
  .category-input-wrapper { display: flex; align-items: center; border: 1px solid #d1d5db; border-radius: 4px; }
  @media (min-width: 768px) { .category-input-wrapper { min-width: 450px; } }
  .category-input { width: 100%; border: none; padding: 0.5rem; font-size: 0.9rem; color: #1f2937; text-overflow: ellipsis; }
  .category-input:focus { outline: none; background: #f8fafc; }
  
  .category-input-wrapper.invalid {
      border-color: #fca5a5;
      background: #fef2f2;
  }
  .category-input-wrapper.invalid:after {
      content: "Required";
      display: block;
      font-size: 0.7rem;
      color: #dc2626;
      font-weight: 600;
      text-transform: uppercase;
      padding-right: 0.5rem;
      white-space: nowrap;
  }

  /* Custom Category Dropdown */
  .category-dropdown {
      position: absolute;
      top: 100%;
      left: 0;
      min-width: 100%;
      width: max-content;
      max-width: 80vw;
      max-height: 300px;
      overflow-y: auto;
      background: white;
      border: 1px solid #d1d5db;
      box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);
      z-index: 50;
      border-radius: 4px;
      margin-top: 4px;
  }
  .category-option {
      padding: 0.5rem 0.75rem;
      cursor: pointer;
      border-bottom: 1px solid #f3f4f6;
      white-space: normal;
      font-size: 0.85rem;
      color: #374151;
      text-align: left;
  }
  .category-option:hover { background: #f3f9ff; color: #2563eb; }
  .category-option.empty {
      color: #9ca3af;
      cursor: default;
  }
  .category-error {
      margin-top: 0.25rem;
      font-size: 0.75rem;
      color: #dc2626;
      font-weight: 600;
  }

  .description-block :global(p) { margin-bottom: 1em; line-height: 1.6; color: #4b5563; }
  .description-block :global(ul) { margin-bottom: 1em; padding-left: 1.5em; }

  /* Options */
  .options-block { display: flex; flex-direction: column; gap: 0.5rem; }
  .option-label { font-size: 0.875rem; font-weight: 500; color: #374151; }
  .options-list { display: flex; flex-wrap: wrap; gap: 0.5rem; }
  .option-btn { padding: 0.5rem 1rem; border: 1px solid #d1d5db; border-radius: 9999px; font-size: 0.875rem; background: white; cursor: pointer; }
  .option-btn.available { color: #1f2937; border-color: #d1d5db; }
  .option-btn.available:hover { border-color: #9ca3af; }
  .option-btn.active { background: #1f2937; color: white; border-color: #1f2937; } 
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
  .btn-drop { width: 100%; padding: 0.75rem 1.5rem; border: 1px solid #dc2626; background: white; color: #dc2626; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; cursor: pointer; transition: background 0.2s, color 0.2s; }
  .btn-drop:hover { background: #fef2f2; color: #b91c1c; }
  .shop-logo { font-weight: bold; font-style: italic; }
  .payment-options { text-align: center; }
  .payment-link { font-size: 0.875rem; color: #6b7280; text-decoration: underline; text-decoration-color: #9ca3af; }
  .payment-link:hover { color: #1f2937; }

  /* Misc */
  .stock-status { display: flex; align-items: center; gap: 0.5rem; color: #ea580c; font-size: 0.875rem; margin-top: 0.5rem; }
  .stock-dot { width: 8px; height: 8px; background: #f97316; border-radius: 50%; }
  
  /* Subtype List Styles */
  .subtype-header-row { display: flex; align-items: center; gap: 1rem; margin-bottom: 0.25rem; font-size: 0.75rem; color: #6b7280; font-weight: 600; text-transform: uppercase; }
  .subtype-label-header { width: 80px; text-align: right; }
  .subtype-qty-header { width: 60px; text-align: center; }
  .subtype-img-header { padding-left: 0.5rem; }
  
  .subtype-list { display: flex; flex-direction: column; gap: 0.5rem; }
  .subtype-row { display: flex; align-items: center; gap: 1rem; padding: 0.25rem 0; }
  .subtype-label { font-size: 0.875rem; font-weight: 500; color: #374151; width: 80px; text-align: right; }
  .subtype-qty-input { width: 60px; padding: 0.25rem; border: 1px solid #d1d5db; border-radius: 4px; text-align: center; }
  .subtype-thumb-btn { width: 64px; height: 64px; border: 1px solid #e5e7eb; border-radius: 4px; overflow: hidden; cursor: pointer; padding: 0; background: white; opacity: 0.8; transition: all 0.2s; }
  .subtype-thumb-btn:hover { opacity: 1; border-color: #9ca3af; }
  .subtype-thumb-btn.selected { opacity: 1; border-color: #3b82f6; box-shadow: 0 0 0 2px #3b82f6; }
  .subtype-placeholder { width: 64px; height: 64px; background: #f3f4f6; border: 1px dashed #d1d5db; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; color: #9ca3af; text-align: center; padding: 4px; }
  .subtype-thumb-wrapper { position: relative; width: 64px; height: 64px; }
  .subtype-overlay { position: absolute; top: 0; right: 0; display: flex; gap: 1px; opacity: 0; transition: opacity 0.2s; background: rgba(0,0,0,0.6); padding: 2px; border-bottom-left-radius: 4px; }
  .subtype-thumb-wrapper:hover .subtype-overlay { opacity: 1; }

  /* Validation Styles */
  .listing-price-container.invalid {
      border-color: #fca5a5; /* Red-300 */
      background: #fef2f2; /* Red-50 */
      color: #dc2626; /* Red-600 */
  }
  .listing-price-container.invalid:after {
      content: "Price required";
      display: block;
      font-size: 0.65rem;
      color: #dc2626;
      font-weight: 600;
      text-transform: uppercase;
      margin-top: 2px;
  }
  
  .btn-buy-shop:disabled {
      background: #9ca3af; /* Gray-400 */
      cursor: not-allowed;
      opacity: 0.7;
  }
  .btn-buy-shop:disabled:hover {
      background: #9ca3af;
  }
  
  .add-btn { display: flex; align-items: center; justify-content: center; background: #f9fafb; border: 1px dashed #d1d5db; color: #9ca3af; transition: all 0.2s; }
  .add-btn:hover { border-color: #3b82f6; color: #3b82f6; background: #eff6ff; }
  .plus-icon { font-size: 2rem; font-weight: 300; line-height: 1; }

  .category-add-btn {
      background: none;
      border: none;
      border-left: 1px solid #d1d5db;
      padding: 0 0.75rem;
      font-size: 1.25rem;
      color: #6b7280;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
  }
  .category-add-btn:hover {
      background: #f3f4f6;
      color: #111827;
  }
</style>

<CategoryBrowseModal 
    bind:isOpen={showCategoryBrowser}
    currentCategory={listing?.productCategory}
    on:select={(e) => selectCategory(e.detail)}
/>
