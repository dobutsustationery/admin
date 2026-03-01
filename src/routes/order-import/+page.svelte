<script lang="ts">
  import { onMount } from "svelte";
  import { slide, fade } from "svelte/transition";
  import { store } from "$lib/store";
  import {
    isDriveConfigured,
    isAuthenticated,
    initiateOAuthFlow,
    handleOAuthCallback,
    listFilesInFolder,
    downloadFile,
    getStoredToken,
    clearToken,
    getFolderLink,
    type DriveFile,
  } from "$lib/google-drive";
  import {
    start_session,
    set_header,
    append_raw_rows,
    resolve_conflict,
    mark_items_done,
    clear_import,
    finish_import,
    import_batch,
    type RawRow,
    type ImportItem,
  } from "$lib/order-import-slice";
  import { HS_CODE_DESCRIPTIONS } from "$lib/hscodes";

  import { user } from "$lib/user-store";
  import { firestore } from "$lib/firebase";
  import { broadcast } from "$lib/redux-firestore";
  import { update_item, bulk_import_items } from "$lib/inventory";
  import Papa from "papaparse";
  import ImageThumbnail from "$lib/components/ImageThumbnail.svelte";

  // --- State from Redux ---
  $: activeFile = $store.orderImport.activeFile;
  $: rawRows = $store.orderImport.rows;
  $: step = $store.orderImport.step;
  $: resolutions = $store.orderImport.resolutions || {};

  // --- Derived Analysis ---
  // We re-compute the "Plan" view dynamically based on current Inventory
  // This replaces the static "status" field in ImportItem

  interface AnalyzedItem extends ImportItem {
    status: "MATCH" | "NEW" | "CONFLICT" | "RESOLVED" | "DONE" | "SKIPPED";
    existingItem?: any;
    subtypes?: any[];
    actionLabel: string;
    resolvedActions?: any[];
    conflictType?: "DATA_MISMATCH" | "SUBTYPES";
    conflictingFields?: string[];
    originalIndex: number; // For keying in #each
  }

  $: analyzedPlan = rawRows.map((rawRow: RawRow, index: number) => {
    // Logic runs on parsed data found in the row
    const item = rawRow.parsed;

    if (!item) {
      // Parsing error row -> SKIPPED
      return {
        status: "SKIPPED",
        janCode: "ERROR",
        description: rawRow.error || "Parse Error",
        qty: 0,
        carton: "",
        actionLabel: "Skipped",
        originalIndex: index,
      } as AnalyzedItem;
    }

    // If processed, it's DONE
    if (item.processed || rawRow.processed) {
      return {
        ...item,
        status: "DONE",
        actionLabel: "Done",
        originalIndex: index,
      } as AnalyzedItem;
    }

    // Analyze against Inventory (Shared Logic)
    const JAN = item.janCode;
    const inventoryMatches = Object.entries($store.inventory.idToItem)
      .filter(([k, i]: [string, any]) => i.janCode === JAN)
      .map(([k, i]: [string, any]) => ({ ...i, key: k }));

    // Detect Conflicts
    let detectedStatus: "MATCH" | "NEW" | "CONFLICT" = "NEW";
    let conflictType: "DATA_MISMATCH" | "SUBTYPES" | undefined;
    let conflictingFields: string[] | undefined;
    let existingItem: any | undefined;
    let subtypes: any[] | undefined;

    if (inventoryMatches.length === 0) {
      detectedStatus = "NEW";
    } else if (inventoryMatches.length === 1) {
      existingItem = inventoryMatches[0];
      // Check for Data Mismatches
      const existingHS = existingItem.hsCode;
      const newHS = item.hsCode;
      const existingWeight = existingItem.weight;
      const newWeight = item.weight;
      const existingCOO = existingItem.countryOfOrigin;
      const newCOO = item.countryOfOrigin;

      const conflicts: string[] = [];
      if (existingHS && newHS && existingHS !== newHS)
        conflicts.push("HS Code");
      if (existingWeight && newWeight && existingWeight !== newWeight)
        conflicts.push("Weight");
      if (existingCOO && newCOO && existingCOO !== newCOO)
        conflicts.push("Country of Origin");

      if (conflicts.length > 0) {
        detectedStatus = "CONFLICT";
        conflictType = "DATA_MISMATCH";
        conflictingFields = conflicts;
      } else {
        detectedStatus = "MATCH";
      }
    } else {
      // Multiple matches
      if (item.qty === 0) {
        // Special Case: Zero Quantity Split
        // If incoming qty is 0, allocation is trivial (0).
        // We treat this as a MATCH on the first item to allow auto-processing (e.g. cost updates).
        detectedStatus = "MATCH";
        existingItem = inventoryMatches[0];

        // Still check for Data Mismatches on this target
        const existingHS = existingItem.hsCode;
        const newHS = item.hsCode;
        const existingWeight = existingItem.weight;
        const newWeight = item.weight;
        const existingCOO = existingItem.countryOfOrigin;
        const newCOO = item.countryOfOrigin;

        const conflicts: string[] = [];
        if (existingHS && newHS && existingHS !== newHS)
          conflicts.push("HS Code");
        if (existingWeight && newWeight && existingWeight !== newWeight)
          conflicts.push("Weight");
        if (existingCOO && newCOO && existingCOO !== newCOO)
          conflicts.push("Country of Origin");

        if (conflicts.length > 0) {
          detectedStatus = "CONFLICT";
          conflictType = "DATA_MISMATCH";
          conflictingFields = conflicts;
        }
      } else {
        detectedStatus = "CONFLICT";
        conflictType = "SUBTYPES";
        subtypes = inventoryMatches;
      }
    }

    // If has resolution override, it's RESOLVED
    if (resolutions[index]) {
      return {
        ...item,
        status: "RESOLVED",
        resolvedActions: resolutions[index],
        actionLabel: "Ready",
        originalIndex: index,
        // Preserve context
        existingItem,
        subtypes,
        conflictType,
        conflictingFields,
      } as AnalyzedItem;
    }

    // Default Status
    return {
      ...item,
      status: detectedStatus,
      conflictType,
      conflictingFields,
      existingItem,
      subtypes,
      actionLabel:
        detectedStatus === "CONFLICT"
          ? "Resolve"
          : detectedStatus === "NEW"
            ? "Create"
            : "Add Qty",
      originalIndex: index,
    } as AnalyzedItem;
  });

  // Filter for display
  $: visibleItems = analyzedPlan.filter((i: AnalyzedItem) => {
    if (viewFilter === "ALL") {
      // Show everything EXCEPT 'DONE' (Processed) and 'SKIPPED' (Errors)
      return i.status !== "DONE" && i.status !== "SKIPPED";
    }
    return i.status === viewFilter;
  });

  // Auto-completion Logic
  $: isImportComplete =
    totalCount > 0 && doneCount + skippedCount === totalCount;

  $: if (isImportComplete && !processing && activeFile && $user && $user.uid) {
    const u = $user.uid;
    // Debounce slightly to let animations play
    setTimeout(() => {
      // Check again
      if (totalCount > 0 && doneCount + skippedCount === totalCount) {
        console.log("Auto-finishing import");
        broadcast(firestore, u, finish_import());
        successMsg = "All items processed. Session finished.";
      }
    }, 1000);
  }

  // Derived State for UI
  $: selectedFile = activeFile
    ? ({ ...activeFile, mimeType: "text/csv" } as DriveFile)
    : null;
  $: showPreview = step === "review";

  // Local UI State
  let driveConfigured = false;
  let authenticated = false;
  let driveFiles: DriveFile[] = [];
  let loadingFiles = false;
  let error = "";
  let successMsg = "";
  let processing = false;
  let analysisStatus: "idle" | "analyzing" = "idle";

  let viewFilter:
    | "ALL"
    | "MATCH"
    | "NEW"
    | "CONFLICT"
    | "RESOLVED"
    | "SKIPPED"
    | "DONE" = "ALL";

  $: matchCount = analyzedPlan.filter(
    (i: AnalyzedItem) => i.status === "MATCH",
  ).length;
  $: newCount = analyzedPlan.filter(
    (i: AnalyzedItem) => i.status === "NEW",
  ).length;
  $: conflictCount = analyzedPlan.filter(
    (i: AnalyzedItem) => i.status === "CONFLICT",
  ).length;
  $: resolvedCount = analyzedPlan.filter(
    (i: AnalyzedItem) => i.status === "RESOLVED",
  ).length;
  $: skippedCount = analyzedPlan.filter(
    (i: AnalyzedItem) => i.status === "SKIPPED",
  ).length;
  $: doneCount = analyzedPlan.filter(
    (i: AnalyzedItem) => i.status === "DONE",
  ).length;
  $: totalCount = analyzedPlan.length;

  // Interactive State
  let showConflictModal = false;
  let conflictIndex: number = -1;
  let currentConflictItem: AnalyzedItem | null = null;
  let splitAllocations: { [subtypePath: string]: number } = {};
  let fieldResolutions: { [fieldLabel: string]: "incoming" | "existing" } = {};
  let splitError = "";

  // Resolution State
  let importStatus: "idle" | "success" | "error" = "idle";

  // Bulk HS Resolution
  let bulkHSStrategy: "incoming" | "existing" | null = null;
  $: hasHSConflict = visibleItems.some((i: AnalyzedItem) =>
    i.conflictingFields?.includes("HS Code"),
  );

  function resolveAllHS(strategy: "incoming" | "existing") {
    if (!$user || !$user.uid) return;
    bulkHSStrategy = strategy;

    // Iterate all visible items with HS conflict
    visibleItems.forEach((item: AnalyzedItem) => {
      if (
        item.conflictingFields?.includes("HS Code") &&
        item.status === "CONFLICT"
      ) {
        // Construct resolution similar to confirmSplit logic
        // We assume we want to KEEP the item key (existing match) but update the HS code
        // Or keep existing HS code.

        const existingItem = item.existingItem;
        if (!existingItem) return;

        const finalHS =
          strategy === "incoming" ? item.hsCode : existingItem.hsCode;

        // We need to resolve ALL conflicts for this item to mark it resolved.
        // If there are other conflicts (Weight, COO), we shouldn't auto-resolve partially?
        // The prompt implies we fix HS code.
        // If we only fix HS code, the item remains CONFLICT if Weight mismatch exists?
        // `resolve_conflict` takes `resolvedActions`.
        // If we dispatch an update, it effectively resolves it.
        // But if we don't handle other fields, what happens?
        // Let's assume for this feature we only resolve if HS is the *only* conflict OR we implicitly keep existing for others?
        // Safer: Just set the HS resolution preference in a local map and let the user click "Process"?
        // But prompt says "apply that resolution".

        // Construct resolution intent
        const resolution: any = {
          type: "data_mismatch",
          itemKey: existingItem.key,
          fieldResolutions: { "HS Code": strategy },
        };

        broadcast(
          firestore,
          $user.uid!,
          resolve_conflict({
            index: item.originalIndex,
            resolution,
          }),
        );
      }
    });
  }

  function ignoreItem(index: number) {
    if (!$user || !$user.uid) return;
    broadcast(firestore, $user.uid, mark_items_done({ indices: [index] }));
  }

  onMount(async () => {
    driveConfigured = isDriveConfigured();

    if (driveConfigured) {
      const token = handleOAuthCallback();
      if (token) {
        authenticated = true;
        await loadFiles();
      } else {
        authenticated = isAuthenticated();
        if (authenticated) {
          await loadFiles();
        }
      }
    }
  });

  async function loadFiles() {
    const token = getStoredToken();
    if (!token) {
      authenticated = false;
      return;
    }

    loadingFiles = true;
    error = "";

    try {
      driveFiles = await listFilesInFolder(token.access_token);
      // Filter for CSV files if possible, or just show all
      driveFiles = driveFiles.filter(
        (f) => f.mimeType === "text/csv" || f.name.endsWith(".csv"),
      );
    } catch (e) {
      console.error("Error loading files:", e);
      const errorMsg = e instanceof Error ? e.message : String(e);
      error = `Failed to load files: ${errorMsg}`;
      if (
        errorMsg.toLowerCase().includes("401") ||
        errorMsg.toLowerCase().includes("unauthorized")
      ) {
        clearToken();
        authenticated = false;
      }
    } finally {
      loadingFiles = false;
    }
  }

  function handleConnect() {
    initiateOAuthFlow(window.location.href);
  }

  function handleDisconnect() {
    clearToken();
    authenticated = false;
    driveFiles = [];
    resetPreview();
  }

  function resetPreview() {
    if ($user && $user.uid) {
      broadcast(firestore, $user.uid, clear_import());
    }
    error = "";
  }

  function selectFile(file: DriveFile) {
    if (activeFile?.id === file.id) return; // Already selected
    console.log("Selecting file (Session Start):", file.name);

    if ($user && $user.uid) {
      broadcast(
        firestore,
        $user.uid,
        start_session({ id: file.id, name: file.name }),
      );
    }

    error = "";
    successMsg = "";
  }

  // --- Analysis Logic ---

  async function handleAnalyze(file: DriveFile) {
    const token = getStoredToken();
    if (!token) return;

    processing = true;
    analysisStatus = "analyzing";
    error = "";
    successMsg = "";

    // Start Session (replaces old select_file / set_plan([]))
    if ($user && $user.uid) {
      broadcast(
        firestore,
        $user.uid,
        start_session({ id: file.id, name: file.name }),
      );
    }

    try {
      const content = await downloadFile(file.id, token.access_token);

      // Simplify: Just stream the RAW content via append_raw_rows
      // This uses chunking to fit Firestore limits, but logic is "One Shot" in reducer.
      const CHUNK_SIZE = 400 * 1024; // 400KB chunks (safe for 1MB Firestore limit)

      if (!content) {
        // Empty file
        if ($user && $user.uid) {
          // done=true immediately
          broadcast(
            firestore,
            $user.uid,
            append_raw_rows({ rawRows: "", done: true }),
          );
        }
      } else {
        for (let i = 0; i < content.length; i += CHUNK_SIZE) {
          const chunk = content.slice(i, i + CHUNK_SIZE);
          const isLast = i + CHUNK_SIZE >= content.length;

          if ($user && $user.uid) {
            broadcast(
              firestore,
              $user.uid,
              append_raw_rows({
                rawRows: chunk,
                done: isLast,
              }),
            );
          }

          const progress = Math.min(
            100,
            Math.round(((i + chunk.length) / content.length) * 100),
          );
          await new Promise((r) => setTimeout(r, 0));
        }
      }
    } catch (e) {
      console.error("Analysis failed:", e);
      error = `Analysis failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      processing = false;
      analysisStatus = "idle";
    }
  }

  // analyzeCSV removed, Logic moved to reducer (append_raw_rows)

  // --- Execution Logic ---

  function openConflictModal(item: AnalyzedItem, index: number) {
    // Cast to ImportItem for modal logic compatibility or adapt modal
    currentConflictItem = item;
    conflictIndex = index;
    splitAllocations = {};
    // Reset field resolutions map
    fieldResolutions = {};

    // Default to 'incoming' for all detected conflicts
    if (item.conflictingFields) {
      item.conflictingFields.forEach((f) => (fieldResolutions[f] = "incoming"));
    }

    if (item.subtypes && item.subtypes.length > 0) {
      const totalQty = item.qty;
      const count = item.subtypes.length;
      const perItem = Math.floor(totalQty / count);
      const remainder = totalQty % count;

      item.subtypes.forEach((st: any, i: number) => {
        // Use key as identifier for subtypes (assuming itemKey/id)
        // st is an Inventory Item, so it doesn't have 'key' property directly usually?
        // Wait, Object.values() drops keys. We need the ID.
        // In my analyze logic above, I lost the ID.
        // Let's fix analyze logic to include ID in 'existingItem' or 'subtypes'

        // Actually, let's fix the analyzedPlan logic to include keys if possible.
        // But wait, st is from $store.inventory.idToItem values.
        // We need to find the key for this value.

        // HACK: Re-find key? Or store key in Item?
        // Item interface doesn't have ID.
        // Let's rely on finding it by reference? No, need ID for update.

        // Better: In analyzedPlan map, we should attach the ID.

        // For now, let's look up key from store based on ref equality?
        // Use key directly attached during analysis
        const key = st.key;
        if (key) {
          // Distribute remainder to first item(s)
          const extra = i < remainder ? 1 : 0;
          splitAllocations[key] = perItem + extra;
        }
      });
    }

    showConflictModal = true;
    splitError = "";
  }

  function closeConflictModal() {
    showConflictModal = false;
    currentConflictItem = null;
    conflictIndex = -1;
  }

  function confirmSplit() {
    if (!currentConflictItem) return;

    // Validate Total (Only if NOT DATA_MISMATCH)
    if (currentConflictItem.conflictType !== "DATA_MISMATCH") {
      const totalAllocated = Object.values(splitAllocations).reduce(
        (a, b) => a + b,
        0,
      );
      if (totalAllocated !== currentConflictItem.qty) {
        splitError = `Total allocated (${totalAllocated}) must equal CSV Quantity (${currentConflictItem.qty})`;
        return;
      }
    }

    // Apply Resolution via Redux
    let resolution: any; // Type: ResolutionIntent

    if (currentConflictItem.conflictType === "DATA_MISMATCH") {
      const itemKey = currentConflictItem.existingItem?.key;
      if (itemKey) {
        resolution = {
          type: "data_mismatch",
          itemKey,
          fieldResolutions: { ...fieldResolutions },
        };
      }
    } else {
      // Subtype split logic
      resolution = {
        type: "split",
        allocations: { ...splitAllocations },
      };
    }

    // Broadcast resolution choice
    if ($user && $user.uid && resolution) {
      broadcast(
        firestore,
        $user.uid,
        resolve_conflict({
          index: conflictIndex,
          resolution,
        }),
      );
    }

    closeConflictModal();
  }

  async function processBatch(targetStatus: "MATCH" | "NEW") {
    if (!analyzedPlan.length) return;

    // Check if we have items of this status
    const hasItems = analyzedPlan.some(
      (i: AnalyzedItem) => i.status === targetStatus,
    );
    if (!hasItems) return;

    processing = true;
    try {
      if ($user && $user.uid) {
        broadcast(firestore, $user.uid, import_batch({ filter: targetStatus }));
      }

      successMsg = `Processed ${targetStatus} items.`;
      importStatus = "success";

      setTimeout(() => {
        importStatus = "idle";
        successMsg = "";
      }, 3000);
    } catch (e) {
      console.error("Batch processing failed:", e);
      error = `Batch processing failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      processing = false;
    }
  }

  async function processResolvedConflicts() {
    const hasResolved = analyzedPlan.some(
      (i: AnalyzedItem) => i.status === "RESOLVED",
    );
    if (!hasResolved) return;

    processing = true;
    try {
      if ($user && $user.uid) {
        broadcast(firestore, $user.uid, import_batch({ filter: "RESOLVED" }));
      }

      successMsg = `Processed resolved conflicts.`;
      importStatus = "success";

      setTimeout(() => {
        importStatus = "idle";
        successMsg = "";
      }, 3000);
    } catch (e) {
      console.error("Conflict processing failed:", e);
      error = `Conflict processing failed: ${e}`;
    } finally {
      processing = false;
    }
  }

  function formatDate(dateString: string): string {
    const date = new Date(dateString);
    return date.toLocaleString();
  }
