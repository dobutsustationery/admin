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

  let driveConfigured = false;
  let authenticated = false;
  let driveFiles: DriveFile[] = [];
  let loadingFiles = false;
  let error = "";
  let successMsg = "";
  let processing = false;

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
  }



  function parseCSV(content: string) {
    // Robust parsing with PapaParse
    const parsed = Papa.parse(content, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim().toLowerCase()
    });

    if (parsed.errors && parsed.errors.length > 0) {
      console.error("CSV Parse Errors:", parsed.errors);
      // We could throw or return strict errors, but for now let's just use what data we have
      // or filter out bad rows.
    }

    const data: any[] = [];
    
    parsed.data.forEach((row: any) => {
      // row is an object with keys from header
      // Mapping common names
      const id = row["order id"] || row["id"];
      const email = row["email"];
      const dateStr = row["date"];
      const product = row["product"] || row["item"];

      if (id) {
         data.push({ id, email, dateStr, product });
      }
    });

    return data;
  }

  async function handleImport(file: DriveFile) {
    const token = getStoredToken();
    if (!token) {
      return;
    }

    if (!confirm(`Import orders from ${file.name}?`)) {
      return;
    }

    processing = true;
    error = "";
    successMsg = "";

    try {
      const content = await downloadFile(file.id, token.access_token);
      const orders = parseCSV(content);

      if (orders.length === 0) {
        error = "No orders found in file.";
        return;
      }

      let count = 0;
      for (const order of orders) {
        const date = order.dateStr ? new Date(order.dateStr) : new Date();
        // Dispatch to redux/firestore
        // We use broadcast to sync with other admins
        const action = new_order({
          orderID: order.id,
          date: date,
          email: order.email || "",
          product: order.product || "",
        });

        if ($user && $user.uid) {
          broadcast(firestore, $user.uid, action);
          count++;
        } else {
          console.error("Import failed: User not authenticated with Firebase");
          throw new Error("User not authenticated with Firebase");
        }
      }
      successMsg = `Successfully imported ${count} orders from ${file.name}`;
    } catch (e) {
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
  <h1>Order Import (Drive)</h1>

  {#if driveConfigured}
    {#if !authenticated}
      <div class="auth-prompt">
        <p>Connect to Google Drive to import order CSVs.</p>
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

        <div class="file-list">
          <h3>CSV Files</h3>
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
                        on:click={() => handleImport(file)}
                        disabled={processing}
                        class="import-button"
                      >
                        Import
                      </button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </div>
      </div>
    {/if}
  {:else}
    <div class="not-configured">Drive not configured.</div>
  {/if}
</div>

<style>
  .import-page {
    padding: 20px;
    max-width: 1000px;
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
  .import-button {
    background: #4caf50;
    color: white;
    padding: 5px 10px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }
  .import-button:disabled {
    background: #ccc;
    cursor: not-allowed;
  }
  .files-table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 20px;
  }
  .files-table th,
  .files-table td {
    padding: 10px;
    border-bottom: 1px solid #ddd;
    text-align: left;
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
</style>
