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
  import { ChevronLeft, ChevronRight, Search, Download } from "lucide-svelte";
  import { getAllCachedActions } from "$lib/action-cache";
  import { rootReducer } from "$lib/root-reducer";

  let actions: any[] = [];
  let loading = true;
  let viewMode: DateRangeView = "day";
  let currentDate = new Date();
  let keyAuditSnapshot: any = null;
  let ghostRows: any[] = [];
  let ghostAccessRows: any[] = [];
  let collisionRows: any[] = [];

  // Search State
  let searchTerm = "";
  let allSearchCandidates: any[] = []; // Cache for client-side filtering

  // Date range state
  $: dateRange = getDateRange(viewMode, currentDate);
  $: startDateInput = format(dateRange.start, "yyyy-MM-dd");
  $: endDateInput = format(dateRange.end, "yyyy-MM-dd");
  $: ghostRows = Object.values(
    (keyAuditSnapshot?.ghostMap || {}) as Record<string, any>,
  );
  $: ghostAccessRows = (keyAuditSnapshot?.ghostAccessEvents || []) as any[];
  $: collisionRows = Object.values(
    (keyAuditSnapshot?.canonicalCollisions || {}) as Record<string, any>,
  );

  async function fetchActions() {
    loading = true;
    try {
      if (viewMode === "search") {
        // Use local IndexedDB cache for search
        const cached = await getAllCachedActions();

        // DRY RUN REPLAY TO CAPTURE EPHEMERAL ACTIONS
        // Sort Ascending for Replay
        cached.sort((a, b) => {
          const tA =
            a.timestamp?.seconds ||
            (typeof a.timestamp === "number" ? a.timestamp : 0);
          const tB =
            b.timestamp?.seconds ||
            (typeof b.timestamp === "number" ? b.timestamp : 0);
          return tA - tB;
        });

        let state = rootReducer(undefined, { type: "@@INIT" });
        const parentToChildren = new Map<string, any[]>();

        cached.forEach((action) => {
          const children: any[] = [];
          // Logger signature: (action, state, timestamp)
          const captureLogger = (childAction: any, _s: any, _t: any) => {
            children.push(childAction);
          };

          try {
            state = rootReducer(state, action, captureLogger);
          } catch (e) {
            console.warn("Dry run replay error:", e);
          }

          if (children.length > 0) {
            parentToChildren.set(action.id, children);
          }
        });

        // Sort by timestamp desc for display
        allSearchCandidates = cached
          .map((c) => {
            let d: Date;
            if (c.timestamp?.toDate) {
              d = c.timestamp.toDate();
            } else if (c.timestamp?.seconds) {
              d = new Date(c.timestamp.seconds * 1000);
            } else {
              d = new Date(typeof c.timestamp === "number" ? c.timestamp : 0);
            }
            return {
              ...c,
              children: parentToChildren.get(c.id) || [],
              displayTime: format(d, "yyyy-MM-dd"),
            };
          })
          .sort((a, b) => {
            const tA =
              a.timestamp?.seconds ||
              (typeof a.timestamp === "number" ? a.timestamp : 0);
            const tB =
              b.timestamp?.seconds ||
              (typeof b.timestamp === "number" ? b.timestamp : 0);
            return tB - tA;
          });

        applySearchFilter();
        recomputeKeyAuditSnapshot(cached);
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
        recomputeKeyAuditSnapshot(actions);
      }
    } catch (e) {
      console.error("Error fetching audit logs:", e);
    } finally {
      loading = false;
    }
  }

  function toTimestampKey(item: any): number {
    if (item?.timestamp?.seconds) {
      const nanos = item.timestamp.nanoseconds || 0;
      return item.timestamp.seconds * 1_000_000_000 + nanos;
    }
    if (typeof item?.timestamp === "number") {
      return item.timestamp * 1_000_000_000;
    }
    if (item?.timestamp?.toDate) {
      return item.timestamp.toDate().getTime() * 1_000_000_000;
    }
    return 0;
  }

  function recomputeKeyAuditSnapshot(sourceActions: any[]) {
    try {
      const replayActions = [...(sourceActions || [])].sort(
        (a, b) => toTimestampKey(a) - toTimestampKey(b),
      );
      let state = rootReducer(undefined, { type: "@@INIT" });
      replayActions.forEach((action) => {
        state = rootReducer(state, action, () => {});
      });
      keyAuditSnapshot = state?.keyAudit || null;
    } catch (e) {
      console.warn("Failed to compute key audit snapshot:", e);
      keyAuditSnapshot = null;
    }
  }

  function applySearchFilter() {
    if (!searchTerm) {
      actions = allSearchCandidates;
      return;
    }
    const lower = searchTerm.toLowerCase();

    // Filter: Include Direct Matches OR Child Matches
    actions = allSearchCandidates.filter((item) => {
      const desc = getAuditActionDescription(item).toLowerCase();
      const raw = JSON.stringify(item).toLowerCase();

      if (desc.includes(lower) || raw.includes(lower)) return true;

      // Check Children (Ephemeral Actions)
      if (item.children) {
        const childMatch = item.children.some((child: any) =>
          JSON.stringify(child).toLowerCase().includes(lower),
        );
        if (childMatch) return true;
      }

      return false;
    });
  }

  // Reactively filter when searchTerm changes
  $: if (viewMode === "search" && typeof searchTerm === "string") {
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

  function handleExport() {
    // Filter for non-ephemeral actions only (as requested for reproduction replay)
    const exportable = actions.filter((a) => !a._ephemeral);

    if (exportable.length === 0) {
      alert("No exportable (broadcast) actions found in current view.");
      return;
    }

    // Sort Ascending for Replay (Oldest First), with nanos for deterministic order
    exportable.sort((a, b) => toTimestampKey(a) - toTimestampKey(b));

    const jsonl = exportable.map((a) => JSON.stringify(a)).join("\n");
    const blob = new Blob([jsonl], { type: "application/x-jsonlines" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-export-${format(new Date(), "yyyy-MM-dd-HHmm")}.jsonl`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
          class="btn-view-mode"
          class:active={viewMode === "search"}
          on:click={() => handleViewModeChange("search")}
        >
          <Search size={16} /> Search
        </button>

        <button
          on:click={handleExport}
          class="btn-view-mode export-btn"
          title="Export filtered broadcast actions to JSONL"
        >
          <Download size={16} /> Export
        </button>
      </div>

      <div class="date-nav">
        {#if viewMode === "search"}
          <div class="search-input-wrapper">
            <input
              type="text"
              bind:value={searchTerm}
              placeholder="Search logs..."
              class="search-input"
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
              {#if action.children && action.children.length > 0}
                <div class="children-section">
                  <h4>Derived Actions (Dry Run):</h4>
                  {#each action.children as child}
                    <pre class="child-action">{JSON.stringify(
                        child,
                        null,
                        2,
                      )}</pre>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if keyAuditSnapshot}
    <section class="key-audit-section">
      <h2>Key Audit</h2>

      <h3>Ghost ID Map</h3>
      {#if ghostRows.length === 0}
        <div class="empty-small">No ghost IDs recorded.</div>
      {:else}
        <div class="table-wrap">
          <table class="key-audit-table">
            <thead>
              <tr>
                <th>Ghost ID</th>
                <th>Canonical ID</th>
                <th>Transition</th>
                <th>Action</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {#each ghostRows as row}
                <tr>
                  <td>{row.ghostId}</td>
                  <td>{row.canonicalId}</td>
                  <td
                    >{row.oldSubtype || "(blank)"} → {row.newSubtype ||
                      "(blank)"}</td
                  >
                  <td>{row.renamedByActionType}</td>
                  <td
                    >{format(
                      new Date(row.renamedAtMs),
                      "yyyy-MM-dd HH:mm:ss",
                    )}</td
                  >
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}

      <h3>Ghost Access Events</h3>
      {#if ghostAccessRows.length === 0}
        <div class="empty-small">No ghost accesses recorded.</div>
      {:else}
        <div class="table-wrap">
          <table class="key-audit-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Path</th>
                <th>Requested ID</th>
                <th>Canonical</th>
                <th>Known Ghost</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {#each ghostAccessRows as row}
                <tr>
                  <td>{format(new Date(row.atMs), "yyyy-MM-dd HH:mm:ss")}</td>
                  <td>{row.actionType}</td>
                  <td>{row.actionPath}</td>
                  <td>{row.requestedId}</td>
                  <td
                    >{row.mappedCanonicalId || row.canonicalCandidate || ""}</td
                  >
                  <td>{row.knownGhost ? "yes" : "no"}</td>
                  <td>{row.outcome}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}

      <h3>Canonical Collision Reports (Global)</h3>
      {#if collisionRows.length === 0}
        <div class="empty-small">No canonical collisions recorded.</div>
      {:else}
        <div class="table-wrap">
          <table class="key-audit-table">
            <thead>
              <tr>
                <th>Canonical ID</th>
                <th>Incoming IDs</th>
                <th>Occurrences</th>
                <th>Last Action</th>
                <th>First Seen</th>
                <th>Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {#each collisionRows as row}
                <tr>
                  <td>{row.canonicalId}</td>
                  <td>{row.incomingIds.join(", ")}</td>
                  <td>{row.occurrences}</td>
                  <td>{row.lastActionType}</td>
                  <td
                    >{format(
                      new Date(row.firstSeenAtMs),
                      "yyyy-MM-dd HH:mm:ss",
                    )}</td
                  >
                  <td
                    >{format(
                      new Date(row.lastSeenAtMs),
                      "yyyy-MM-dd HH:mm:ss",
                    )}</td
                  >
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>
  {/if}
</div>

<style>
  .audit-container {
    padding: 2rem;
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

  .view-modes button,
  .btn-view-mode {
    padding: 0.5rem 1rem;
    border: 1px solid #ccc;
    background: white;
    cursor: pointer;
    border-radius: 4px;
    display: flex;
    align-items: center;
    gap: 0.25rem; /* gap-1 */
  }

  .view-modes button.active,
  .btn-view-mode.active {
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

  .children-section {
    margin-top: 1rem;
    border-top: 1px dashed #ccc;
    padding-top: 0.5rem;
  }
  .child-action {
    background: #f0fdf4;
    padding: 0.5rem;
    margin-bottom: 0.5rem;
    font-size: 0.8rem;
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

  .key-audit-section {
    margin-top: 2rem;
    border-top: 2px solid #ddd;
    padding-top: 1.5rem;
  }

  .key-audit-section h2 {
    margin: 0 0 1rem;
  }

  .key-audit-section h3 {
    margin: 1rem 0 0.5rem;
    font-size: 1rem;
  }

  .empty-small {
    color: #666;
    font-size: 0.9rem;
    margin-bottom: 0.75rem;
  }

  .table-wrap {
    overflow-x: auto;
    margin-bottom: 1rem;
  }

  .key-audit-table {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.85rem;
  }

  .key-audit-table th,
  .key-audit-table td {
    border: 1px solid #ddd;
    padding: 0.4rem 0.5rem;
    text-align: left;
    vertical-align: top;
  }

  .key-audit-table th {
    background: #f6f7f8;
  }
</style>
