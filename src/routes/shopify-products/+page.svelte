<script lang="ts">
  import { store } from "$lib/store";
  import { broadcast } from "$lib/redux-firestore";
  import { firestore } from "$lib/firebase";
  import { user } from "$lib/user-store";
  import { update_item, update_field, type Item } from "$lib/inventory";
  import { generateShopifyCSV, mapItemToProduct } from "$lib/shopify-export";
  import { fade } from "svelte/transition";
  import ImageThumbnail from "$lib/components/ImageThumbnail.svelte";

  // --- Derived Data ---
  let searchQuery = "";
  
  // Sort State
  type SortDir = 'asc' | 'desc';
  interface SortRule {
      field: string;
      dir: SortDir;
  }
  let sortHistory: SortRule[] = []; // [primary, secondary, tertiary...]

  function handleHeaderClick(field: string) {
      // Logic: 
      // 1. If clicking primary sort, toggle direction.
      // 2. If clicking other, move to front (become primary), default asc.
      
      const existingIndex = sortHistory.findIndex(r => r.field === field);
      let newRule: SortRule = { field, dir: 'asc' };
      
      if (existingIndex === 0) {
          // Toggle
          newRule.dir = sortHistory[0].dir === 'asc' ? 'desc' : 'asc';
          // Replace first
          sortHistory = [newRule, ...sortHistory.slice(1)];
      } else {
          // Remove existing instance if present
          const cleanHistory = sortHistory.filter(r => r.field !== field);
          // Add to front
          sortHistory = [newRule, ...cleanHistory];
      }
  }

  // Flatten inventory
  $: inventoryItems = (Object.entries($store.inventory.idToItem) as [string, Item][]).map(([key, item]) => ({
    id: key,
    ...item,
    // Default handle logic: title-words-first-then-jan-code
    computedHandle: item.handle || generateHandle(item.description || "Untitled", item.janCode)
  }));

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
    .sort((a, b) => {
        // Multi-column stable sort
        for (const rule of sortHistory) {
            const field = rule.field;
            let valA, valB;
            
            // Map generic field names to item properties
            if (field === 'handle') {
                 valA = a.handle || a.computedHandle;
                 valB = b.handle || b.computedHandle;
            } else if (field === 'title') {
                 valA = a.description;
                 valB = b.description;
            } else if (field === 'body') {
                valA = a.bodyHtml || "";
                valB = b.bodyHtml || "";
            } else if (field === 'category') {
                valA = a.productCategory || "";
                valB = b.productCategory || "";
            } else if (field === 'subtype') {
                valA = a.subtype;
                valB = b.subtype;
            } else if (field === 'sku') {
                valA = a.id;
                valB = b.id;
            } else if (field === 'weight') {
                valA = a.weight || 0;
                valB = b.weight || 0;
            } else if (field === 'stock') {
                valA = a.qty;
                valB = b.qty;
            } else if (field === 'price') {
                valA = a.price || 0;
                valB = b.price || 0;
            } else if (field === 'barcode') {
                valA = a.janCode;
                valB = b.janCode;
            } else if (field === 'imgPos') {
                valA = a.imagePosition || 0;
                valB = b.imagePosition || 0;
            } else if (field === 'imgAlt') {
                valA = a.imageAltText || "";
                valB = b.imageAltText || "";
            } else {
                continue; 
            }
            
            if (valA < valB) return rule.dir === 'asc' ? -1 : 1;
            if (valA > valB) return rule.dir === 'asc' ? 1 : -1;
            // If equal, continue to next rule
        }
        
        // Final tie-breaker: ID/JanCode to ensure stability
        return a.id.localeCompare(b.id);
    });

  function generateHandle(title: string, jan: string): string {
    const slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, ""); // Trim dashes
    return `${slug}-${jan}`;
  }

  // --- Interaction State ---
  // Selection is [start_row, end_row] for a specific column
  let selectionColumn: string | null = null;
  let selectionStart: number = -1;
  let selectionEnd: number = -1;
  let focusedRowIndex: number = -1;

  // --- Actions ---

  function commitEdit(id: string, field: keyof Item, value: any, index: number) {
      if (!$user || !$user.uid) return;
      
      broadcast(firestore, $user.uid, update_field({
          id,
          field,
          from: undefined, 
          to: value
      }));
  }

  // Handle cell interaction
  function handleCellMouseDown(index: number, field: string, e: MouseEvent) {
      // Focus will trigger independently. We need to handle selection.
     if (e.shiftKey) {
         e.preventDefault(); // Prevent native text selection
         
         if (selectionColumn === field && selectionStart !== -1) {
             // Extend existing selection
             selectionEnd = index;
         } else if (focusedRowIndex !== -1) {
             // Start new selection from the currently focused row to this clicked row
             // But we need to ensure we are in the same column?
             // Actually, usually you can't select across columns in this simple model.
             // So we should switch selectionColumn to THIS field, and use focusedRowIndex as anchor.
             
             // Wait, if focusedRowIndex was in a different column, we have a problem.
             // Anchor logic:
             // If we have an anchor row, use it.
             // If not (e.g. first click), use index.
             
             // Better logic:
             // If we have an active selection in this column, extend it.
             // If not, try to start one from the last focused row IF it was in this column?
             // Or just treat this click as the end, and the last focus as start?
             
             // Simpler:
             // If we are shift-clicking, we assume the user focused a cell (anchor) and is now shift-clicking another.
             // We need to know the anchor column.
             // Let's use `anchorCol` and `anchorRow` set in `handleFocus`.
             
             if (anchorCol === field && anchorRow !== -1) {
                 selectionColumn = field;
                 selectionStart = Math.min(anchorRow, index);
                 selectionEnd = Math.max(anchorRow, index);
             }
         }
     } else {
         // Normal click. The INPUT will receive focus and trigger handleFocus.
         // But we should clear selection here to be responsive?
         // If we don't preventdefault, the input gets focus.
         if (selectionColumn) {
             selectionColumn = null;
             selectionStart = -1;
             selectionEnd = -1;
         }
         // anchorRow/Col will be updated by handleFocus shortly.
     }
  }

  let anchorRow: number = -1;
  let anchorCol: string = "";

  function handleFocus(index: number, field: string) {
      focusedRowIndex = index;
      
      // Update anchor only when starting a new selection flow (not extending)
      if (selectionColumn === null) {
          anchorRow = index;
          anchorCol = field;
      }

      // If we move focus outside current selection column, clear selection?
      if (selectionColumn && selectionColumn !== field) {
          selectionColumn = null;
          selectionStart = -1;
          selectionEnd = -1;
          anchorRow = index;
          anchorCol = field;
      }
  }
  
  function handleInputKey(e: KeyboardEvent, index: number, field: string, value: any, item: any) {
      if (e.key === "Enter") {
           if (selectionColumn === field && selectionStart !== -1 && selectionStart !== selectionEnd) {
              // Fill Selection
              fillSelection(value);
              e.preventDefault();
           } else {
              // Just blur to finish edit
              (e.target as HTMLElement).blur();
              // Prevent default enter behavior (newline in textarea? usually form submit in input)
              e.preventDefault(); 
           }
      } else if (e.key === "Escape") {
          selectionColumn = null;
          selectionStart = -1;
          selectionEnd = -1;
      } else if (e.key === "ArrowRight" && field === "handle") {
          // Auto-complete handle
          if (item.computedHandle && !item.handle) {
               if (!$user || !$user.uid) return;
               commitEdit(item.id, 'handle', item.computedHandle, index);
               e.preventDefault();
          }
      } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.shiftKey) {
          // Smart JAN Selection
          e.preventDefault();
          
          if (!selectionColumn) {
              selectionColumn = field;
              selectionStart = index;
              selectionEnd = index;
              anchorRow = index;
          }

          const currentJan = visibleItems[index].janCode;
          const direction = e.key === "ArrowDown" ? 1 : -1;
          
          // We want to select all SAME JAN items in that direction.
          // Logic: Look ahead from the *current* selection edge (or cursor position)
          // Actually, user standard expectation: Shift-Arrow moves selection by one unit.
          // User REQUEST: "automatically select all the rows with the same JAN code"
          
          // Implementation:
          // 1. Identify valid range of same JANs.
          // 2. Expand selection to cover that range.
          
          let scanIndex = index + direction;
          while (scanIndex >= 0 && scanIndex < visibleItems.length) {
              if (visibleItems[scanIndex].janCode === currentJan) {
                  // It matches, include it
                  scanIndex += direction;
              } else {
                  // Stop
                  break;
              }
          }
          // Back up one step (scanIndex is now on a non-match or out of bounds)
          const limitIndex = scanIndex - direction;
          
          // Updates selection
          // If we are moving down (direction 1), we want to extend End to limitIndex (max).
          // If we are moving up (direction -1), we want to extend Start to limitIndex (min).
          // BUT we have to respect the anchor.
          
          // Let's assume user is on a row, shift-downs.
          // We find the block of same-JAN rows below. Select them all.
          
          selectionEnd = Math.max(selectionEnd, limitIndex);
          selectionStart = Math.min(selectionStart, limitIndex);
          
          // Ensure we capture the current row too if it wasn't already (it should be)
          selectionEnd = Math.max(selectionEnd, index);
          selectionStart = Math.min(selectionStart, index);
      }
  }
  


  function fillSelection(sourceValue: any) {
      if (!$user || !$user.uid || !selectionColumn || selectionStart === -1) return;
      
      for (let i = selectionStart; i <= selectionEnd; i++) {
          const item = visibleItems[i];
          broadcast(firestore, $user.uid, update_field({
              id: item.id,
              field: selectionColumn as keyof Item,
              from: undefined,
              to: sourceValue
          }));
      }
      
      selectionColumn = null;
      selectionStart = -1;
      selectionEnd = -1;
  }
  
  // --- Resizable Columns ---
  let columnWidths: Record<string, number> = {
      handle: 200,
      title: 300,
      body: 300,
      category: 150,
      subtype: 100,
      sku: 150,
      weight: 80,
      stock: 80,
      price: 80,
      barcode: 120,
      image: 80,
      imgPos: 80,
      imgAlt: 200,
      varImg: 80
  };
  
  let resizingColumn: string | null = null;
  let startX = 0;
  let startWidth = 0;

  function handleResizeStart(e: MouseEvent, col: string) {
      resizingColumn = col;
      startX = e.clientX;
      const th = (e.target as HTMLElement).closest('th');
      startWidth = th ? th.clientWidth : 100;
      window.addEventListener('mousemove', handleResizeMove);
      window.addEventListener('mouseup', handleResizeEnd);
      e.preventDefault();
  }
  
  function handleResizeMove(e: MouseEvent) {
      if (!resizingColumn) return;
      const diff = e.clientX - startX;
      columnWidths[resizingColumn] = Math.max(50, startWidth + diff);
  }
  
  function handleResizeEnd() {
      resizingColumn = null;
      window.removeEventListener('mousemove', handleResizeMove);
      window.removeEventListener('mouseup', handleResizeEnd);
  }

  function downloadCSV() {
      const products = visibleItems.map((item, i) => {
         // Use computed handle if real handle is missing
         const effectiveItem = {
             ...item,
             handle: item.handle || item.computedHandle
         };
         return mapItemToProduct(effectiveItem, item.imagePosition || (i + 1)); // Heuristic for fallback pos
      });
      
      const csv = generateShopifyCSV(products);
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

<div class="page text-sm">
    <div class="toolbar">
        <h1>Shopify Bulk Editor</h1>
        <div class="actions">
            <input type="text" placeholder="Search..." bind:value={searchQuery} class="search-box"/>
            <button class="btn-primary" on:click={downloadCSV}>Export CSV</button>
        </div>
    </div>
    
    <div class="grid-container">
        <table>
            <thead>
                <tr>
                    <!-- 1. Handle -->
                    <th style="width: {columnWidths.handle}px" on:click={() => handleHeaderClick('handle')}>
                        Handle {sortHistory[0]?.field === 'handle' ? (sortHistory[0].dir === 'asc' ? '↑' : '↓') : ''}
                        <div class="resize-handle" on:mousedown={(e) => handleResizeStart(e, 'handle')} on:click|stopPropagation></div>
                    </th>
                    <!-- 2. Title -->
                    <th style="width: {columnWidths.title}px" on:click={() => handleHeaderClick('title')}>
                        Title {sortHistory[0]?.field === 'title' ? (sortHistory[0].dir === 'asc' ? '↑' : '↓') : ''}
                        <div class="resize-handle" on:mousedown={(e) => handleResizeStart(e, 'title')} on:click|stopPropagation></div>
                    </th>
                    <!-- 3. Body (HTML) -->
                    <th style="width: {columnWidths.body}px" on:click={() => handleHeaderClick('body')}>
                        Body (HTML) {sortHistory[0]?.field === 'body' ? (sortHistory[0].dir === 'asc' ? '↑' : '↓') : ''}
                        <div class="resize-handle" on:mousedown={(e) => handleResizeStart(e, 'body')} on:click|stopPropagation></div>
                    </th>
                    <!-- 4. Product Category -->
                    <th style="width: {columnWidths.category}px" on:click={() => handleHeaderClick('category')}>
                        Product Category {sortHistory[0]?.field === 'category' ? (sortHistory[0].dir === 'asc' ? '↑' : '↓') : ''}
                        <div class="resize-handle" on:mousedown={(e) => handleResizeStart(e, 'category')} on:click|stopPropagation></div>
                    </th>
                    <!-- 5. Option1 Value (Subtype) -->
                    <th style="width: {columnWidths.subtype}px" on:click={() => handleHeaderClick('subtype')}>
                        Option1 Value {sortHistory[0]?.field === 'subtype' ? (sortHistory[0].dir === 'asc' ? '↑' : '↓') : ''}
                        <div class="resize-handle" on:mousedown={(e) => handleResizeStart(e, 'subtype')} on:click|stopPropagation></div>
                    </th>
                    <!-- 6. Variant SKU -->
                    <th style="width: {columnWidths.sku}px" on:click={() => handleHeaderClick('sku')}>
                        Variant SKU {sortHistory[0]?.field === 'sku' ? (sortHistory[0].dir === 'asc' ? '↑' : '↓') : ''}
                         <div class="resize-handle" on:mousedown={(e) => handleResizeStart(e, 'sku')} on:click|stopPropagation></div>
                    </th>
                    <!-- 7. Variant Grams -->
                    <th style="width: {columnWidths.weight}px" on:click={() => handleHeaderClick('weight')}>
                        Variant Grams {sortHistory[0]?.field === 'weight' ? (sortHistory[0].dir === 'asc' ? '↑' : '↓') : ''}
                         <div class="resize-handle" on:mousedown={(e) => handleResizeStart(e, 'weight')} on:click|stopPropagation></div>
                    </th>
                    <!-- 8. Variant Inventory Qty -->
                    <th style="width: {columnWidths.stock}px" on:click={() => handleHeaderClick('stock')}>
                        Variant Inventory Qty {sortHistory[0]?.field === 'stock' ? (sortHistory[0].dir === 'asc' ? '↑' : '↓') : ''}
                         <div class="resize-handle" on:mousedown={(e) => handleResizeStart(e, 'stock')} on:click|stopPropagation></div>
                    </th>
                    <!-- 9. Variant Price -->
                    <th style="width: {columnWidths.price}px" on:click={() => handleHeaderClick('price')}>
                        Variant Price {sortHistory[0]?.field === 'price' ? (sortHistory[0].dir === 'asc' ? '↑' : '↓') : ''}
                         <div class="resize-handle" on:mousedown={(e) => handleResizeStart(e, 'price')} on:click|stopPropagation></div>
                    </th>
                    <!-- 10. Variant Barcode -->
                    <th style="width: {columnWidths.barcode}px" on:click={() => handleHeaderClick('barcode')}>
                        Variant Barcode {sortHistory[0]?.field === 'barcode' ? (sortHistory[0].dir === 'asc' ? '↑' : '↓') : ''}
                         <div class="resize-handle" on:mousedown={(e) => handleResizeStart(e, 'barcode')} on:click|stopPropagation></div>
                    </th>
                    <!-- 11. Image Src -->
                    <th style="width: {columnWidths.image}px" on:click={() => handleHeaderClick('image')}>
                        Image Src {sortHistory[0]?.field === 'image' ? (sortHistory[0].dir === 'asc' ? '↑' : '↓') : ''}
                         <div class="resize-handle" on:mousedown={(e) => handleResizeStart(e, 'image')} on:click|stopPropagation></div>
                    </th>
                    <!-- 12. Image Position -->
                    <th style="width: {columnWidths.imgPos}px" on:click={() => handleHeaderClick('imgPos')}>
                        Image Position {sortHistory[0]?.field === 'imgPos' ? (sortHistory[0].dir === 'asc' ? '↑' : '↓') : ''}
                         <div class="resize-handle" on:mousedown={(e) => handleResizeStart(e, 'imgPos')} on:click|stopPropagation></div>
                    </th>
                    <!-- 13. Image Alt Text -->
                    <th style="width: {columnWidths.imgAlt}px" on:click={() => handleHeaderClick('imgAlt')}>
                        Image Alt Text {sortHistory[0]?.field === 'imgAlt' ? (sortHistory[0].dir === 'asc' ? '↑' : '↓') : ''}
                         <div class="resize-handle" on:mousedown={(e) => handleResizeStart(e, 'imgAlt')} on:click|stopPropagation></div>
                    </th>
                    <!-- 14. Variant Image -->
                    <th style="width: {columnWidths.varImg}px" on:click={() => handleHeaderClick('varImg')}>
                        Variant Image {sortHistory[0]?.field === 'varImg' ? (sortHistory[0].dir === 'asc' ? '↑' : '↓') : ''}
                         <div class="resize-handle" on:mousedown={(e) => handleResizeStart(e, 'varImg')} on:click|stopPropagation></div>
                    </th>
                </tr>
            </thead>
            <tbody>
                {#each visibleItems as item, i}
                    <tr>
                        <!-- 1. Handle -->
                         <td class="input-cell" class:selected={selectionColumn === 'handle' && i >= selectionStart && i <= selectionEnd}>
                            <input 
                                value={item.handle || ""} 
                                placeholder={item.computedHandle}
                                on:change={(e) => commitEdit(item.id, 'handle', e.currentTarget.value, i)}
                                on:focus={() => handleFocus(i, 'handle')}
                                on:keydown={(e) => handleInputKey(e, i, 'handle', item.handle || item.computedHandle, item)}
                                on:mousedown={(e) => handleCellMouseDown(i, 'handle', e)}
                            />
                        </td>
                        
                        <!-- 2. Title -->
                        <td class="input-cell" class:selected={selectionColumn === 'description' && i >= selectionStart && i <= selectionEnd}>
                            <input 
                                value={item.description}
                                on:change={(e) => commitEdit(item.id, 'description', e.currentTarget.value, i)}
                                on:focus={() => handleFocus(i, 'description')}
                                on:keydown={(e) => handleInputKey(e, i, 'description', item.description, item)}
                                on:mousedown={(e) => handleCellMouseDown(i, 'description', e)}
                            />
                        </td>
                        
                        <!-- 3. Body (HTML) -->
                         <td class="input-cell" class:selected={selectionColumn === 'bodyHtml' && i >= selectionStart && i <= selectionEnd}>
                             <input 
                                value={item.bodyHtml || ""}
                                on:change={(e) => commitEdit(item.id, 'bodyHtml', e.currentTarget.value, i)}
                                on:focus={() => handleFocus(i, 'bodyHtml')}
                                on:keydown={(e) => handleInputKey(e, i, 'bodyHtml', item.bodyHtml, item)}
                                on:mousedown={(e) => handleCellMouseDown(i, 'bodyHtml', e)}
                             />
                         </td>

                        <!-- 4. Product Category -->
                        <td class="input-cell" class:selected={selectionColumn === 'productCategory' && i >= selectionStart && i <= selectionEnd}>
                            <input 
                                value={item.productCategory || ""}
                                on:change={(e) => commitEdit(item.id, 'productCategory', e.currentTarget.value, i)}
                                on:focus={() => handleFocus(i, 'productCategory')}
                                on:keydown={(e) => handleInputKey(e, i, 'productCategory', item.productCategory, item)}
                                on:mousedown={(e) => handleCellMouseDown(i, 'productCategory', e)}
                             />
                        </td>

                        <!-- 5. Option1 Value (Subtype) -->
                         <td class="static-cell">{item.subtype}</td>

                        <!-- 6. Variant SKU (Inventory ID) -->
                        <td class="static-cell">{item.id}</td>

                        <!-- 7. Variant Grams -->
                        <td class="input-cell" class:selected={selectionColumn === 'weight' && i >= selectionStart && i <= selectionEnd}>
                            <input 
                                type="number"
                                value={item.weight || ""}
                                on:change={(e) => commitEdit(item.id, 'weight', parseFloat(e.currentTarget.value), i)}
                                on:focus={() => handleFocus(i, 'weight')}
                                on:keydown={(e) => handleInputKey(e, i, 'weight', item.weight, item)}
                                on:mousedown={(e) => handleCellMouseDown(i, 'weight', e)}
                            />
                        </td>
                        
                         <!-- 8. Variant Inventory Qty -->
                        <td class="static-cell text-right pr-2">{item.qty}</td>

                        <!-- 9. Variant Price -->
                        <td class="input-cell" class:selected={selectionColumn === 'price' && i >= selectionStart && i <= selectionEnd}>
                            <input 
                                type="number"
                                value={item.price || ""}
                                on:change={(e) => commitEdit(item.id, 'price', parseFloat(e.currentTarget.value), i)}
                                on:focus={() => handleFocus(i, 'price')}
                                on:keydown={(e) => handleInputKey(e, i, 'price', item.price, item)}
                                on:mousedown={(e) => handleCellMouseDown(i, 'price', e)}
                            />
                        </td>

                        <!-- 10. Variant Barcode -->
                         <td class="static-cell">{item.janCode}</td>

                        <!-- 11. Image Src -->
                        <td class="p-1">
                            {#if item.image}
                                <ImageThumbnail src={item.image} width="3rem" height="3rem" fit="cover" />
                            {/if}
                        </td>

                        <!-- 12. Image Position -->
                        <td class="input-cell" class:selected={selectionColumn === 'imagePosition' && i >= selectionStart && i <= selectionEnd}>
                            <input 
                                type="number"
                                value={item.imagePosition || ""}
                                on:change={(e) => commitEdit(item.id, 'imagePosition', parseInt(e.currentTarget.value), i)}
                                on:focus={() => handleFocus(i, 'imagePosition')}
                                on:keydown={(e) => handleInputKey(e, i, 'imagePosition', item.imagePosition, item)}
                                on:mousedown={(e) => handleCellMouseDown(i, 'imagePosition', e)}
                            />
                        </td>
                        
                          <!-- 13. Image Alt Text -->
                        <td class="input-cell" class:selected={selectionColumn === 'imageAltText' && i >= selectionStart && i <= selectionEnd}>
                             <input 
                                value={item.imageAltText || item.description || ""}
                                on:change={(e) => commitEdit(item.id, 'imageAltText', e.currentTarget.value, i)}
                                on:focus={() => handleFocus(i, 'imageAltText')}
                                on:keydown={(e) => handleInputKey(e, i, 'imageAltText', item.imageAltText, item)}
                                on:mousedown={(e) => handleCellMouseDown(i, 'imageAltText', e)}
                             />
                        </td>

                        <!-- 14. Variant Image -->
                        <td class="p-1">
                             {#if item.image}
                                <ImageThumbnail src={item.image} width="3rem" height="3rem" fit="cover" />
                            {/if}
                        </td>
                    </tr>
                {/each}
            </tbody>
        </table>
    </div>
</div>

<style>
    .page {
        display: flex;
        flex-direction: column;
        height: 100vh;
        background: white;
    }
    .toolbar {
        padding: 1rem;
        border-bottom: 1px solid #ccc;
        display: flex;
        justify-content: space-between;
        align-items: center;
        background: #f9f9f9;
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
    .grid-container {
        flex: 1;
        overflow: auto;
    }
    table {
        border-collapse: separate; /* Needed for sticky headers? Or collapse works? Collapse usually better for simple grids. */
        border-collapse: collapse;
        table-layout: fixed; /* Respect column widths */
        min-width: 100%; /* Or auto to allow growth? Fixed layout needs width. */
        width: max-content; /* Allow growing beyond viewport */
    }
    thead {
        position: sticky;
        top: 0;
        background: #eee;
        z-index: 10;
        box-shadow: 0 1px 2px rgba(0,0,0,0.1);
    }
    th, td {
        border: 1px solid #e0e0e0;
        padding: 0;
        overflow: hidden; /* Hide overflow content */
        white-space: nowrap;
    }
    th {
        padding: 0.5rem;
        text-align: left;
        font-weight: 600;
        color: #444;
        font-size: 0.75rem;
        text-transform: uppercase;
        position: relative; /* For resize handle */
        user-select: none; /* Prevent text select while resizing */
        cursor: pointer;
    }
    th:hover {
        background: #e0e0e0;
    }
    
    .resize-handle {
        position: absolute;
        top: 0;
        right: 0;
        width: 5px;
        height: 100%;
        cursor: col-resize;
        /* background: transparent; */
        z-index: 11;
    }
    .resize-handle:hover {
        background: #ccc;
    }

    /* Input Styling to look like spreadsheet */
    .input-cell input {
        width: 100%;
        height: 100%;
        border: none;
        padding: 0.5rem;
        font-family: inherit;
        background: transparent;
        outline: none;
        text-overflow: ellipsis; 
    }
    .input-cell input:focus {
        background: #eef2ff; /* Light indigo focus */
        box-shadow: inset 0 0 0 2px #6366f1;
    }
    .static-cell {
        padding: 0.5rem;
        background: #fafafa;
        color: #666;
        text-overflow: ellipsis;
        overflow: hidden;
    }
    
    td.selected {
        background-color: #e0e7ff !important;
        border: 2px solid #6366f1 !important;
        position: relative; /* For z-index if needed */
    }
    td.selected input {
        background: transparent;
    }
    
    .btn-primary {
        background: #4f46e5;
        color: white;
        padding: 0.5rem 1rem;
        border-radius: 4px;
        border: none;
        font-weight: 500;
        cursor: pointer;
    }
    .btn-primary:hover {
        background: #4338ca;
    }
</style>
