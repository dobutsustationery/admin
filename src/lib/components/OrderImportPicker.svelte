<script lang="ts">
  import { onMount, createEventDispatcher } from 'svelte';
  import { 
    isDriveConfigured,
    isAuthenticated,
    initiateOAuthFlow,
    handleOAuthCallback,
    listFilesInFolder,
    fetchSpreadsheetData,
    getStoredToken,
    clearToken,
    getFolderLink,
    type DriveFile
  } from "$lib/google-drive";

  const dispatch = createEventDispatcher();

  export let autoConnect = true;

  let driveConfigured = false;
  let authenticated = false;
  let driveFiles: DriveFile[] = [];
  let loadingFiles = false;
  let error = "";
  let loadingContent = false;

  onMount(async () => {
    driveConfigured = isDriveConfigured();
    console.log('DEBUG: OrderImportPicker Mounted. driveConfigured:', driveConfigured);
    
    if (driveConfigured) {
      // Check auth state
      const token = handleOAuthCallback();
      if (token) {
        authenticated = true;
        await loadFiles();
      } else if (isAuthenticated()) {
        authenticated = true;
        if (autoConnect) {
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
      // Filter for Spreadsheets or CSVs
      driveFiles = driveFiles.filter(f => 
        f.mimeType === 'application/vnd.google-apps.spreadsheet' || 
        f.mimeType === 'text/csv'
      );
    } catch (e) {
      console.error('Error loading files:', e);
      handleError(e);
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

  async function selectFile(file: DriveFile) {
    const token = getStoredToken();
    if (!token) {
       error = "Session expired. Please reconnect.";
       authenticated = false;
       return;
    }

    loadingContent = true;
    error = "";
    
    try {
      const content = await fetchSpreadsheetData(file.id, file.mimeType, token.access_token);
      dispatch('select', { file, content });
    } catch (e) {
      console.error('Error fetching file content:', e);
      handleError(e);
    } finally {
      loadingContent = false;
    }
  }

  function handleError(e: unknown) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      error = `Error: ${errorMsg}`;
      
      if (errorMsg.toLowerCase().includes('token expired') || 
          errorMsg.toLowerCase().includes('401')) {
        clearToken();
        authenticated = false;
      }
  }

  function formatDate(dateString: string): string {
    return new Date(dateString).toLocaleString();
  }
</script>

<div class="import-picker">
  {#if !driveConfigured}
    <div class="warning">
        Google Drive is not configured.
    </div>
  {:else if !authenticated}
     <div class="auth-prompt">
        <p>Connect to Google Drive to import inventory.</p>
        <button on:click={handleConnect} class="btn-primary">Connect Drive</button>
     </div>
  {:else}
     <div class="picker-header">
        <div class="status">
            <span class="indicator">✓</span> Connected
        </div>
        <button on:click={handleDisconnect} class="btn-text">Disconnect</button>
     </div>

     {#if error}
        <div class="error">{error}</div>
     {/if}

     <div class="file-list">
        <h3>Select Invoice / Packing List</h3>
        {#if loadingFiles}
            <div class="loading">Loading files...</div>
        {:else if driveFiles.length === 0}
            <div class="empty">
                No CSVs or Spreadsheets found in the folder.
                <br>
                <a href={getFolderLink()} target="_blank">Open Drive Folder</a>
            </div>
        {:else}
            <table class="files-table">
                <thead>
                    <tr>
                        <th>Name</th>
                        <th>Date</th>
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody>
                    {#each driveFiles as file}
                        <tr>
                            <td>
                                <span class="icon">
                                    {file.mimeType.includes('spreadsheet') ? '📊' : '📄'}
                                </span>
                                {file.name}
                            </td>
                            <td>{formatDate(file.modifiedTime)}</td>
                            <td>
                                <button 
                                    class="btn-select"
                                    disabled={loadingContent}
                                    on:click={() => selectFile(file)}
                                >
                                    {loadingContent ? 'Loading...' : 'Select'}
                                </button>
                            </td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        {/if}
     </div>
  {/if}
</div>

<style>
  .import-picker {
    background: white;
    padding: 20px;
    border-radius: 8px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.1);
  }
  
  .auth-prompt {
      text-align: center;
      padding: 40px;
      background: #f5f5f5;
      border-radius: 8px;
  }

  .picker-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      padding-bottom: 10px;
      border-bottom: 1px solid #eee;
  }

  .status {
      display: flex;
      align-items: center;
      gap: 8px;
      color: #2e7d32;
      font-weight: 500;
  }

  .files-table {
      width: 100%;
      border-collapse: collapse;
  }

  .files-table th {
      text-align: left;
      padding: 10px;
      background: #f9fafb;
      font-size: 0.9em;
  }

  .files-table td {
      padding: 12px 10px;
      border-bottom: 1px solid #eee;
  }

  .files-table tr:hover {
      background: #f5f5f5;
  }

  .btn-primary {
      background: #2563eb;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 500;
  }

  .btn-select {
      background: #10b981;
      color: white;
      border: none;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.9em;
  }

  .btn-select:disabled {
      background: #9ca3af;
      cursor: not-allowed;
  }

  .btn-text {
      background: none;
      border: none;
      color: #6b7280;
      cursor: pointer;
      text-decoration: underline;
  }

  .error {
      background: #fee2e2;
      color: #b91c1c;
      padding: 12px;
      border-radius: 6px;
      margin-bottom: 16px;
  }
  
  .loading, .empty {
      padding: 40px;
      text-align: center;
      color: #6b7280;
  }
</style>
