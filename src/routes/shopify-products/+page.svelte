<script lang="ts">
  import { onMount, tick } from "svelte";
  import { browser } from "$app/environment";
  import { goto } from "$app/navigation";
  import { slide } from "svelte/transition";
  import { generateHandle, generateSku } from "$lib/handle-utils";
  import { store } from "$lib/store";
  import { broadcast } from "$lib/redux-firestore";
  import { firestore } from "$lib/firebase";
  import { user } from "$lib/user-store";
  import { update_field, type Item } from "$lib/inventory";
  import { update_listing, type Listing, type ListingImage } from "$lib/listings-slice";
  import { history_add } from "$lib/history";
  import Papa from "papaparse";
  import { fade } from "svelte/transition";
  import ImageThumbnail from "$lib/components/ImageThumbnail.svelte";
  import BulkEditor, { type ColumnConfig } from "$lib/components/BulkEditor.svelte";
  import ViewCell from "$lib/components/cell-renderers/ViewCell.svelte";
  import { set_column_width } from "$lib/ui-slice";


  // --- Derived Data ---
  let searchQuery = "";
  
  // Sort State
  type SortDir = 'asc' | 'desc';
  interface SortRule {
      field: string;
      dir: SortDir;
  }
  const sortStorageKey = "bulk-editor-sort-shopify";
  let sortHistory: SortRule[] = []; // [primary, secondary, tertiary...]
  
  onMount(() => {
      if (!browser) return;
      const raw = localStorage.getItem(sortStorageKey);
      if (raw) {
          try {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) {
                  sortHistory = parsed.filter((r) => r && r.field && (r.dir === 'asc' || r.dir === 'desc'));
              }
          } catch {
              localStorage.removeItem(sortStorageKey);
          }
      }
  });

  $: if (browser) {
      localStorage.setItem(sortStorageKey, JSON.stringify(sortHistory));
  }

  function handleSort(e: CustomEvent<{ field: string }>) {
      const field = e.detail.field;
      const existingIndex = sortHistory.findIndex(r => r.field === field);
      const current = existingIndex === -1 ? null : sortHistory[existingIndex];

      if (!current) {
          sortHistory = [{ field, dir: 'asc' }, ...sortHistory];
          return;
      }

      if (existingIndex === 0) {
          if (current.dir === 'asc') {
              sortHistory = [{ field, dir: 'desc' }, ...sortHistory.slice(1)];
          } else {
              sortHistory = sortHistory.slice(1);
          }
          return;
      }

      const cleanHistory = sortHistory.filter(r => r.field !== field);
      sortHistory = [{ field, dir: current.dir }, ...cleanHistory];
  }

  // Flatten inventory with Listing Overlay
  $: inventoryItems = (Object.entries($store.inventory.idToItem) as [string, Item][]).map(([key, item]) => {
      // Robust lookup: Check if listing slice knows the handle for this item ID (key)
      // Fallback to generation if not found (e.g. not initialized or sync issue)
      const knownHandle = $store.listings.idToHandle?.[key];
      const computedHandle = knownHandle || (item.handle || generateHandle(item.description || "Untitled", item.janCode));
      
      const listing = $store.listings.handleToListing[computedHandle];
      
      // Find matching image in listing to get position/alt
      let imagePosition: number | undefined = undefined;
      let imageAltText: string | undefined = undefined;
      
      if (listing && item.image) {
          const matchingImg = listing.images.find((img: ListingImage) => img.url === item.image);
          if (matchingImg) {
              imagePosition = matchingImg.position;
              imageAltText = matchingImg.altText;
          }
      }

      return {
        id: key,
        ...item,
        computedHandle,
        // Overlay Listing Data if available
        description: listing ? listing.title : item.description,
        bodyHtml: listing ? listing.bodyHtml : "",
        productCategory: listing ? listing.productCategory : "",
        // Derived Image Data
        imagePosition,
        imageAltText,
        
        // Helper to know if we are in "Listing Mode" for this item
        hasListing: !!listing
      };
  });

  // Sort/Filter
  $: visibleItems = inventoryItems
    .filter(i => {
        if (!searchQuery) return true;
        const q = searchQuery.toLowerCase();
        return (
            i.janCode.toLowerCase().includes(q) ||
            i.description.toLowerCase().includes(q) ||
            (i.handle || "").toLowerCase().includes(q)
        );
    })
    .map((item, index) => ({ ...item, __index: index }))
    .sort((a, b) => {
        if (sortHistory.length === 0) {
            return a.__index - b.__index;
        }
        // Multi-column stable sort
        for (const rule of sortHistory) {
            const field = rule.field;
            let valA, valB;
            
            // Map generic field names to item properties
            if (field === 'handle') {
                 valA = a.handle || a.computedHandle;
                 valB = b.handle || b.computedHandle;
            } else if (field === 'description') {
                 valA = a.description || "";
                 valB = b.description || "";
            } else if (field === 'bodyHtml') {
                valA = a.bodyHtml || "";
                valB = b.bodyHtml || "";
            } else if (field === 'productCategory') {
                valA = a.productCategory || "";
                valB = b.productCategory || "";
            } else if (field === 'subtype') {
                valA = a.subtype;
                valB = b.subtype;
            } else if (field === 'id') {
                valA = a.id;
                valB = b.id;
            } else if (field === 'weight') {
                valA = a.weight || 0;
                valB = b.weight || 0;
            } else if (field === 'countryOfOrigin') {
                valA = a.countryOfOrigin || "";
                valB = b.countryOfOrigin || "";
            } else if (field === 'qty') {
                valA = a.qty;
                valB = b.qty;
            } else if (field === 'price') {
                valA = a.price || 0;
                valB = b.price || 0;
            } else if (field === 'janCode') {
                valA = a.janCode;
                valB = b.janCode;
            } else if (field === 'image') {
                valA = a.image || "";
                valB = b.image || "";
            } else if (field === 'imagePosition') {
                valA = a.imagePosition || 0;
                valB = b.imagePosition || 0;
            } else if (field === 'imageAltText') {
                valA = a.imageAltText || "";
                valB = b.imageAltText || "";
            } else {
                continue; 
            }
            
            if ((valA ?? "") < (valB ?? "")) return rule.dir === 'asc' ? -1 : 1;
            if ((valA ?? "") > (valB ?? "")) return rule.dir === 'asc' ? 1 : -1;
            // If equal, continue to next rule
        }
        
        // Final tie-breaker: ID/JanCode to ensure stability
        return a.__index - b.__index;
    });

  // --- Actions ---

  function commitEdit(id: string, field: string, value: any, index: number) {
      if (!$user || !$user.uid) return;
      
      // Index in BulkEditor corresponds to index in visibleItems
      const item = visibleItems[index]; 
      
      const handle = item.computedHandle;
      const listing = $store.listings.handleToListing[handle];
      
      // Listing Fields
      if (['description', 'bodyHtml', 'productCategory'].includes(field)) {
          if (listing) {
              const changes: Partial<Listing> = {};
              if (field === 'description') changes.title = value;
              else if (field === 'bodyHtml') changes.bodyHtml = value;
              else if (field === 'productCategory') changes.productCategory = value;
              
              broadcast(firestore, $user.uid, update_listing({ handle, changes }));
          } else {
              console.warn(`Attempted to edit listing field ${field} for ${handle} but no listing exists.`);
          }
      } else if (['imageAltText', 'imagePosition'].includes(field)) {
          if (listing && item.image) {
             const newImages = (listing.images || []).map((img: ListingImage) => {
                 if (img.url === item.image) {
                     return { 
                         ...img, 
                         altText: field === 'imageAltText' ? value : img.altText,
                         position: field === 'imagePosition' ? Number(value) : img.position
                     };
                 }
                 return img;
             });
             broadcast(firestore, $user.uid, update_listing({ handle, changes: { images: newImages } }));
          }
      } else {
          // Item Field
          const validItemFields = ['janCode', 'subtype', 'price', 'weight', 'image', 'countryOfOrigin', 'qty', 'shipped'];
          if (validItemFields.includes(field)) {
             // @ts-ignore
             const fromVal = item[field];
             broadcast(firestore, $user.uid, update_field({
                 id: item.id,
                 field: field as keyof Item,
                 from: fromVal,
                 to: value
             }));
         } else if (field === 'handle') {
             const fromVal = item.computedHandle || "";
             broadcast(firestore, $user.uid, update_field({
                 id: item.id,
                 field: 'handle',
                 from: fromVal,
                 to: value
             }));
          }
      }
  }

  function handleBulkCommit(e: CustomEvent<{ id: string; field: string; value: any; index: number }>) {
      commitEdit(e.detail.id, e.detail.field, e.detail.value, e.detail.index);
  }
  
  function handleResize(e: CustomEvent<{ field: string; width: number }>) {
      if ($user && $user.uid) {
          broadcast(firestore, $user.uid, set_column_width({ view: 'shopify', field: e.detail.field, width: e.detail.width }));
      } else {
          store.dispatch(set_column_width({ view: 'shopify', field: e.detail.field, width: e.detail.width }));
      }
  }

  // --- Column Config ---
  const baseColumnConfig: ColumnConfig[] = [
      { field: 'view', header: 'View', width: 50, editable: false, type: 'component', component: ViewCell },
      
      { field: 'handle', header: 'Handle', width: 200, type: 'text', placeholderField: 'computedHandle' },
      { field: 'description', header: 'Title', width: 300, type: 'text' }, 
      { field: 'bodyHtml', header: 'Body (HTML)', width: 300, type: 'text' },
      { field: 'productCategory', header: 'Product Category', width: 150, type: 'text' },
      { field: 'subtype', header: 'Option1 Value', width: 100, editable: false },
  
      { field: 'id', header: 'Variant SKU', width: 150, editable: false },
      { field: 'weight', header: 'Variant Grams', width: 80, type: 'number', align: 'right' },
      { field: 'countryOfOrigin', header: 'Country of Origin', width: 120, type: 'text' },
      { field: 'qty', header: 'Variant Inventory Qty', width: 80, type: 'number', align: 'right' },
      { field: 'price', header: 'Variant Price', width: 80, type: 'number', align: 'right' },
      { field: 'janCode', header: 'Variant Barcode', width: 120, editable: false },
      { field: 'image', header: 'Image Src', width: 80, type: 'text' },
      { field: 'imagePosition', header: 'Image Position', width: 80, type: 'number', align: 'right' },
      { field: 'imageAltText', header: 'Image Alt Text', width: 200, type: 'text' },
  ];
  
  $: columnConfig = baseColumnConfig.map(c => {
      const w = $store.ui?.columnWidths?.[`shopify_${c.field}`];
      return w ? { ...c, width: w } : c;
  });

  function downloadCSV() {
      // 1. Group by Handle
      const rowsByHandle: Record<string, typeof visibleItems> = {};
      
      visibleItems.forEach(item => {
          const h = item.computedHandle || item.handle || "MISSING-HANDLE";
          if (!rowsByHandle[h]) rowsByHandle[h] = [];
          rowsByHandle[h].push(item);
      });

      const exportRows: any[] = [];

      // 2. Process each Group
      Object.entries(rowsByHandle).forEach(([handle, variants]) => {
          const listing = $store.listings.handleToListing[handle];
          const option1Name = listing ? listing.option1Name : "Subtype";
          
          const rawGallery = listing && listing.images ? [...listing.images] : [];
          
          const orderedGallery: any[] = new Array(variants.length).fill(null);
          const usedGalleryIndices = new Set<number>();
          
          variants.forEach((v, idx) => {
              if (v.image) {
                  const matchIdx = rawGallery.findIndex((img, i) => img.url === v.image && !usedGalleryIndices.has(i));
                  if (matchIdx !== -1) {
                      orderedGallery[idx] = rawGallery[matchIdx];
                      usedGalleryIndices.add(matchIdx);
                  }
              }
          });
          
          const remainingImages = rawGallery.filter((_, i) => !usedGalleryIndices.has(i));
          
          let remainIdx = 0;
          for (let i = 0; i < orderedGallery.length; i++) {
              if (!orderedGallery[i] && remainIdx < remainingImages.length) {
                   orderedGallery[i] = remainingImages[remainIdx++];
              }
          }
          
          while (remainIdx < remainingImages.length) {
              orderedGallery.push(remainingImages[remainIdx++]);
          }
          
          const galleryImages = orderedGallery;
          const maxRows = Math.max(variants.length, galleryImages.length);
          
          for (let i = 0; i < maxRows; i++) {
              const variant = variants[i]; 
              const galleryImg = galleryImages[i]; 
              
              let exportRow: any = {};
              
              exportRow['Handle'] = handle;
              
              if (i === 0) {
                  const leader = variant || variants[0]; 
                  exportRow['Title'] = listing ? listing.title : (leader ? leader.description : "");
                  exportRow['Body (HTML)'] = listing ? listing.bodyHtml : "";
                  exportRow['Vendor'] = "SPNSS Ltd.";
                  exportRow['Product Category'] = listing ? listing.productCategory : "";
                  exportRow['Published'] = "true";
                  exportRow['Option1 Name'] = option1Name;
              }
              
              if (variant) {
                  exportRow['Option1 Value'] = variant.subtype || "Default";
                  exportRow['Variant SKU'] = generateSku(variant.janCode, variant.subtype);
                  exportRow['Variant Grams'] = variant.weight || 0;
                  exportRow['Variant Inventory Tracker'] = "shopify";
                  exportRow['Variant Inventory Qty'] = variant.qty;
                  exportRow['Variant Inventory Policy'] = "deny";
                  exportRow['Variant Fulfillment Service'] = "manual";
                  exportRow['Variant Price'] = variant.price || 0;
                  exportRow['Variant Requires Shipping'] = "true";
                  exportRow['Variant Taxable'] = "true";
                  exportRow['Variant Barcode'] = variant.janCode;
                  exportRow['Variant Weight Unit'] = "g";
                  exportRow['Variant Image'] = variant.image || "";
                  exportRow['Status'] = "active"; 
              }
              
              if (galleryImg) {
                  exportRow['Image Src'] = galleryImg.url;
                  exportRow['Image Position'] = galleryImg.position || (i + 1);
                  exportRow['Image Alt Text'] = galleryImg.altText || "";
              }
              
              exportRows.push(exportRow);
          }
      });
      
      const csv = Papa.unparse(exportRows, {
          columns: [
              "Handle", "Title", "Body (HTML)", "Vendor", "Product Category", "Type", "Tags", "Published", 
              "Option1 Name", "Option1 Value", "Option2 Name", "Option2 Value", "Option3 Name", "Option3 Value",
              "Variant SKU", "Variant Grams", "Variant Inventory Tracker", "Variant Inventory Qty", "Variant Inventory Policy", 
              "Variant Fulfillment Service", "Variant Price", "Variant Compare At Price", "Variant Requires Shipping", 
              "Variant Taxable", "Variant Barcode", "Image Src", "Image Position", "Image Alt Text", "Gift Card", 
              "SEO Title", "SEO Description", "Google Shopping / Google Product Category", "Google Shopping / Gender", 
              "Google Shopping / Age Group", "Google Shopping / MPN", "Google Shopping / AdWords Grouping", 
              "Google Shopping / AdWords Labels", "Google Shopping / Condition", "Google Shopping / Custom Product", 
              "Google Shopping / Custom Label 0", "Google Shopping / Custom Label 1", "Google Shopping / Custom Label 2", 
              "Google Shopping / Custom Label 3", "Google Shopping / Custom Label 4", "Variant Image", "Variant Weight Unit", 
              "Variant Tax Code", "Cost per item", "Status"
          ] 
      });
      
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.setAttribute('hidden', '');
      a.setAttribute('href', url);
      a.setAttribute('download', 'shopify_products.csv');
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
  }

