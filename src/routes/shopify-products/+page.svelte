<script lang="ts">
  import { store } from "$lib/store";
  import type { Item } from "$lib/inventory";
  import { generateShopifyCSV, mapItemToProduct, type ShopifyProduct } from "$lib/shopify-export";
  import { onMount } from "svelte";

  // We want to work with a flattened structure where we can edit "Handle", "Title", "Body" 
  // which might be shared across multiple rows (if they have same handle), 
  // but for simplicity, let's just keep a list of "Row" objects that mirror the CSV structure + ref to original Item.
  
  interface Row {
    id: string; // Internal ID for keying
    item: Item;
    
    // Editable fields
    handle: string;
    title: string;
    body: string;
    price: number;
    weight: number;
    category: string;
    
    selected: boolean;
  }

  let rows: Row[] = [];
  let filter = "";
  
  // Computed from store
  $: {
    if ($store.inventory.initialized && rows.length === 0) {
      // Initialize rows from inventory
      // This happens once. 
      // TODO: If we want to persist work, we need a place to save this state. 
      // For now, we generate defaults.
      
      const inv = $store.inventory.idToItem;
      const newRows: Row[] = [];
      for (const key in inv) {
        const item = inv[key];
        // Heuristic for Handle: Title + JAN
        // But Title is description which might be messy. 
        // Let's default Handle to JanCode for now, user can group them.
        const handle = item.janCode; 
        
        newRows.push({
          id: key,
          item,
          handle,
          title: item.description,
          body: "",
          price: item.price || 0,
          weight: item.weight || 0,
          category: "",
          selected: false
        });
      }
       // Sort by creationDate desc
      newRows.sort((a, b) => b.item.creationDate.localeCompare(a.item.creationDate));
      rows = newRows;
    }
  }

  // selection logic
  let lastSelectedUserIndex = -1;
  
  function handleSelect(index: number, event: MouseEvent) {
    if (event.shiftKey && lastSelectedUserIndex !== -1) {
        const start = Math.min(lastSelectedUserIndex, index);
        const end = Math.max(lastSelectedUserIndex, index);
        for (let i = start; i <= end; i++) {
            rows[i].selected = true;
        }
    } else {
        lastSelectedUserIndex = index;
    }
  }

  // Bulk actions
  let bulkHandle = "";
  let bulkTitle = "";
  let bulkBody = "";
  let bulkPrice = "";
  let bulkWeight = "";
  let bulkCategory = "";

  function applyBulk() {
    rows = rows.map(r => {
      if (!r.selected) return r;
      return {
        ...r,
        handle: bulkHandle || r.handle,
        title: bulkTitle || r.title,
        body: bulkBody || r.body,
        price: bulkPrice ? parseFloat(bulkPrice) : r.price,
        weight: bulkWeight ? parseFloat(bulkWeight) : r.weight,
        category: bulkCategory || r.category
      };
    });
  }

  function downloadCSV() {
    const selectedRows = rows.filter(r => r.selected);
    if (selectedRows.length === 0) {
      alert("No rows selected");
      return;
    }
    
    // Sort buy Handle so variants are together
    selectedRows.sort((a, b) => a.handle.localeCompare(b.handle));

    const products: ShopifyProduct[] = selectedRows.map((r, i) => {
      // Calculate Image Position? 
      // If we sort by handle, we can track index within handle.
      let pos = 1; 
      if (i > 0 && selectedRows[i-1].handle === r.handle) {
         // This logic is flawed if we map map independently. 
         // We need to look at the whole set.
      }
      
      return mapItemToProduct(
        { ...r.item, price: r.price, weight: r.weight }, // Use edited price/weight
        r.handle,
        r.title,
        r.body,
        1 // Position placeholder
      );
    });
    
    // Fix positions
    const handleCounts: {[key: string]: number} = {};
    products.forEach(p => {
        handleCounts[p.Handle] = (handleCounts[p.Handle] || 0) + 1;
        p["Image Position"] = handleCounts[p.Handle];
        if (p["Product Category"] === "") p["Product Category"] = "Home & Garden"; // Default?
    });

    const csvObj = generateShopifyCSV(products);
    
    // Download
    const blob = new Blob([csvObj], { type: 'text/csv' });
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

<div class="container">
  <h1>Shopify Product Export</h1>
  
  <div class="controls">
    <div class="bulk-edit">
        <h3>Bulk Edit Selected</h3>
        <input placeholder="Handle (for grouping)" bind:value={bulkHandle} />
        <input placeholder="Title" bind:value={bulkTitle} />
        <input placeholder="Price" bind:value={bulkPrice} />
        <input placeholder="Weight" bind:value={bulkWeight} />
        <button on:click={applyBulk}>Apply</button>
    </div>
    
    <div class="actions">
        <span>{rows.filter(r => r.selected).length} selected</span>
        <button class="primary" on:click={downloadCSV}>Download Shopify CSV</button>
    </div>
  </div>

  <div class="table-wrap">
  <table>
    <thead>
        <tr>
            <th><input type="checkbox" 
                on:change={(e) => {
                    const checked = e.currentTarget.checked;
                    rows = rows.map(r => ({...r, selected: checked}));
                }}
            ></th>
            <th>Type</th>
            <th>Img</th>
            <th>Handle</th>
            <th>Title</th>
            <th>Subtype</th>
            <th>Price</th>
            <th>Weight</th>
            <th>Stock</th>
        </tr>
    </thead>
    <tbody>
        {#each rows as row, i (row.id)}
            <tr class:selected={row.selected} on:click={(e) => handleSelect(i, e)}>
                <td><input type="checkbox" bind:checked={row.selected} on:click|stopPropagation></td>
                <td>{row.item.subtype}</td>
                <td>
                    {#if row.item.image}
                        <img src={row.item.image} class="thumb" alt="thumb"/>
                    {:else}
                        <div class="no-img"></div>
                    {/if}
                </td>
                <td><input bind:value={row.handle} class="w-full" on:click|stopPropagation></td>
                <td><input bind:value={row.title} class="w-full" on:click|stopPropagation></td>
                <td>{row.item.subtype}</td>
                <td><input bind:value={row.price} class="w-short" on:click|stopPropagation></td>
                <td><input bind:value={row.weight} class="w-short" on:click|stopPropagation></td>
                <td>{row.item.qty}</td>
            </tr>
        {:else}
            <tr><td colspan="9">Loading...</td></tr>
        {/each}
    </tbody>
  </table>
  </div>
</div>

<style>
.container {
    display: flex;
    flex-direction: column;
    height: 100vh;
    padding: 1rem;
}
.controls {
    display: flex;
    justify-content: space-between;
    margin-bottom: 1rem;
    padding: 1rem;
    background: #f9fafb;
    border-bottom: 1px solid #e5e7eb;
}
.bulk-edit {
    display: flex;
    gap: 0.5rem;
    align-items: center;
}
.table-wrap {
    flex: 1;
    overflow-y: auto;
}
table {
    width: 100%;
    border-collapse: collapse;
}
th, td {
    border: 1px solid #e5e7eb;
    padding: 0.5rem;
    text-align: left;
}
tr.selected {
    background: #eff6ff;
}
.thumb {
    width: 40px;
    height: 40px;
    object-fit: cover;
}
.no-img {
    width: 40px;
    height: 40px;
    background: #eee;
}
.w-full {
    width: 100%;
    border: 1px solid transparent;
    background: transparent;
}
.w-full:focus {
    border-color: #3b82f6;
    background: white;
}
.w-short {
    width: 60px;
}
button.primary {
    background: #16a34a;
    color: white;
    padding: 0.5rem 1rem;
    border-radius: 4px;
    font-weight: bold;
    border: none;
    cursor: pointer;
}
</style>
