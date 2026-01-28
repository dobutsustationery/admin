<script context="module" lang="ts">
  // Config Types
  export interface ColumnConfig {
      field: string;
      header: string;
      width: number;
      editable?: boolean;
      type?: 'text' | 'number' | 'component'; // strict input types
      component?: any; // Svelte Component Constructor
      align?: 'left' | 'center' | 'right';
      placeholderField?: string; // Field to use as placeholder
  }
  
  export interface SortRule {
      field: string;
      dir: 'asc' | 'desc';
  }
</script>

<script lang="ts">
  import { createEventDispatcher } from "svelte";
  
  export let data: any[] = [];
  export let columns: ColumnConfig[] = [];
  export let keyField: string = "id";
  export let sortHistory: SortRule[] = [];

  const dispatch = createEventDispatcher<{
      commit: { id: string, field: string, value: any, index: number };
      sort: { field: string };
      navigate: { id: string, event: MouseEvent };
      imagePick: { item: any, index: number, col: any };
      editHtml: { item: any };
      resize: { field: string, width: number };
  }>();

  function handleEditHtml(e: CustomEvent<{ item: any }>) {
      dispatch('editHtml', e.detail);
  }

  // --- Interaction State ---
  let selectionColumn: string | null = null;
  let selectionStart: number = -1;
  let selectionEnd: number = -1;
  let focusedRowIndex: number = -1;
  let anchorRow: number = -1;
  let anchorCol: string = "";
  
  // Selection Hints
  let missedGroupHintIndex: number = -1;
  let extensionHintIndex: number = -1;

  // --- Resizing ---
  let resizingColumn: string | null = null;
  let startX = 0;
  let startWidth = 0;

  function handleResizeStart(e: MouseEvent, col: string) {
      const colDef = columns.find(c => c.field === col);
      if (!colDef) return;
      
      resizingColumn = col;
      startX = e.clientX;
      startWidth = colDef.width;
      
      window.addEventListener('mousemove', handleResizeMove);
      window.addEventListener('mouseup', handleResizeEnd);
      e.preventDefault();
  }
  
  function handleResizeMove(e: MouseEvent) {
      if (!resizingColumn) return;
      const diff = e.clientX - startX;
      const newWidth = Math.max(50, startWidth + diff);
      
      // Update local column config reference - Parent binding should usually handle this if bound
      // But we can also just mutate specifically or dispatch.
      // Since columns is an object array, mutation works if parent binds `bind:columns`.
      const col = columns.find(c => c.field === resizingColumn);
      if (col) col.width = newWidth;
  }
  
  function handleResizeEnd() {
      resizingColumn = null;
      window.removeEventListener('mousemove', handleResizeMove);
      window.removeEventListener('mouseup', handleResizeEnd);
  }

  // --- Cell Interaction ---
  function handleHeaderClick(field: string) {
      dispatch('sort', { field });
  }

  function handleFocus(index: number, field: string) {
      focusedRowIndex = index;
      
      if (selectionColumn === null) {
          anchorRow = index;
          anchorCol = field;
      }

      if (selectionColumn && selectionColumn !== field) {
          clearSelection();
          anchorRow = index;
          anchorCol = field;
      }
  }

  function handleCellMouseDown(index: number, field: string, e: MouseEvent) {
      if (e.shiftKey) {
          e.preventDefault(); 
          
          if (selectionColumn === field && selectionStart !== -1) {
              // Extend
              selectionEnd = index; // Simple extend to click
          } else if (focusedRowIndex !== -1) {
               // Start new selection
               // Logic from legacy: check anchor
               if (anchorCol === field && anchorRow !== -1) {
                   selectionColumn = field;
                   selectionStart = Math.min(anchorRow, index);
                   selectionEnd = Math.max(anchorRow, index);
               }
          }
      } else {
          if (selectionColumn) clearSelection();
      }
  }

  function handleInputKey(e: KeyboardEvent, index: number, field: string, value: any, item: any) {
      if (e.key === "Enter") {
           if (selectionColumn === field && selectionStart !== -1 && selectionStart !== selectionEnd) {
              fillSelection(value);
              e.preventDefault();
           } else {
              (e.target as HTMLElement).blur();
              e.preventDefault(); 
           }
      } else if (e.key === "Escape") {
          clearSelection();
      } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && e.shiftKey) {
          e.preventDefault();
          handleArrowSelection(e, index, field);
      }
      // Note: ArrowRight auto-complete omitted as it was specific to 'handle'. 
      // Can be re-added as generic 'auto-fill placeholder' feature later?
  }

  function handleArrowSelection(e: KeyboardEvent, index: number, field: string) {
      if (!selectionColumn) {
          selectionColumn = field;
          selectionStart = index;
          selectionEnd = index;
          anchorRow = index;
      }
      
      // Clear hints
      missedGroupHintIndex = -1;
      
      const direction = e.key === "ArrowDown" ? 1 : -1;
      
      // Basic bounds update without complex grouping logic first (keep it simple for generic)
      // If we want grouping logic, we need a 'groupField' prop? 
      // For now, let's just do standard range verify.
      
      // Determine "Active Edge"
      let activeIndex = index; 
      if (selectionStart === selectionEnd) {
           activeIndex = selectionStart; 
      } else {
           if (anchorRow === selectionStart) activeIndex = selectionEnd;
           else if (anchorRow === selectionEnd) activeIndex = selectionStart;
           else activeIndex = (direction === 1) ? selectionEnd : selectionStart;
      }
      
      const nextIndex = activeIndex + direction;
      if (nextIndex >= 0 && nextIndex < data.length) {
          // Check grouping if applicable?
          // Legacy logic checked for 'handle' match. 
          // We can't assume 'handle' here. 
          // Maybe just standard shift-select for now.
          
          selectionEnd = Math.max(selectionEnd, nextIndex);
          selectionStart = Math.min(selectionStart, nextIndex);
          
          // Ensure anchor included
          selectionEnd = Math.max(selectionEnd, anchorRow);
          selectionStart = Math.min(selectionStart, anchorRow);
      }
  }

  function fillSelection(sourceValue: any) {
      if (!selectionColumn || selectionStart === -1) return;
      
      for (let i = selectionStart; i <= selectionEnd; i++) {
          const item = data[i];
          const id = item[keyField];
          dispatch('commit', { id, field: selectionColumn, value: sourceValue, index: i });
      }
      clearSelection();
  }

  function clearSelection() {
      selectionColumn = null;
      selectionStart = -1;
      selectionEnd = -1;
      missedGroupHintIndex = -1;
      extensionHintIndex = -1;
  }
  
  function getSortIndicator(field: string): string {
      const idx = sortHistory.findIndex(r => r.field === field);
      if (idx === 0) return sortHistory[0].dir === 'asc' ? '↑' : '↓';
      return '';
  }

  function handleCommit(e: Event, item: any, field: string, index: number) {
      const target = e.currentTarget as HTMLInputElement;
      const val = target.type === 'number' ? (target.value === "" ? null : parseFloat(target.value)) : target.value;
      
      const id = item[keyField];
      dispatch('commit', { id, field, value: val, index });
  }

