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
    status: "MATCH" | "NEW" | "CONFLICT";
    existingItem?: any; // The Item from inventory if match
    subtypes?: any[];   // List of items if conflict
    actionLabel: string;
  }

  // --- State ---
  let driveConfigured = false;
  let authenticated = false;
  let driveFiles: DriveFile[] = [];
  let loadingFiles = false;
  let error = "";
  let successMsg = "";
  let processing = false;

  // Analysis State
  let selectedFile: DriveFile | null = null;
  let importPlan: ImportItem[] = [];
  let showPreview = false;

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

  // --- Analysis Logic ---

  async function handleAnalyze(file: DriveFile) {
    const token = getStoredToken();
    if (!token) return;

    processing = true;
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
    }
  }

  function analyzeCSV(content: string): ImportItem[] {
    const parsed = Papa.parse(content, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase() // jan code, total pcs, description
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

      const qty = parseInt((row["total pcs"] || row["qty"] || "0").replace(/,/g, ""), 10);
      const description = row["description"] || "";
      const carton = row["carton number"] || "";

      // Logic: Lookup in inventory
      // We need to find items by JAN. Inventory is keyed by itemKey (jan+subtype).
      // So we iterate. (Optimization: Build map once if slow)
      const matches: any[] = [];
      for (const key in invState.idToItem) {
        const item = invState.idToItem[key];
        if (item.janCode === janCode) {
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
        actionLabel
      });
    });

    return plan;
  }

  // --- Execution Logic ---

  async function confirmImport() {
    if (!selectedFile) return;
    if (!confirm(`Confirm import of ${importPlan.length} items from ${selectedFile.name}?`)) return;

    processing = true;
    error = "";
    successMsg = "";

    try {
        let count = 0;
        
        // Dispatch actions for each item in the plan
        for (const item of importPlan) {
            if (item.qty === 0) continue;

            // TODO: Group by Carton? For now, we update item directly as per design doc goal "Receipt"
            // The Design Doc mentions "UPDATE_INVENTORY(id, quantity)" -> update_item

            if (item.status === "MATCH" && item.existingItem) {
                // Update existing
                // update_item expects { id, item }
                // We need to construct the full item object. 
                // Wait, update_item REPLACES the item or updates fields? 
                // Checking reducer: `state.idToItem[id] = { ...action.payload.item ... qty: action.payload.item.qty + qty }`
                // It ADDS the payload qty to existing qty.
                
                // We shouldn't need to pass the whole item if we just want to add qty, 
                // but the reducer implementation of `update_item` seems to merge/add.
                // It says: `qty = action.payload.item.qty + qty`.
                // So if we pass an item with qty=X, it adds X to existing.
                
                const payloadItem = {
                    ...item.existingItem,
                    qty: item.qty, // This is the DELTA to add
                    // Preserve other fields? The reducer merges `...action.payload.item`.
                    // It overwrites fields present in payload.
                };

                // We must be careful not to overwrite description/etc with CSV data if it's worse.
                // But for "Receipt", likely we want to add qty.
                // Ideally we'd have a specific `add_stock` action, but `update_item` seems to be the one used.
                
                if ($user && $user.uid) {
                    broadcast(firestore, $user.uid, update_item({
                        id: item.existingItem.key,
                        item: payloadItem
                    }));
                    count++;
                }

            } else if (item.status === "NEW") {
                // Create new draft
                // We need a key. usually JAN + subtype. Subtype is empty for new?
                const newItemKey = item.janCode; // Assuming no subtype for raw import
                
                const newItem = {
                    janCode: item.janCode,
                    subtype: "",
                    description: item.description,
                    hsCode: "", // Unknown
                    image: "",
                    qty: item.qty, // Initial qty
                    pieces: 1,
                    shipped: 0,
                    creationDate: new Date().toISOString()
                };

                if ($user && $user.uid) {
                    broadcast(firestore, $user.uid, update_item({
                        id: newItemKey,
                        item: newItem
                    }));
                    count++;
                }

            } else if (item.status === "CONFLICT" && item.subtypes) {
                // Split qty logic
                const countSub = item.subtypes.length;
                const splitQty = Math.floor(item.qty / countSub);
                const remainder = item.qty % countSub;

                // Distribute
                item.subtypes.forEach((sub: any, idx: number) => {
                    const add = splitQty + (idx < remainder ? 1 : 0);
                    if (add > 0 && $user && $user.uid) {
                        const payloadItem = {
                            ...sub,
                            qty: add
                        };
                         broadcast(firestore, $user.uid, update_item({
                            id: sub.key,
                            item: payloadItem
                        }));
                    }
                });
                count++;
            }
        }

        successMsg = `Successfully processed ${count} entries.`;
        resetPreview(); // Clear preview on success
        await loadFiles(); // Refresh file list? Or just stay
    } catch(e) {
        console.error("Import failed:", e);
        error = `Import failed: ${e instanceof Error ? e.message : String(e)}`;
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

        {#if !showPreview}
            <!-- File List -->
            <div class="file-list">
            <h3>Select Invoice/Packing List</h3>
            {#if loadingFiles}
                <p>Loading...</p>
            {:else if driveFiles.length === 0}
                <p>No CSV files found in the configured folder.</p>
            {:else}
                <table class="files-table">
                <thead>
                    <tr>
                    <th>Name</th>
                    <th>Date Modified</th>
                    <th>Action</th>
                    </tr>
                </thead>
                <tbody>
                    {#each driveFiles as file}
                    <tr>
                        <td>{file.name}</td>
                        <td>{formatDate(file.modifiedTime)}</td>
                        <td>
                        <button
                            on:click={() => handleAnalyze(file)}
                            disabled={processing}
                            class="import-button"
                        >
                            Analyze
                        </button>
                        </td>
                    </tr>
                    {/each}
                </tbody>
                </table>
            {/if}
            </div>
        {:else}
            <!-- Preview UI -->
            <div class="preview-section">
                <div class="preview-header">
                    <h3>Preview: {selectedFile?.name}</h3>
                    <div class="preview-actions">
                        <button class="cancel-button" on:click={resetPreview} disabled={processing}>Cancel</button>
                        <button class="confirm-button" on:click={confirmImport} disabled={processing}>
                            {processing ? 'Importing...' : 'Confirm Receipt'}
                        </button>
                    </div>
                </div>

                <div class="preview-summary">
                    <span>Total Rows: {importPlan.length}</span>
                    <span>Total Qty: {importPlan.reduce((acc, i) => acc + i.qty, 0)}</span>
                </div>

                <table class="preview-table">
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
                            <tr class="row-{item.status.toLowerCase()}">
                                <td>
                                    <span class="status-badge status-{item.status.toLowerCase()}">
                                        {item.status}
                                    </span>
                                </td>
                                <td>{item.janCode}</td>
                                <td>{item.description}</td>
                                <td>{item.qty}</td>
                                <td>{item.actionLabel}</td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
            </div>
        {/if}
      </div>
    {/if}
  {:else}
    <div class="not-configured">Drive not configured.</div>
  {/if}
</div>

<style>
  .import-page {
    padding: 20px;
    max-width: 1200px;
    margin: 0 auto;
  }
  .connect-button {
    background: #4285f4;
    color: white;
    padding: 10px 20px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }
  .disconnect-button {
    background: #f44336;
    color: white;
    padding: 5px 10px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    margin-left: 10px;
  }
  .import-button, .confirm-button {
    background: #4caf50;
    color: white;
    padding: 8px 16px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
  }
  .cancel-button {
    background: #9e9e9e;
    color: white;
    padding: 8px 16px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
    margin-right: 10px;
  }
  .import-button:disabled, .confirm-button:disabled, .cancel-button:disabled {
    background: #ccc;
    cursor: not-allowed;
  }
  .files-table, .preview-table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 20px;
  }
  .files-table th, .files-table td, .preview-table th, .preview-table td {
    padding: 12px;
    border-bottom: 1px solid #ddd;
    text-align: left;
  }
  .files-table th, .preview-table th {
    background-color: #f5f5f5;
  }
  .error-message {
    background: #ffebee;
    color: #c62828;
    padding: 10px;
    margin: 10px 0;
    border-radius: 4px;
  }
  .success-message {
    background: #e8f5e9;
    color: #2e7d32;
    padding: 10px;
    margin: 10px 0;
    border-radius: 4px;
  }
  .header-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 20px;
  }
  .folder-link {
    margin-left: auto;
  }
  
  /* Preview Styles */
  .preview-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
  }
  .status-badge {
      padding: 4px 8px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: bold;
      color: white;
  }
  .status-match { background-color: #4caf50; }
  .status-new { background-color: #2196f3; }
  .status-conflict { background-color: #ff9800; }
  
  .row-new { background-color: #e3f2fd; }
  .row-conflict { background-color: #fff3e0; }
</style>
