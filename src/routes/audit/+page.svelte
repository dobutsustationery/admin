<script lang="ts">
  import { onMount, tick } from "svelte";
  import { firestore } from "$lib/firebase";
  import {
    collection,
    query,
    orderBy,
    limit,
    where,
    getDocs,
    Timestamp,
  } from "firebase/firestore";
  import {
    getDateRange,
    shiftDateRange,
    getAuditActionDescription,
    type DateRangeView,
  } from "$lib/audit-helpers";
  import { format } from "date-fns";
  import { ChevronLeft, ChevronRight, Search } from "lucide-svelte";
  import { getAllCachedActions } from "$lib/action-cache";

  let actions: any[] = [];
  let loading = true;
  let viewMode: DateRangeView = "day";
  let currentDate = new Date();
  
  // Search State
  let searchTerm = "";
  let allSearchCandidates: any[] = []; // Cache for client-side filtering

  // Date range state
  $: dateRange = getDateRange(viewMode, currentDate);
  $: startDateInput = format(dateRange.start, "yyyy-MM-dd");
  $: endDateInput = format(dateRange.end, "yyyy-MM-dd");

  async function fetchActions() {
    loading = true;
    try {
      if (viewMode === "search") {
         // Use local IndexedDB cache for search
         const cached = await getAllCachedActions();
         // Sort by timestamp desc (cached actions are returned sorted by timestamp ASC usually or by insertion)
         // Let's ensure descending sort for display.
         // Also normalize timestamps.
         allSearchCandidates = cached.map(c => {
             let d: Date;
             if (c.timestamp?.toDate) {
                 d = c.timestamp.toDate();
             } else if (c.timestamp?.seconds) {
                 d = new Date(c.timestamp.seconds * 1000);
             } else {
                 d = new Date(); // Fallback
             }
             return {
                 ...c,
                 displayTime: format(d, "yyyy-MM-dd")
             };
         }).sort((a, b) => {
             // String comparison of displayTime is not enough, use raw keys if available or re-parse?
             // Since we already have the Date object logic above, let's keep it simple.
             // Ideally we sort by the raw timestamp values.
             const tA = a.timestamp?.seconds || 0;
             const tB = b.timestamp?.seconds || 0;
             return tB - tA; 
         });
         
         applySearchFilter();
      } else {
          const broadcasts = collection(firestore, "broadcast");
          const q = query(
            broadcasts,
            orderBy("timestamp", "desc"),
            where("timestamp", ">=", Timestamp.fromDate(dateRange.start)),
            where("timestamp", "<=", Timestamp.fromDate(dateRange.end)),
            limit(50),
          );

          const querySnapshot = await getDocs(q);
          actions = querySnapshot.docs.map((doc) => ({
            id: doc.id,
            ...doc.data(),
            // Helper to format timestamp for display
            displayTime: doc.data().timestamp?.toDate()
              ? format(doc.data().timestamp.toDate(), "yyyy-MM-dd")
              : "Unknown",
          }));
      }
    } catch (e) {
      console.error("Error fetching audit logs:", e);
    } finally {
      loading = false;
    }
  }

  function applySearchFilter() {
      if (!searchTerm) {
          actions = allSearchCandidates;
          return;
      }
      const lower = searchTerm.toLowerCase();
      actions = allSearchCandidates.filter(item => {
          const desc = getAuditActionDescription(item).toLowerCase();
          const raw = JSON.stringify(item).toLowerCase();
          return desc.includes(lower) || raw.includes(lower);
      });
  }
  
  // Reactively filter when searchTerm changes
  $: if (viewMode === 'search' && typeof searchTerm === 'string') {
      applySearchFilter();
  }

  function handleViewModeChange(mode: DateRangeView) {
    viewMode = mode;
    searchTerm = ""; // Clear search on mode switch
    // Reset to today when switching modes? Or keep current anchor?
    // Keeping current anchor seems better.
  }

  function shiftDate(direction: "forward" | "back") {
    currentDate = shiftDateRange(viewMode, currentDate, direction);
  }

  function handleDateInput(type: "start" | "end", event: Event) {
    const val = (event.target as HTMLInputElement).value;
    if (!val) return;

    // Just strictly parse the date string as local date at noon to avoid timezone shifts
    currentDate = new Date(val + "T12:00:00");
  }

  // Re-fetch when dateRange OR viewMode changes
  // Note: dateRange changes when viewMode changes based on logic.
  // But for 'search' viewMode, dateRange is static/irrelevent, so we need to ensure fetch triggers.
  // We effectively need to watch viewMode specifically or ensure dateRange updates.
  // Since dateRange updates when viewMode changes (to Epoch in helper), this should trigger.
  $: {
    if (dateRange || viewMode) {
      fetchActions();
    }
  }

  let expandedId: string | null = null;
  function toggleExpand(id: string) {
    expandedId = expandedId === id ? null : id;
  }