</script>

<div class="grid-container">
    <table class="data-table">
        <thead class="table-head">
            <tr>
                {#each columns as col}
                    <th 
                        class="header-cell"
                        style="width: {col.width}px;" 
                        title={col.header}
                        on:click={() => handleHeaderClick(col.field)}
                    >
                        <div class="header-content">
                            <span class="header-text">{col.header}</span>
                            <span class="sort-indicator">{getSortIndicator(col.field)}</span>
                        </div>
                        
                        <!-- Resizer -->
                        <div 
                            role="separator" 
                            tabindex="0" 
                            class="col-resizer"
                            aria-label="Resize Column"
                            on:mousedown={(e) => handleResizeStart(e, col.field)}
                            on:click|stopPropagation
                            on:keydown={() => {}}
                        ></div>
                    </th>
                {/each}
            </tr>
        </thead>
        <tbody class="table-body">
            {#each data as item, i (item[keyField])}
                <tr class="data-row">
                    {#each columns as col}
                        <td 
                            class="data-cell"
                            class:selected={selectionColumn === col.field && i >= selectionStart && i <= selectionEnd}
                        >
                            {#if col.type === 'component'}
                                <div class="cell-component-wrapper">
                                    <svelte:component 
                                        this={col.component} 
                                        {item} 
                                        index={i}
                                        {col}
                                        on:navigate
                                        on:imagePick={() => dispatch('imagePick', { item, index: i, col })}
                                        on:editHtml={handleEditHtml}
                                    />
                                </div>
                            {:else if col.editable !== false}
                                <input 
                                    type={col.type === 'number' ? 'number' : 'text'}
                                    class="cell-input"
                                    class:text-right={col.align === 'right' || col.type === 'number'}
                                    class:text-center={col.align === 'center'}
                                    value={item[col.field] ?? ""}
                                    placeholder={col.placeholderField ? item[col.placeholderField] : ""}
                                    on:change={(e) => handleCommit(e, item, col.field, i)}
                                    on:focus={() => handleFocus(i, col.field)}
                                    on:keydown={(e) => handleInputKey(e, i, col.field, e.currentTarget.value, item)}
                                    on:mousedown={(e) => handleCellMouseDown(i, col.field, e)}
                                />
                            {:else}
                                <div class="cell-readonly" title={item[col.field]}>
                                    {item[col.field]}
                                </div>
                            {/if}
                        </td>
                    {/each}
                </tr>
            {/each}
        </tbody>
    </table>
</div>

<style>
    .grid-container {
        width: 100%;
        height: 100%;
        overflow: auto;
        background-color: #f9fafb; /* gray-50 */
        border: 1px solid #e5e7eb; /* gray-200 */
        border-radius: 0.5rem;
    }

    .data-table {
        width: 100%;
        border-collapse: collapse; /* This is crucial for borders */
        table-layout: fixed;
        background-color: white;
        font-size: 0.875rem; /* text-sm */
    }

    /* Header Styling */
    .table-head {
        position: sticky;
        top: 0;
        z-index: 10;
        background-color: #f3f4f6; /* gray-100 */
        box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
    }

    .header-cell {
        position: relative;
        padding: 0.5rem;
        text-align: left;
        font-weight: 600;
        color: #374151; /* gray-700 */
        border-right: 1px solid #e5e7eb;
        border-bottom: 1px solid #e5e7eb;
        user-select: none;
        white-space: nowrap;
        overflow: hidden;
        background-clip: padding-box;
    }

    .header-cell:last-child {
        border-right: none;
    }

    .header-content {
        display: flex;
        align-items: center;
        justify-content: space-between;
        pointer-events: none; /* Let clicks pass to TH */
    }

    .header-text {
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .sort-indicator {
        font-size: 0.75rem;
        margin-left: 0.25rem;
        color: #6b7280;
    }

    .col-resizer {
        position: absolute;
        right: 0;
        top: 0;
        bottom: 0;
        width: 4px;
        cursor: col-resize;
        z-index: 20;
    }
    
    .col-resizer:hover {
        background-color: #60a5fa; /* blue-400 */
    }

    /* Body/Row Styling */
    .data-row:hover {
        background-color: #eff6ff; /* blue-50 */
    }

    .data-cell {
        padding: 0;
        border-right: 1px solid #e5e7eb;
        border-bottom: 1px solid #e5e7eb;
        position: relative;
        height: 2.5rem; /* Enforce height */
    }
    
    .data-cell:last-child {
        border-right: none;
    }

    /* Selection State */
    .data-cell.selected {
        background-color: #dbeafe; /* blue-100 */
        /* Optional: Add outline to the group? Complicated. */
    }
    
    .data-cell.selected .cell-input {
        background-color: #dbeafe; /* blue-100 */
    }

    /* Input Styling */
    .cell-input {
        width: 100%;
        height: 100%;
        padding: 0.5rem;
        outline: none;
        background: transparent;
        border: none;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-family: inherit;
        font-size: inherit;
        display: block; /* Removed flex */
    }

    .cell-input:focus {
        background-color: white;
        box-shadow: inset 0 0 0 2px #3b82f6; /* blue-500 ring */
        z-index: 5; /* Bring above borders */
        position: relative;
    }

    .text-right {
        text-align: right;
    }

    .text-center {
        text-align: center;
    }

    /* Readonly / Component Wrappers */
    .cell-readonly {
        padding: 0.5rem;
        color: #4b5563; /* gray-600 */
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        cursor: default;
    }
    
    .cell-component-wrapper {
        height: 100%;
        width: 100%;
        overflow: hidden;
    }
</style>