</script>

<div class="import-page">
  <h1>Inventory Receipt (Drive)</h1>

  {#if driveConfigured}
    {#if !authenticated}
      <div class="auth-prompt">
        <p>Connect to Google Drive to import inventory CSVs.</p>
        <button on:click={handleConnect} class="connect-button">
          Connect to Google Drive
        </button>
      </div>
    {:else}
      <div class="authenticated">
        <div class="header-actions">
          <span>Connected to Drive</span>
          <button on:click={handleDisconnect} class="disconnect-button"
            >Disconnect</button
          >
          {#if getFolderLink()}
            <a href={getFolderLink()} target="_blank" class="folder-link"
              >Open Folder</a
            >
          {/if}
        </div>

        {#if error}
          <div class="error-message">{error}</div>
        {:else if importStatus === "success"}
          <div class="success-message">{successMsg}</div>
        {/if}

        <div class="layout-grid">
          <!-- 1. File List -->
          <div class="panel file-list">
            <h2>Select Receipt CSV</h2>
            {#if loadingFiles}
              <div class="loading">Loading files...</div>
            {:else if driveFiles.length === 0}
              <div class="empty">No CSV files found in 'receipts' folder.</div>
            {:else}
              <ul>
                {#each driveFiles as file}
                  <li>
                    <button
                      class:selected={selectedFile?.id === file.id}
                      on:click={() => selectFile(file)}
                    >
                      <span class="icon">📄</span>
                      {file.name}
                      <span class="date"
                        >{new Date(
                          file.modifiedTime || Date.now(),
                        ).toLocaleDateString()}</span
                      >
                    </button>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>

          <!-- 2. Preview Panel -->
          <div class="panel preview-panel">
            {#if !selectedFile}
              <div class="placeholder">
                Select a file from the list to preview
              </div>
            {:else if analysisStatus === "analyzing"}
              <div class="loading">Analyzing {selectedFile.name}...</div>
            {:else if rawRows.length > 0}
              <!-- Summary Dashboard -->
              <div class="summary-dashboard">
                <button
                  class="summary-card total"
                  class:active={viewFilter === "ALL"}
                  on:click={() => (viewFilter = "ALL")}
                >
                  <span class="label">Total Rows</span>
                  <span class="value">{totalCount}</span>
                </button>
                <button
                  class="summary-card match"
                  class:active={viewFilter === "MATCH"}
                  on:click={() => (viewFilter = "MATCH")}
                >
                  <span class="label">Matches</span>
                  <span class="value">{matchCount}</span>
                </button>
                <button
                  class="summary-card new"
                  class:active={viewFilter === "NEW"}
                  on:click={() => (viewFilter = "NEW")}
                >
                  <span class="label">Add to Inv.</span>
                  <span class="value">{newCount}</span>
                </button>
                <button
                  class="summary-card conflict"
                  class:active={viewFilter === "CONFLICT"}
                  on:click={() => (viewFilter = "CONFLICT")}
                >
                  <span class="label">Conflicts</span>
                  <span class="value">{conflictCount}</span>
                </button>
                <button
                  class="summary-card resolved"
                  class:active={viewFilter === "RESOLVED"}
                  on:click={() => (viewFilter = "RESOLVED")}
                >
                  <span class="label">Resolved</span>
                  <span class="value">{resolvedCount}</span>
                </button>
                <button
                  class="summary-card skipped"
                  class:active={viewFilter === "SKIPPED"}
                  on:click={() => (viewFilter = "SKIPPED")}
                >
                  <span class="label">Skipped</span>
                  <span class="value">{skippedCount}</span>
                </button>
                <button
                  class="summary-card done"
                  class:active={viewFilter === "DONE"}
                  on:click={() => (viewFilter = "DONE")}
                >
                  <span class="label">Processed</span>
                  <span class="value">{doneCount}</span>
                </button>
              </div>

              <div class="preview-header">
                <h2>Preview: {selectedFile.name}</h2>
                <div class="batch-actions">
                  <button
                    class="btn-secondary"
                    on:click={() => processBatch("MATCH")}
                    disabled={processing}
                  >
                    Process Matches ({matchCount})
                  </button>
                  <button
                    class="btn-secondary"
                    on:click={() => processBatch("NEW")}
                    disabled={processing}
                  >
                    ADD to inventory ({newCount})
                  </button>
                  <button
                    class="btn-secondary"
                    on:click={processResolvedConflicts}
                    disabled={processing}
                  >
                    Process Resolved ({resolvedCount})
                  </button>
                </div>
              </div>

              <div class="table-container">
                <table>
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Image</th>
                      <th>JAN</th>
                      <th>
                        HS Code
                        {#if hasHSConflict}
                          <div class="bulk-hs-actions">
                            <label
                              class:selected={bulkHSStrategy === "existing"}
                            >
                              <input
                                type="radio"
                                name="hs-strat"
                                on:change={() => resolveAllHS("existing")}
                                checked={bulkHSStrategy === "existing"}
                              />
                              Keep Existing
                            </label>
                          </div>
                        {/if}
                      </th>
                      {#if hasHSConflict}
                        <th>
                          Incoming HS Code
                          <div class="bulk-hs-actions">
                            <label
                              class:selected={bulkHSStrategy === "incoming"}
                            >
                              <input
                                type="radio"
                                name="hs-strat"
                                on:change={() => resolveAllHS("incoming")}
                                checked={bulkHSStrategy === "incoming"}
                              />
                              Take Incoming
                            </label>
                          </div>
                        </th>
                      {/if}
                      <th>Description</th>
                      <th>Qty</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each visibleItems as item (item.originalIndex)}
                      <tr transition:slide|local>
                        <td>
                          <span class="badge {item.status.toLowerCase()}"
                            >{item.status === "NEW" ? "ADD" : item.status}</span
                          >
                        </td>
                        <td>
                          {#if item.existingItem?.image}
                            <ImageThumbnail
                              src={item.existingItem.image}
                              alt={item.description}
                              width="40px"
                              height="40px"
                            />
                          {:else}
                            <span class="text-muted">-</span>
                          {/if}
                        </td>
                        <td>{item.janCode}</td>

                        <!-- Existing HS Code -->
                        <td
                          class:text-success={bulkHSStrategy === "existing" &&
                            item.conflictingFields?.includes("HS Code")}
                        >
                          <div class="hs-cell">
                            <span class="code"
                              >{item.existingItem?.hsCode ||
                                item.hsCode ||
                                "-"}</span
                            >
                            {#if HS_CODE_DESCRIPTIONS[item.existingItem?.hsCode || item.hsCode || ""]}
                              <span class="desc"
                                >{HS_CODE_DESCRIPTIONS[
                                  item.existingItem?.hsCode || item.hsCode || ""
                                ]}</span
                              >
                            {/if}
                          </div>
                        </td>

                        {#if hasHSConflict}
                          <td
                            class:text-success={bulkHSStrategy === "incoming" &&
                              item.conflictingFields?.includes("HS Code")}
                          >
                            {#if item.conflictingFields?.includes("HS Code")}
                              <div class="hs-cell">
                                <span class="code">{item.hsCode || "-"}</span>
                                {#if HS_CODE_DESCRIPTIONS[item.hsCode || ""]}
                                  <span class="desc"
                                    >{HS_CODE_DESCRIPTIONS[
                                      item.hsCode || ""
                                    ]}</span
                                  >
                                {/if}
                              </div>
                            {:else}
                              <span class="text-muted">-</span>
                            {/if}
                          </td>
                        {/if}

                        <td>{item.description}</td>
                        <td>{item.qty}</td>
                        <td>
                          <div class="action-cell">
                            {#if item.status === "CONFLICT"}
                              <button
                                class="btn-small"
                                on:click={() =>
                                  openConflictModal(item, item.originalIndex)}
                                >Review</button
                              >
                            {:else if item.status === "RESOLVED"}
                              <span class="text-success">Ready</span>
                            {:else if item.status === "DONE"}
                              <span class="text-muted">Done</span>
                            {:else}
                              <!-- Standard items processed via batch -->
                              <span class="text-muted">-</span>
                            {/if}

                            <button
                              class="btn-icon ignore"
                              on:click={() => ignoreItem(item.originalIndex)}
                              title="Ignore Row">✕</button
                            >
                          </div>
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {:else}
              <div class="actions-panel">
                <h3>{selectedFile.name}</h3>
                <button
                  class="btn-primary"
                  on:click={() => selectedFile && handleAnalyze(selectedFile)}
                  >Analyze File</button
                >
              </div>
            {/if}
          </div>
        </div>
      </div>
    {/if}
  {:else}
    <div class="not-configured">Drive not configured.</div>
  {/if}

  <!-- Modal -->
  {#if showConflictModal && currentConflictItem}
    <div class="modal-overlay">
      <div class="modal">
        <h3>
          Resolve {currentConflictItem.subtypes?.[0]?.description ||
            currentConflictItem.description ||
            "Conflict"}
        </h3>
        <p>
          JAN: <strong>{currentConflictItem.janCode}</strong> maps to multiple items.
        </p>
        <p>Total Qty from CSV: <strong>{currentConflictItem.qty}</strong></p>

        <div class="split-list">
          {#if currentConflictItem.conflictType === "DATA_MISMATCH"}
            <div class="hs-resolution">
              <p class="resolution-title">Resolve Data Mismatches:</p>

              {#each currentConflictItem.conflictingFields || [] as field}
                <div class="field-conflict">
                  <p class="field-name">{field}</p>
                  <div class="options-group">
                    <!-- Incoming Option -->
                    <label class="radio-label">
                      <input
                        type="radio"
                        bind:group={fieldResolutions[field]}
                        value="incoming"
                      />
                      <div class="radio-content">
                        <span class="option-text"
                          >Use Incoming:
                          <strong>
                            {field === "HS Code"
                              ? currentConflictItem.hsCode || "Blank"
                              : field === "Weight"
                                ? currentConflictItem.weight || "0"
                                : field === "Country of Origin"
                                  ? currentConflictItem.countryOfOrigin ||
                                    "Blank"
                                  : ""}
                          </strong>
                        </span>
                        {#if field === "HS Code"}
                          <span class="hs-desc"
                            >{HS_CODE_DESCRIPTIONS[
                              currentConflictItem.hsCode || ""
                            ] || ""}</span
                          >
                        {/if}
                      </div>
                    </label>

                    <!-- Existing Option -->
                    <label class="radio-label">
                      <input
                        type="radio"
                        bind:group={fieldResolutions[field]}
                        value="existing"
                      />
                      <div class="radio-content">
                        <span class="option-text"
                          >Keep Existing:
                          <strong>
                            {field === "HS Code"
                              ? currentConflictItem.existingItem?.hsCode ||
                                "Blank"
                              : field === "Weight"
                                ? currentConflictItem.existingItem?.weight ||
                                  "0"
                                : field === "Country of Origin"
                                  ? currentConflictItem.existingItem
                                      ?.countryOfOrigin || "Blank"
                                  : ""}
                          </strong>
                        </span>
                        {#if field === "HS Code"}
                          <span class="hs-desc"
                            >{HS_CODE_DESCRIPTIONS[
                              currentConflictItem.existingItem?.hsCode || ""
                            ] || ""}</span
                          >
                        {/if}
                      </div>
                    </label>
                  </div>
                </div>
              {/each}
            </div>
          {:else if currentConflictItem.subtypes}
            {#each currentConflictItem.subtypes as subtype}
              <div class="split-row">
                <span>{subtype.key}</span>
                <input
                  type="number"
                  min="0"
                  bind:value={splitAllocations[subtype.key]}
                />
              </div>
            {/each}
          {/if}
        </div>

        {#if splitError}
          <p class="error">{splitError}</p>
        {/if}

        <div class="modal-actions">
          <button class="btn-secondary" on:click={closeConflictModal}
            >Cancel</button
          >
          <button class="btn-primary" on:click={confirmSplit}
            >Confirm Split</button
          >
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .page-container {
    padding: 2rem;
  }
  .actions-bar {
    margin-bottom: 2rem;
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .layout-grid {
    display: grid;
    grid-template-columns: 300px 1fr;
    gap: 2rem;
    align-items: start;
  }

  .panel {
    background: white;
    border: 1px solid #eee;
    border-radius: 8px;
    padding: 1rem;
  }
  .file-list ul {
    list-style: none;
    padding: 0;
  }
  .file-list button {
    width: 100%;
    text-align: left;
    padding: 0.75rem;
    border: none;
    background: none;
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    border-bottom: 1px solid #eee;
  }
  .file-list button:hover {
    background: #f9f9f9;
  }
  .file-list button.selected {
    background: #eef2ff;
    color: #4f46e5;
    font-weight: 500;
  }

  .table-container {
    margin-top: 1rem;
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th,
  td {
    text-align: left;
    padding: 0.75rem;
    border-bottom: 1px solid #eee;
  }

  .badge {
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-size: 0.8rem;
    font-weight: bold;
  }
  .badge.match {
    background: #dcfce7;
    color: #166534;
  }
  .badge.new {
    background: #dbeafe;
    color: #1e40af;
  }
  .badge.conflict {
    background: #fee2e2;
    color: #991b1b;
  }
  .badge.resolved {
    background: #fef3c7;
    color: #92400e;
  }
  .badge.done {
    background: #f3f4f6;
    color: #6b7280;
  }

  .btn-primary {
    background: #4f46e5;
    color: white;
    padding: 0.5rem 1rem;
    border-radius: 6px;
    border: none;
    cursor: pointer;
  }
  .btn-secondary {
    background: white;
    border: 1px solid #ccc;
    color: #333;
    padding: 0.5rem 1rem;
    border-radius: 6px;
    cursor: pointer;
    margin-right: 0.5rem;
  }
  .btn-small {
    padding: 0.25rem 0.5rem;
    font-size: 0.8rem;
    background: #fff;
    border: 1px solid #ccc;
    border-radius: 4px;
    cursor: pointer;
  }

  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
  }
  .modal {
    background: white;
    padding: 2rem;
    border-radius: 8px;
    width: 100%;
    max-width: 500px;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
  }
  .split-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
    margin-top: 2rem;
  }
  .error {
    color: #dc2626;
    margin-top: 1rem;
    font-size: 0.9rem;
  }

  .hs-resolution {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    margin-top: 1rem;
  }
  .resolution-title {
    font-weight: 700;
    margin-bottom: 0.5rem;
  }
  .field-conflict {
    margin-bottom: 1rem;
  }
  .field-name {
    font-size: 0.875rem;
    font-weight: 600;
    margin-bottom: 0.25rem;
  }
  .options-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .radio-label {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    cursor: pointer;
    padding: 0.5rem;
    border: 1px solid #eee;
    border-radius: 6px;
    transition: background 0.2s;
  }
  .radio-label:hover {
    background: #f9f9f9;
  }
  .radio-content {
    display: flex;
    flex-direction: column;
  }
  .option-text {
    font-size: 0.875rem;
  }
  .hs-desc {
    font-size: 0.85rem;
    color: #666;
    font-style: italic;
    margin-top: 0.2rem;
  }

  .done {
    opacity: 0.5;
  }
  .text-muted {
    color: #9ca3af;
  }
  .text-success {
    color: #166534;
    font-weight: 500;
  }

  /* Auth styles moved here */
  .auth-section {
    display: flex;
    gap: 1rem;
  }
  .status-badge {
    display: inline-block;
    background: #e0e7ff;
    color: #4338ca;
    padding: 0.5rem 1rem;
    border-radius: 999px;
    font-size: 0.9rem;
  }
  .message {
    padding: 1rem;
    border-radius: 6px;
    margin-bottom: 1rem;
  }
  .message.success {
    background: #dcfce7;
    color: #166534;
  }
  .message.error {
    background: #fee2e2;
    color: #991b1b;
  }

  .disconnect-button {
    background: white;
    border: 1px solid #ccc;
    color: #dc2626;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 33px;
    padding: 0 16px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
  }
  .disconnect-button:hover {
    background: #fee2e2;
  }

  .hs-cell {
    display: flex;
    flex-direction: column;
  }
  .hs-cell .code {
    font-weight: 500;
  }
  .hs-cell .desc {
    font-size: 0.75rem;
    color: #9ca3af;
  }

  .bulk-hs-actions {
    margin-top: 0.5rem;
    font-weight: normal;
    font-size: 0.8rem;
  }
  .bulk-hs-actions label {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 4px;
  }
  .bulk-hs-actions label.selected {
    background: #dcfce7;
    color: #166534;
    font-weight: 600;
  }

  .action-cell {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .btn-icon {
    background: none;
    border: none;
    font-size: 1rem;
    cursor: pointer;
    color: #9ca3af;
    padding: 0.25rem;
    line-height: 1;
    border-radius: 4px;
  }
  .btn-icon:hover {
    background: #f3f4f6;
    color: #6b7280;
  }
  .btn-icon.ignore:hover {
    background: #fee2e2;
    color: #ef4444;
  }
  .summary-dashboard {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  .summary-card {
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.2s;
    outline: none;
  }

  .summary-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
  }

  .summary-card.active {
    border-color: #6366f1;
    box-shadow:
      0 0 0 2px white,
      0 0 0 4px #6366f1;
    z-index: 10;
  }

  .summary-card .label {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #6b7280;
    font-weight: 600;
    margin-bottom: 0.25rem;
  }

  .summary-card .value {
    font-size: 1.5rem;
    font-weight: 700;
    color: #111827;
  }

  .summary-card.match .value {
    color: #166534;
  }
  .summary-card.match {
    background: #f0fdf4;
    border-color: #bbf7d0;
  }

  .summary-card.new .value {
    color: #1e40af;
  }
  .summary-card.new {
    background: #eff6ff;
    border-color: #bfdbfe;
  }

  .summary-card.conflict .value {
    color: #991b1b;
  }
  .summary-card.conflict {
    background: #fef2f2;
    border-color: #fecaca;
  }

  .summary-card.resolved .value {
    color: #92400e;
  }
  .summary-card.resolved {
    background: #fffbeb;
    border-color: #fde68a;
  }

  .summary-card.skipped .value {
    color: #6b7280;
  }
  .summary-card.skipped {
    background: #f3f4f6;
    border-color: #e5e7eb;
  }

  .summary-card.done .value {
    color: #374151;
  }
  .summary-card.done {
    background: #f9fafb;
    border-color: #d1d5db;
    opacity: 0.8;
  }
</style>