</script>

<div class="audit-container">
  <header>
    <h1>Audit Log</h1>
    <div class="controls">
      <div class="view-modes">
        <button
          class:active={viewMode === "day"}
          on:click={() => handleViewModeChange("day")}>Day</button
        >
        <button
          class:active={viewMode === "week"}
          on:click={() => handleViewModeChange("week")}>Week</button
        >
        <button
          class:active={viewMode === "month"}
          on:click={() => handleViewModeChange("month")}>Month</button
        >
        <button
          class:active={viewMode === "search"}
          on:click={() => handleViewModeChange("search")}
          class="flex items-center gap-1"
        >
          <Search size={16} /> Search
        </button>
      </div>

      <div class="date-nav">
       {#if viewMode === 'search'}
           <div class="search-input-wrapper">
               <input 
                 type="text" 
                 bind:value={searchTerm} 
                 placeholder="Search logs..." 
                 class="search-input"
                 autoFocus
               />
               <span class="search-hint">Searching local history...</span>
           </div>
       {:else}
            <button on:click={() => shiftDate("back")}
            ><ChevronLeft size={20} /></button
            >
            <div class="date-inputs">
            <input
                type="date"
                value={startDateInput}
                on:change={(e) => handleDateInput("start", e)}
                aria-label="Start Date"
            />
            <span>-</span>
            <input
                type="date"
                value={endDateInput}
                disabled
                aria-label="End Date"
            />
            </div>
            <button on:click={() => shiftDate("forward")}
            ><ChevronRight size={20} /></button
            >
        {/if}
      </div>
    </div>
  </header>

  {#if loading}
    <div class="loading">Loading audit logs...</div>
  {:else if actions.length === 0}
    <div class="empty">No actions found.</div>
  {:else}
    <div class="action-list">
      {#each actions as action (action.id)}
        <div class="action-card">
          <div
            class="action-header"
            role="button"
            tabindex="0"
            on:click={() => toggleExpand(action.id)}
            on:keydown={(e) =>
              (e.key === "Enter" || e.key === " ") && toggleExpand(action.id)}
          >
            <span class="timestamp">{action.displayTime}</span>
            <span class="description">{getAuditActionDescription(action)}</span>
            <span class="toggle">{expandedId === action.id ? "▼" : "▶"}</span>
          </div>
          {#if expandedId === action.id}
            <div class="action-body">
              <pre>{JSON.stringify(action, null, 2)}</pre>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .audit-container {
    padding: 2rem;
    max-width: 1200px;
    margin: 0 auto;
  }

  header {
    margin-bottom: 2rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .controls {
    display: flex;
    gap: 2rem;
    align-items: center;
    flex-wrap: wrap;
  }

  .view-modes {
    display: flex;
    gap: 0.5rem;
  }

  .view-modes button {
    padding: 0.5rem 1rem;
    border: 1px solid #ccc;
    background: white;
    cursor: pointer;
    border-radius: 4px;
    display: flex; /* alignment for search icon */
    align-items: center;
    gap: 0.5rem;
  }

  .view-modes button.active {
    background: #007bff;
    color: white;
    border-color: #007bff;
  }

  .date-nav {
    display: flex;
    align-items: center;
    gap: 1rem;
    font-size: 1.1rem;
    flex-grow: 1; /* Allow search bar to grow */
  }

  .date-nav button {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0.25rem;
  }

  .date-nav button:hover {
    background-color: #f0f0f0;
    border-radius: 50%;
  }
  
  .search-input-wrapper {
      display: flex;
      align-items: center;
      gap: 1rem;
      width: 100%;
      max-width: 500px;
  }
  
  .search-input {
      flex: 1;
      padding: 0.5rem;
      border: 1px solid #ccc;
      border-radius: 4px;
      font-size: 1rem;
  }
  
  .search-hint {
      font-size: 0.8rem;
      color: #666;
      white-space: nowrap;
  }

  .action-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .action-card {
    border: 1px solid #ddd;
    border-radius: 4px;
    background: white;
  }

  .action-header {
    padding: 1rem;
    display: flex;
    gap: 1rem;
    cursor: pointer;
    background: #f8f9fa;
    align-items: center;
  }

  .timestamp {
    color: #666;
    font-family: monospace;
    min-width: 180px;
  }

  .description {
    font-weight: bold;
    flex: 1;
  }

  .action-body {
    padding: 1rem;
    border-top: 1px solid #ddd;
    background: #fff;
    overflow-x: auto;
  }

  pre {
    margin: 0;
    font-size: 0.85rem;
  }

  .loading,
  .empty {
    text-align: center;
    padding: 3rem;
    color: #666;
  }
</style>