</script>

<div class="page">
    <div class="toolbar">
        <h1>Shopify Bulk Editor</h1>
        <div class="actions">
            <input type="text" placeholder="Search..." bind:value={searchQuery} class="search-box"/>
            <button class="btn-primary" on:click={downloadCSV}>Export CSV</button>
        </div>
    </div>
    
    <div class="editor-container">
         <BulkEditor 
            data={visibleItems}
            columns={columnConfig}
            keyField="id"
            bind:sortHistory={sortHistory}
            on:sort={handleSort}
            on:commit={handleBulkCommit}
            on:resize={handleResize}
         />
    </div>
</div>

<style>
    .page {
        display: flex;
        flex-direction: column;
        height: 100vh;
        background: white;
        padding-left: 1.5rem; 
        padding-right: 1.5rem;
        font-size: 0.875rem; /* text-sm */
    }
    .editor-container {
        height: calc(100vh - 60px);
        margin-left: -1.5rem;
        margin-right: -1.5rem;
    }
    .toolbar {
        padding: 1rem 0;
        border-bottom: 1px solid #ccc;
        display: flex;
        justify-content: space-between;
        align-items: center;
        background: white;
        flex-shrink: 0;
    }
    .actions {
        display: flex;
        gap: 1rem;
    }
    .search-box {
        padding: 0.5rem;
        border: 1px solid #ddd;
        border-radius: 4px;
        min-width: 300px;
    }
</style>
