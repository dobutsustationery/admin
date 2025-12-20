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
    type RawRow,
    type ImportItem
  } from "$lib/order-import-slice";
  import { HS_CODE_DESCRIPTIONS } from "$lib/hscodes";
  
  import { user } from "$lib/user-store";
  import { firestore } from "$lib/firebase";
  import { broadcast } from "$lib/redux-firestore";
  import { update_item, bulk_import_items } from "$lib/inventory";
  import Papa from "papaparse";

  // --- State from Redux ---
  $: activeFile = $store.orderImport.activeFile;
  $: rawRows = $store.orderImport.rows;
  $: step = $store.orderImport.step;
  $: resolutions = $store.orderImport.resolutions || {};

  // --- Derived Analysis ---
  // We re-compute the "Plan" view dynamically based on current Inventory
  // This replaces the static "status" field in ImportItem
  
  interface AnalyzedItem extends ImportItem {
      status: "MATCH" | "NEW" | "CONFLICT" | "RESOLVED" | "DONE";
      existingItem?: any;
      subtypes?: any[];
      actionLabel: string;
      resolvedActions?: any[];
      conflictType?: "HS_MISMATCH" | "SUBTYPES";
      originalIndex: number; // For keying in #each
  }

  $: analyzedPlan = rawRows.map((rawRow: RawRow, index: number) => {
      // Logic runs on parsed data found in the row
      const item = rawRow.parsed;
      
      if (!item) {
          // Parsing error row
          return {
             status: "DONE", // Treat error rows as inert/done for now or add ERROR status
             janCode: "ERROR",
             description: rawRow.error || "Parse Error",
             qty: 0,
             carton: "",
             actionLabel: "Error",
             originalIndex: index
          } as AnalyzedItem;
      }

      // If processed, it's DONE
      if (item.processed || rawRow.processed) {
          return { ...item, status: "DONE", actionLabel: "Done", originalIndex: index } as AnalyzedItem;
      }
      
      // If has resolution override, it's RESOLVED
      if (resolutions[index]) {
          return { 
              ...item, 
              status: "RESOLVED", 
              resolvedActions: resolutions[index],
              actionLabel: "Ready",
              originalIndex: index
          } as AnalyzedItem;
      }

      // Compute Match/New/Conflict against LIVE inventory
      const JAN = item.janCode; 
      
      // 1. Check for exact matches (including subtypes if JAN implies them?)
      // Actually the previous logic was complex. Let's look at how we find items.
      // We search inventory for items starting with JAN?
      
      const candidates = Object.values($store.inventory.idToItem).filter((inv: any) => 
          inv.janCode === JAN || inv.janCode === JAN + inv.subtype // Simplified logic assumption
      );
      
      // Ideally we rely on the previous logic's finding mechanism.
      // Let's implement a simple finder:
      // Subtypes logic in this app seems to be: Key = JAN + Subtype.
      
      // Let's filter idToItem where keys start with JAN? or properties match?
      // Reusing logic from previous analyzeCSV would be good but that was "run once".
      // Here we run it reactive. Efficiency warning: Mapping over 1000 items on every store change is heavy.
      // Optimization: Only re-run if inventory or plan changes. Svelte $: does this.
      
      // Let's replicate the "find" logic here.
      
      // Case A: Exact JAN match (no subtype)
      // Case B: JAN match with subtypes existing
      
      // Find all items in inventory that share this JAN
      const inventoryMatches = Object.entries($store.inventory.idToItem)
          .filter(([k, i]: [string, any]) => i.janCode === JAN)
          .map(([k, i]: [string, any]) => ({ ...i, key: k })); // Preserve key for modal usage

      if (inventoryMatches.length === 0) {
          return { ...item, status: "NEW", actionLabel: "Create", originalIndex: index } as AnalyzedItem;
      }
      
      if (inventoryMatches.length === 1) {
          // One match. Is it a simple item or one subtype? 
          // If it matches perfectly?
          // Check for HS Code Mismatch
          const existingHS = (inventoryMatches[0] as any).hsCode;
          const newHS = item.hsCode;
          
          if (existingHS && newHS && existingHS !== newHS) {
               return {
                  ...item,
                  status: "CONFLICT",
                  conflictType: "HS_MISMATCH",
                  existingItem: inventoryMatches[0],
                  actionLabel: "Resolve HS",
                  originalIndex: index
               } as AnalyzedItem;
          }

          return { 
              ...item, 
              status: "MATCH", 
              existingItem: inventoryMatches[0], // Now has 'key'
              actionLabel: "Add Qty",
              originalIndex: index
          } as AnalyzedItem;
      }
      
      // Multiple matches -> Conflict (ambiguous target)
      return {
          ...item,
          status: "CONFLICT",
          subtypes: inventoryMatches, // Now has 'key'
          actionLabel: "Resolve",
          originalIndex: index
      } as AnalyzedItem;
  });

  // Filter for display
  $: visibleItems = analyzedPlan.filter((i: AnalyzedItem) => i.status !== "DONE");

  // Auto-completion Logic
  $: allDone = analyzedPlan.length > 0 && visibleItems.length === 0;

  $: if (allDone && !processing && activeFile && $user && $user.uid) {
       const u = $user.uid;
       // Debounce slightly to let animations play
       setTimeout(() => {
           // Check again
           if (analyzedPlan.length > 0 && visibleItems.length === 0) {
               console.log("Auto-finishing import");
               broadcast(firestore, u, finish_import());
               successMsg = "All items processed. Session finished.";
           }
       }, 1000);
  }
  
  // Derived State for UI
  $: selectedFile = activeFile ? { ...activeFile, mimeType: 'text/csv' } as DriveFile : null;
  $: showPreview = step === 'review';



  // Local UI State
  let driveConfigured = false;
  let authenticated = false;
  let driveFiles: DriveFile[] = [];
  let loadingFiles = false;
  let error = "";
  let successMsg = "";
  let processing = false;
  let analysisStatus: "idle" | "analyzing" = "idle";

  $: matchCount = analyzedPlan.filter((i: AnalyzedItem) => i.status === "MATCH").length;
  $: newCount = analyzedPlan.filter((i: AnalyzedItem) => i.status === "NEW").length;
  $: resolvedCount = analyzedPlan.filter((i: AnalyzedItem) => i.status === "RESOLVED").length;

  // Interactive State
  let showConflictModal = false;
  let conflictIndex: number = -1;
  let currentConflictItem: AnalyzedItem | null = null;
  let splitAllocations: { [subtypePath: string]: number } = {};
  let selectedHSResolution: "incoming" | "existing" = "incoming";
  let splitError = "";

  // Resolution State
  let importStatus: "idle" | "success" | "error" = "idle";


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
    if ($user && $user.uid) {
        broadcast(firestore, $user.uid, clear_import());
    }
    error = "";
  }

  function selectFile(file: DriveFile) {
    if (activeFile?.id === file.id) return; // Already selected
    console.log("Selecting file (Session Start):", file.name);
    
    if ($user && $user.uid) {
        broadcast(firestore, $user.uid, start_session({ id: file.id, name: file.name }));
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
         broadcast(firestore, $user.uid, start_session({ id: file.id, name: file.name }));
    }

    try {
      const content = await downloadFile(file.id, token.access_token);
      
      // Split content into lines. 
      // Careful with Windows CRLF vs LF. .split(/\r?\n/) handles both.
      const allLines = content.split(/\r?\n/).filter(line => line.trim() !== "");
      
      if (allLines.length === 0) {
          throw new Error("File is empty");
      }
      
      const header = allLines[0];
      const bodyLines = allLines.slice(1);
      
      // 1. Send Header
      if ($user && $user.uid) {
          broadcast(firestore, $user.uid, set_header(header));
      }
      
      // 2. Stream Body in chunks
      const CHUNK_SIZE = 100;
      
      if (bodyLines.length === 0) {
           // Header only
           if ($user && $user.uid) {
                broadcast(firestore, $user.uid, append_raw_rows({ rawRows: [], done: true }));
           }
      } else {
          for (let i = 0; i < bodyLines.length; i += CHUNK_SIZE) {
              const chunk = bodyLines.slice(i, i + CHUNK_SIZE);
              const isLast = i + CHUNK_SIZE >= bodyLines.length;
              
              if ($user && $user.uid) {
                broadcast(firestore, $user.uid, append_raw_rows({ 
                    rawRows: chunk, 
                    done: isLast 
                }));
              }
              
              const progress = Math.min(100, Math.round(((i + chunk.length) / bodyLines.length) * 100));
              
              // Small yield
              await new Promise(r => setTimeout(r, 0));
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
    selectedHSResolution = "incoming"; // Default to incoming

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

    // Validate Total (Only if NOT HS_MISMATCH)
    if (currentConflictItem.conflictType !== "HS_MISMATCH") {
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
    let resolvedActions: any[] = [];
    
    if (currentConflictItem.conflictType === "HS_MISMATCH") {
        // Validation not really needed for radio choice, but ensuring key exists
         const itemKey = currentConflictItem.existingItem?.key;
         if (itemKey) {
             resolvedActions.push({
                 type: "update_item",
                 payload: {
                     itemKey: itemKey,
                     qty: currentConflictItem.qty,
                     hsCode: selectedHSResolution === "incoming" ? currentConflictItem.hsCode : currentConflictItem.existingItem.hsCode
                 }
             });
         }
    } else {
        // Subtype split logic
        resolvedActions = Object.entries(splitAllocations)
          .filter(([_, qty]) => qty > 0)
          .map(([path, qty]) => ({
            type: "update_item",
            payload: {
              itemKey: path,
              qty: qty,
            },
          }));
    }
    
    // Broadcast resolution choice
    if ($user && $user.uid) {
        broadcast(firestore, $user.uid, resolve_conflict({ 
            index: conflictIndex, 
            resolvedActions 
        }));
    }

    closeConflictModal();
  }

  async function processBatch(targetStatus: "MATCH" | "NEW") {
    if (!analyzedPlan.length) return;

    // Use analyzedPlan to filter
    const itemsToProcessWithType = analyzedPlan
        .map((item: AnalyzedItem, index: number) => ({ item, index }))
        .filter(({ item }: { item: AnalyzedItem }) => item.status === targetStatus);
        
    if (itemsToProcessWithType.length === 0) return;

    processing = true;
    const indicesToMarkDone: number[] = [];
    
    // BULK ACTION CONSTRUCTION
    const bulkUpdates: Array<{type: "new"|"update", id: string, item: any}> = [];

    try {
      for (const { item, index } of itemsToProcessWithType) {
        if (item.status === "MATCH" && item.existingItem) {
          // Find Key again (since we didn't store it perfectly in AnalyzedItem yet, 
          // or we rely on the logic that found it). 
          // Ideally we fix AnalyzedItem to have 'id' on existingItem.
          // For now:
          // Use key directly attached during analysis
          const itemKey = item.existingItem?.key;
          
          if (itemKey) {
            const existHS = item.existingItem?.hsCode;
            const newHS = item.hsCode;
            // AUTO-FILL Logic: If existing is blank and new is present, OVERWRITE.
            const useIncomingHS = !existHS && newHS;
            
            const payloadItem = {
                ...item.existingItem,
                qty: item.qty, // Delta for update_item logic (see inventory.ts)
                hsCode: useIncomingHS ? newHS : existHS // Explicitly set it, though if it matches exisiting it's redundant but safe
            };
            
            bulkUpdates.push({
                type: "update",
                id: itemKey,
                item: payloadItem
            });
            indicesToMarkDone.push(index);
          }
        } else if (item.status === "NEW") {
          const newItemKey = item.janCode;
          const newItem = {
            janCode: item.janCode,
            subtype: "",
            description: item.description,
            hsCode: item.hsCode || "",
            image: "",
            qty: item.qty,
            pieces: 1,
            shipped: 0,
            creationDate: new Date().toISOString(),
          };
          
          // Reuse update_item logic (it handles new creation if ID missing? 
          // inventory.ts: "if (state.idToItem[id] !== undefined) ... else ... state.idToItem[id] = ...")
          // Yes, update_item handles creation if key is new.
          
            bulkUpdates.push({
                type: "new",
                id: newItemKey,
                item: newItem
            });
            indicesToMarkDone.push(index);
        }
      }
      
      // Process in CHUNKS to avoid 1MB Firestore limit
      const CHUNK_SIZE = 100;
      let processedCount = 0;

      for (let i = 0; i < bulkUpdates.length; i += CHUNK_SIZE) {
        const batchUpdates = bulkUpdates.slice(i, i + CHUNK_SIZE);
        const batchIndices = indicesToMarkDone.slice(i, i + CHUNK_SIZE);
        
        if ($user && $user.uid) {
            // 1. Broadcast Import (Inventory Update)
            broadcast(firestore, $user.uid, bulk_import_items({ items: batchUpdates }));
            
            // 2. Broadcast Done (UI Update)
            // Note: We do this per-chunk so UI updates progressively
            broadcast(firestore, $user.uid, mark_items_done({ indices: batchIndices }));
        }
        
        processedCount += batchUpdates.length;
        // Small yield to prevent UI freeze and allow other broadcasts to queue
        await new Promise(r => setTimeout(r, 10));
      }
      
      successMsg = `Successfully processed ${processedCount} items.`;
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
    // Find Resolved items and their indices
    const resolvedWithType = analyzedPlan
        .map((item: AnalyzedItem, index: number) => ({ item, index }))
        .filter(({ item }: { item: AnalyzedItem }) => item.status === "RESOLVED");

    if (resolvedWithType.length === 0) return;

    processing = true;
    const indicesToMarkDone: number[] = [];
    const bulkUpdates: Array<{type: "new"|"update", id: string, item: any}> = [];

    try {
      for (const { item, index } of resolvedWithType) {
         if (item.resolvedActions) {
          item.resolvedActions.forEach((action: any) => {
            // action is { type: 'update_item', payload: { itemKey, qty } }
            
            // So we must fetch existing item.
            const currentInvItem = $store.inventory.idToItem[action.payload.itemKey];
            if (currentInvItem) {
              const payloadItem = {
                ...currentInvItem,
                qty: action.payload.qty, // Delta
                hsCode: action.payload.hsCode !== undefined ? action.payload.hsCode : currentInvItem.hsCode
              };
              
              bulkUpdates.push({
                  type: "update",
                  id: action.payload.itemKey,
                  item: payloadItem
              });
            }
          });
          
          indicesToMarkDone.push(index);
        }
      }
      
      // Process in CHUNKS
      const CHUNK_SIZE = 100;
      let processedCount = 0;

      for (let i = 0; i < bulkUpdates.length; i += CHUNK_SIZE) {
         const batchUpdates = bulkUpdates.slice(i, i + CHUNK_SIZE);
         const batchIndices = indicesToMarkDone.slice(i, i + CHUNK_SIZE); // WARNING: indicesToMarkDone must align 1:1 with bulkUpdates?
         // In processResolvedConflicts, we push to both arrays inside the loop.
         // Wait, one item can have ONE resolution, but that resolution might trigger MULTIPLE updates (splits)?
         // In 'resolvedActions.forEach', we push to `bulkUpdates` multiple times for one `index`.
         // `indicesToMarkDone.push(index)` happens once per item.
         // So `indicesToMarkDone` length < `bulkUpdates` length if splits exist.
         // So slicing `indicesToMarkDone` via the same `i` is WRONG.
         
         // Fix: We can't easily couple them in the same generic loop unless we group by item.
         // But `bulk_import_items` works on flat updates.
         // AND `mark_items_done` works on plan indices.
         
         // Strategy:
         // 1. Send all `bulk_import_items` in chunks.
         // 2. Send `mark_items_done` at the end (payload is small, integers).
         // 1MB limit for `mark_items_done`? 
         // Array of 10k integers = 40KB. Safe to send all at once.
         
         if ($user && $user.uid) {
            broadcast(firestore, $user.uid, bulk_import_items({ items: batchUpdates }));
         }
         
         processedCount += batchUpdates.length;
         await new Promise(r => setTimeout(r, 10));
      }
      
      // Mark all as done after updates are sent
      if (indicesToMarkDone.length > 0 && $user && $user.uid) {
          broadcast(firestore, $user.uid, mark_items_done({ indices: indicesToMarkDone }));
      }
      
      successMsg = `Successfully processed ${indicesToMarkDone.length} resolved conflicts.`;
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
            {:else if rawRows.length > 0}
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
                    Create New ({newCount})
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
                      <th>JAN</th>
                      <th>HS Code</th>
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
                            >{item.status}</span
                          >
                        </td>
                        <td>{item.janCode}</td>
                        <td>{item.hsCode || '-'}</td>
                        <td>{item.description}</td>
                        <td>{item.qty}</td>
                        <td>
                          {#if item.status === "CONFLICT"}
                            <button
                              class="btn-small"
                              on:click={() => openConflictModal(item, item.originalIndex)}
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
          {#if currentConflictItem.conflictType === "HS_MISMATCH"}
             <div class="hs-resolution">
                 <p>HS Code Mismatch:</p>
                 <label class="radio-label">
                     <input type="radio" bind:group={selectedHSResolution} value="incoming" />
                     <div class="radio-content">
                        <span>Use Incoming: <strong>{currentConflictItem.hsCode || "Blank"}</strong></span>
                        <span class="hs-desc">{HS_CODE_DESCRIPTIONS[currentConflictItem.hsCode || ""] || "Unknown"}</span>
                     </div>
                 </label>
                 <label class="radio-label">
                     <input type="radio" bind:group={selectedHSResolution} value="existing" />
                     <div class="radio-content">
                        <span>Keep Existing: <strong>{currentConflictItem.existingItem?.hsCode || "Blank"}</strong></span>
                        <span class="hs-desc">{HS_CODE_DESCRIPTIONS[currentConflictItem.existingItem?.hsCode || ""] || "Unknown"}</span>
                     </div>
                 </label>
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
    padding: 0.5rem 1rem;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9rem;
  }
  .disconnect-button:hover {
    background: #fee2e2;
  }
</style>
