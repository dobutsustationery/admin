<script lang="ts">
  import { onMount } from "svelte";
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
  import { get } from "svelte/store";
  import { user } from "$lib/user-store";
  import { firestore } from "$lib/firebase";
  import { new_order } from "$lib/inventory";
  import { broadcast } from "$lib/redux-firestore";
  import Papa from "papaparse";
  import { update_item } from "$lib/inventory";

  // --- Types ---
  interface ImportItem {
    janCode: string;
    description: string;
    qty: number;
    carton: string;
    // Analysis results
    status: "MATCH" | "NEW" | "CONFLICT" | "RESOLVED" | "DONE";
    existingItem?: any; // The Item from inventory if match
    subtypes?: any[]; // List of items if conflict
    actionLabel: string;
    resolvedActions?: any[];
  }

  // --- State ---
  let driveConfigured = false;
  let authenticated = false;
  let driveFiles: DriveFile[] = [];
  let loadingFiles = false;
  let error = "";
  let successMsg = "";
  let processing = false;

  let selectedFile: DriveFile | null = null;
  let importPlan: ImportItem[] = [];
  let showPreview = false;
  let analysisStatus: "idle" | "analyzing" = "idle"; // Added

  // Interactive State
  let showConflictModal = false;
  let currentConflictItem: any = null;
  let splitAllocations: { [subtypePath: string]: number } = {};
  let splitError = "";

  // Resolution State
  let importStatus: "idle" | "success" | "error" = "idle";
  let importMessage = "";

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
    initiateOAuthFlow();
  }

  function handleDisconnect() {
    clearToken();
    authenticated = false;
    driveFiles = [];
    resetPreview();
  }

  function resetPreview() {
    selectedFile = null;
    importPlan = [];
    showPreview = false;
    error = "";
    // Do not clear successMsg here, as we might want to show it after success
  }
  function selectFile(file: DriveFile) {
    console.log("Selecting file:", file.name);
    selectedFile = file;
    importPlan = [];
    showPreview = false;
    error = "";
    successMsg = "";
  }

  // --- Analysis Logic ---

  async function handleAnalyze(file: DriveFile) {
    const token = getStoredToken();
    if (!token) return;

    processing = true;
    analysisStatus = "analyzing"; // Updated
    error = "";
    successMsg = "";
    selectedFile = file;

    try {
      const content = await downloadFile(file.id, token.access_token);
      importPlan = analyzeCSV(content);
      showPreview = true;
    } catch (e) {
      console.error("Analysis failed:", e);
      error = `Analysis failed: ${e instanceof Error ? e.message : String(e)}`;
      selectedFile = null;
    } finally {
      processing = false;
      analysisStatus = "idle"; // Updated
    }
  }

  function analyzeCSV(content: string): ImportItem[] {
    const parsed = Papa.parse(content, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase(), // jan code, total pcs, description
    });

    if (parsed.errors && parsed.errors.length > 0) {
      console.warn("CSV Parse Errors:", parsed.errors);
    }

    const plan: ImportItem[] = [];
    const invState = $store.inventory; // Access global inventory state

    parsed.data.forEach((row: any) => {
      // Map columns from sample
      // JAN CODE, TOTAL PCS, DESCRIPTION, Carton Number
      const janCode = (row["jan code"] || row["code"] || "").trim();
      if (!janCode) return; // Skip empty rows

      const qty = parseInt(
        (row["total pcs"] || row["qty"] || "0").replace(/,/g, ""),
        10,
      );
      const description = row["description"] || "";
      const carton = row["carton number"] || "";

      // Logic: Lookup in inventory
      // We need to find items by JAN. Inventory is keyed by itemKey (jan+subtype).
      // So we iterate. (Optimization: Build map once if slow)
      const matches: any[] = [];
      for (const key in invState.idToItem) {
        const item = invState.idToItem[key];
        if (item.janCode === janCode) {
          console.log(
            "DEBUG MATCH FOUND:",
            janCode,
            "matched with",
            item.janCode,
            "ID:",
            key,
          );
          matches.push({ key, ...item });
        }
      }

      let status: "MATCH" | "NEW" | "CONFLICT" = "NEW";
      let existingItem = undefined;
      let subtypes = undefined;
      let actionLabel = "Create Draft Item";

      if (matches.length === 1) {
        status = "MATCH";
        existingItem = matches[0];
        actionLabel = `Add ${qty} to stock`;
      } else if (matches.length > 1) {
        status = "CONFLICT";
        subtypes = matches;
        actionLabel = `Split ${qty} amongst ${matches.length} subtypes`;
      }

      plan.push({
        janCode,
        description,
        qty,
        carton,
        status,
        existingItem,
        subtypes,
        actionLabel,
      });
    });

    return plan;
  }

  // --- Execution Logic ---

  function openConflictModal(item: any) {
    currentConflictItem = item;
    splitAllocations = {};

    if (item.subtypes && item.subtypes.length > 0) {
      const totalQty = item.qty;
      const count = item.subtypes.length;
      const perItem = Math.floor(totalQty / count);
      const remainder = totalQty % count;

      item.subtypes.forEach((st: any, index: number) => {
        // Distribute remainder to first item(s)
        const extra = index < remainder ? 1 : 0;
        splitAllocations[st.key] = perItem + extra;
      });
    }

    showConflictModal = true;
    splitError = "";
  }

  function closeConflictModal() {
    showConflictModal = false;
    currentConflictItem = null;
  }

  function confirmSplit() {
    if (!currentConflictItem) return;

    // Validate Total
    const totalAllocated = Object.values(splitAllocations).reduce(
      (a, b) => a + b,
      0,
    );
    if (totalAllocated !== currentConflictItem.qty) {
      splitError = `Total allocated (${totalAllocated}) must equal CSV Quantity (${currentConflictItem.qty})`;
      return;
    }

    // Apply Resolution
    // We transform this Conflict item into a "Resolved" state
    // We will store the ready-to-execute actions directly on the item
    currentConflictItem.status = "RESOLVED";
    currentConflictItem.resolvedActions = Object.entries(splitAllocations)
      .filter(([_, qty]) => qty > 0)
      .map(([path, qty]) => ({
        type: "update_item",
        payload: {
          itemKey: path,
          qty: qty,
        },
      }));

    // Force reactivity
    importPlan = [...importPlan];
    closeConflictModal();
  }

  async function processBatch(targetStatus: "MATCH" | "NEW") {
    if (!importPlan.length) return;

    const itemsToProcess = importPlan.filter((i) => i.status === targetStatus);
    if (itemsToProcess.length === 0) return;

    processing = true;
    let count = 0;

    try {
      // Dispatch loops
      for (const item of itemsToProcess) {
        if (item.status === "MATCH" && item.existingItem) {
          // Determine item ID. In analysis we used `key`.
          const itemKey = item.existingItem.key;
          const payloadItem = {
            ...item.existingItem,
            qty: item.qty, // Delta
          };

          if ($user && $user.uid) {
            broadcast(
              firestore,
              $user.uid,
              update_item({
                id: itemKey,
                item: payloadItem,
              }),
            );
            count++;
          }
        } else if (item.status === "NEW") {
          // Create New Item logic
          const newItemKey = item.janCode;
          const newItem = {
            janCode: item.janCode,
            subtype: "",
            description: item.description,
            hsCode: "",
            image: "",
            qty: item.qty,
            pieces: 1,
            shipped: 0,
            creationDate: new Date().toISOString(),
          };

          if ($user && $user.uid) {
            broadcast(
              firestore,
              $user.uid,
              update_item({
                id: newItemKey,
                item: newItem,
              }),
            );
            count++;
          }
        }
        item.status = "DONE"; // Mark as processed
      }

      importPlan = [...importPlan];
      successMsg = `Successfully processed ${count} items.`;
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
    const resolved = importPlan.filter((i) => i.status === "RESOLVED");
    if (resolved.length === 0) return;

    processing = true;
    let count = 0;

    try {
      for (const item of resolved) {
        if (item.resolvedActions && $user && $user.uid) {
          item.resolvedActions.forEach((action: any) => {
            // action.payload has itemKey and qty
            // We need the full item? Wait, update_item in reducer needs full item structure if simple update?
            // The reducer: state.idToItem[id] = { ...action.payload.item ... qty: action.payload.item.qty + qty }
            // So we need to fetch the existing item again or store it?
            // We have the path (key) in the payload. We can look it up in $store.inventory.

            const currentInvItem =
              $store.inventory.idToItem[action.payload.itemKey];
            if (currentInvItem) {
              const payloadItem = {
                ...currentInvItem,
                qty: action.payload.qty,
              };
              broadcast(
                firestore,
                $user.uid!,
                update_item({
                  id: action.payload.itemKey,
                  item: payloadItem,
                }),
              );
            }
          });
        }
        item.status = "DONE";
        count++;
      }
      importPlan = [...importPlan];
      successMsg = `Successfully processed ${count} resolved conflicts.`;
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
        {/if}
        {#if successMsg}
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
            {:else if importPlan.length > 0}
              <div class="preview-header">
                <h2>Preview: {selectedFile.name}</h2>
                <div class="batch-actions">
                  <button
                    class="btn-secondary"
                    on:click={() => processBatch("MATCH")}
                    disabled={processing}
                  >
                    Process Matches ({importPlan.filter(
                      (i) => i.status === "MATCH",
                    ).length})
                  </button>
                  <button
                    class="btn-secondary"
                    on:click={() => processBatch("NEW")}
                    disabled={processing}
                  >
                    Create New ({importPlan.filter((i) => i.status === "NEW")
                      .length})
                  </button>
                  <button
                    class="btn-secondary"
                    on:click={processResolvedConflicts}
                    disabled={processing}
                  >
                    Process Resolved ({importPlan.filter(
                      (i) => i.status === "RESOLVED",
                    ).length})
                  </button>
                </div>
              </div>

              <div class="table-container">
                <table>
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>JAN</th>
                      <th>Description</th>
                      <th>Qty</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each importPlan as item}
                      <tr class:done={item.status === "DONE"}>
                        <td>
                          <span class="badge {item.status.toLowerCase()}"
                            >{item.status}</span
                          >
                        </td>
                        <td>{item.janCode}</td>
                        <td>{item.description}</td>
                        <td>{item.qty}</td>
                        <td>
                          {#if item.status === "CONFLICT"}
                            <button
                              class="btn-small"
                              on:click={() => openConflictModal(item)}
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
        <h3>Resolve Conflict</h3>
        <p>
          JAN: <strong>{currentConflictItem.janCode}</strong> maps to multiple items.
        </p>
        <p>Total Qty from CSV: <strong>{currentConflictItem.qty}</strong></p>

        <div class="split-list">
          {#if currentConflictItem.subtypes}
            {#each currentConflictItem.subtypes as subtype}
              <div class="split-row">
                <span
                  >{subtype.description ||
                    subtype.subtype ||
                    subtype.janCode}</span
                >
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
    padding: 0.5rem 1rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9rem;
  }
  .disconnect-button:hover {
    background: #fee2e2;
  }
</style>
