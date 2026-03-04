<script context="module" lang="ts">
  // Config Types
  export interface ColumnConfig {
    field: string;
    header: string;
    width: number;
    editable?: boolean;
    type?: "text" | "number" | "component"; // strict input types
    component?: any; // Svelte Component Constructor
    align?: "left" | "center" | "right";
    placeholderField?: string; // Field to use as placeholder
  }

  export interface SortRule {
    field: string;
    dir: "asc" | "desc";
  }
</script>

<script lang="ts">
  import { createEventDispatcher } from "svelte";

  export let data: any[] = [];
  export let columns: ColumnConfig[] = [];
  export let keyField: string = "id";
  export let sortHistory: SortRule[] = [];
  export let frozenColumns: number = 2;

  const dispatch = createEventDispatcher<{
    commit: { id: string; field: string; value: any; index: number };
    sort: { field: string };
    navigate: { id: string; event: MouseEvent };
    imagePick: { item: any; index: number; col: any };
    editHtml: { item: any };
    resize: { field: string; width: number };
  }>();

  $: frozenLefts = columns.reduce(
    (acc, col, idx) => {
      if (idx < frozenColumns) {
        const prevLeft =
          idx === 0 ? 0 : acc[idx - 1].left + columns[idx - 1].width;
        acc.push({ isFrozen: true, left: prevLeft });
      } else {
        acc.push({ isFrozen: false, left: 0 });
      }
      return acc;
    },
    [] as { isFrozen: boolean; left: number }[],
  );

  function handleEditHtml(e: CustomEvent<{ item: any }>) {
    dispatch("editHtml", e.detail);
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
    const colDef = columns.find((c) => c.field === col);
    if (!colDef) return;

    resizingColumn = col;
    startX = e.clientX;
    startWidth = colDef.width;

    window.addEventListener("mousemove", handleResizeMove);
    window.addEventListener("mouseup", handleResizeEnd);
    e.preventDefault();
  }

  function handleResizeMove(e: MouseEvent) {
    if (!resizingColumn) return;
    const diff = e.clientX - startX;
    const newWidth = Math.max(50, startWidth + diff);

    // Update local column config reference - Parent binding should usually handle this if bound
    // But we can also just mutate specifically or dispatch.
    // Since columns is an object array, mutation works if parent binds `bind:columns`.
    const col = columns.find((c) => c.field === resizingColumn);
    if (col) {
      col.width = newWidth;
      columns = columns; // Trigger reactivity
    }
  }

  function handleResizeEnd() {
    if (resizingColumn) {
      const col = columns.find((c) => c.field === resizingColumn);
      if (col) {
        dispatch("resize", { field: resizingColumn, width: col.width });
      }
    }
    resizingColumn = null;
    window.removeEventListener("mousemove", handleResizeMove);
    window.removeEventListener("mouseup", handleResizeEnd);
  }

  // --- Cell Interaction ---
  function handleHeaderClick(field: string) {
    dispatch("sort", { field });
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

  function handleInputKey(
    e: KeyboardEvent,
    index: number,
    field: string,
    value: any,
    item: any,
  ) {
    if (e.key === "Enter") {
      if (
        selectionColumn === field &&
        selectionStart !== -1 &&
        selectionStart !== selectionEnd
      ) {
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

  function handleArrowSelection(
    e: KeyboardEvent,
    index: number,
    field: string,
  ) {
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
      else activeIndex = direction === 1 ? selectionEnd : selectionStart;
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
      dispatch("commit", {
        id,
        field: selectionColumn,
        value: sourceValue,
        index: i,
      });
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

  $: sortIndicatorByField = new Map(
    sortHistory.map((rule, idx) => {
      const arrow = rule.dir === "asc" ? "↑" : "↓";
      return [rule.field, idx === 0 ? arrow : `${arrow}${idx + 1}`];
    }),
  );

  $: sortAriaByField = new Map<string, "none" | "ascending" | "descending">(
    sortHistory.map((rule, idx) => [
      rule.field,
      idx === 0 ? (rule.dir === "asc" ? "ascending" : "descending") : "none",
    ]),
  );

  $: sortedFields = new Set(sortHistory.map((rule) => rule.field));

  function handleCommit(e: Event, item: any, field: string, index: number) {
    const target = e.currentTarget as HTMLInputElement;
    const val =
      target.type === "number"
        ? target.value === ""
          ? null
          : parseFloat(target.value)
        : target.value;

    const id = item[keyField];
    dispatch("commit", { id, field, value: val, index });
  }
</script>

<div class="grid-container">
  <table class="data-table">
    <thead class="table-head">
      <tr>
        {#each columns as col, i}
          <th
            class="header-cell"
            class:sorted={sortedFields.has(col.field)}
            class:frozen={frozenLefts[i].isFrozen}
            class:frozen-last={frozenLefts[i].isFrozen &&
              i === frozenColumns - 1}
            aria-sort={sortAriaByField.get(col.field) || "none"}
            style="width: {col.width}px; {frozenLefts[i].isFrozen
              ? `left: ${frozenLefts[i].left}px;`
              : ''}"
            title={col.header}
            on:click={() => handleHeaderClick(col.field)}
          >
            <div class="header-content">
              <span class="header-text">{col.header}</span>
              <span class="sort-indicator"
                >{sortIndicatorByField.get(col.field) || ""}</span
              >
            </div>

            <!-- Resizer -->
            <button
              type="button"
              class="col-resizer"
              aria-label="Resize Column"
              on:mousedown={(e) => handleResizeStart(e, col.field)}
              on:click|stopPropagation
              on:keydown={() => {}}
            ></button>
          </th>
        {/each}
      </tr>
    </thead>
    <tbody class="table-body">
      {#each data as item, i (item[keyField])}
        <tr class="data-row">
          {#each columns as col, j}
            <td
              class="data-cell"
              class:frozen={frozenLefts[j].isFrozen}
              class:frozen-last={frozenLefts[j].isFrozen &&
                j === frozenColumns - 1}
              class:selected={selectionColumn === col.field &&
                i >= selectionStart &&
                i <= selectionEnd}
              style={frozenLefts[j].isFrozen
                ? `left: ${frozenLefts[j].left}px;`
                : ""}
            >
              {#if col.type === "component"}
                <div class="cell-component-wrapper">
                  <svelte:component
                    this={col.component}
                    {item}
                    index={i}
                    {col}
                    on:navigate
                    on:imagePick={() =>
                      dispatch("imagePick", { item, index: i, col })}
                    on:editHtml={handleEditHtml}
                  />
                </div>
              {:else if col.editable !== false}
                <input
                  type={col.type === "number" ? "number" : "text"}
                  class="cell-input"
                  class:text-right={col.align === "right" ||
                    col.type === "number"}
                  class:text-center={col.align === "center"}
                  value={item[col.field] ?? ""}
                  placeholder={col.placeholderField
                    ? item[col.placeholderField]
                    : ""}
                  on:change={(e) => handleCommit(e, item, col.field, i)}
                  on:focus={() => handleFocus(i, col.field)}
                  on:keydown={(e) =>
                    handleInputKey(
                      e,
                      i,
                      col.field,
                      e.currentTarget.value,
                      item,
                    )}
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
    overflow: auto; /* Handles both X and Y scroll */
    background-color: #f9fafb; /* gray-50 */
    border: 1px solid #e5e7eb; /* gray-200 */
    border-radius: 0.5rem;
    position: relative; /* Context for sticky */
  }

  .data-table {
    width: max-content; /* Allow table to expand beyond container width */
    min-width: 100%;
    border-collapse: separate; /* Use separate to allow sticky to work reliably */
    border-spacing: 0;
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
  }

  .header-cell {
    position: sticky;
    top: 0;
    padding: 0.5rem;
    text-align: left;
    font-weight: 600;
    color: #374151; /* gray-700 */
    border-right: 1px solid #e5e7eb;
    border-bottom: 1px solid #e5e7eb;
    background-color: #f3f4f6; /* Opaque background for sticky */
    user-select: none;
    white-space: nowrap;
    overflow: hidden;
    z-index: 10;
    cursor: pointer;
  }

  .header-cell.sorted {
    color: #1f2937; /* gray-800 */
  }

  /* Frozen Column Styling */
  .header-cell.frozen {
    position: sticky;
    z-index: 20; /* Above regular headers */
  }

  .header-cell.frozen-last {
    border-right: 2px solid #e5e7eb; /* Stronger border for the edge of frozen cols */
  }

  .header-cell:last-child {
    border-right: none;
  }

  .header-content {
    position: relative;
    pointer-events: none; /* Let clicks pass to TH */
  }

  .header-text {
    display: block;
    padding-right: 1.25rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sort-indicator {
    position: absolute;
    right: 0;
    top: 50%;
    transform: translateY(-50%);
    font-size: 0.75rem;
    color: #6b7280;
    min-width: 1rem;
    text-align: right;
  }

  .col-resizer {
    position: absolute;
    right: 0;
    top: 0;
    bottom: 0;
    width: 4px;
    cursor: col-resize;
    z-index: 20;
    background: transparent;
    border: none;
    padding: 0;
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
    background-color: white; /* Needed for sticky */
  }

  .data-cell.frozen {
    position: sticky;
    z-index: 5; /* Above regular cells */
  }

  .data-cell.frozen-last {
    border-right: 2px solid #e5e7eb;
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
