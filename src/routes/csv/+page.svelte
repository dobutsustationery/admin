<script lang="ts">
  import { onMount } from 'svelte';
  import { store } from "$lib/store";
  import { Parser } from "@json2csv/plainjs";
  import { 
    isDriveConfigured,
    isAuthenticated,
    initiateOAuthFlow,
    handleOAuthCallback,
    listFilesInFolder,
    uploadCSVToDrive,
    getStoredToken,
    clearToken,
    getFolderLink,
    type DriveFile
  } from "$lib/google-drive";

  let state = store.getState();

  let itemKeys: string[] = [];
  let csv = "";
  let filename = "";
  let driveConfigured = false;
  let authenticated = false;
  let driveFiles: DriveFile[] = [];
  let uploading = false;
  let uploadSuccess = false;
  let uploadedFileLink = "";
  let error = "";
  let loadingFiles = false;

  $: if ($store) {
    state = store.getState();
    itemKeys = Object.keys(state.inventory.idToItem);
    const fields = [
      "janCode",
      "subtype",
      "description",
      "image",
      "hsCode",
      "qty",
      "pieces",
      "shipped",
    ];
    const parser = new Parser({ fields });
    const data = itemKeys.map((k) => state.inventory.idToItem[k]);
    if (data.length > 0) {
      csv = parser.parse(data).toString();
    }
  }

  onMount(async () => {
    // Set default filename with current date
    filename = `inventory-export-${new Date().toISOString().split('T')[0]}.csv`;
    
    // Check if Drive is configured
    driveConfigured = isDriveConfigured();
    
    if (driveConfigured) {
      // Handle OAuth callback if present
      const token = handleOAuthCallback();
      if (token) {
        authenticated = true;
        await loadFiles();
      } else {
        // Check if already authenticated
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
    } catch (e) {
      console.error('Error loading files:', e);
      const errorMsg = e instanceof Error ? e.message : String(e);
      error = `Failed to load files: ${errorMsg}`;
      // Token might be expired - check for 401 or unauthorized errors
      if (errorMsg.toLowerCase().includes('401') || 
          errorMsg.toLowerCase().includes('unauthorized') ||
          errorMsg.toLowerCase().includes('expired')) {
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

  async function handleExport() {
    const token = getStoredToken();
    if (!token) {
      error = "Not authenticated. Please connect to Google Drive first.";
      return;
    }
    
    if (!csv) {
      error = "No CSV data to export";
      return;
    }
    
    if (!filename.trim()) {
      error = "Please enter a filename";
      return;
    }
    
    // Ensure filename ends with .csv
    let finalFilename = filename.trim();
    if (!finalFilename.endsWith('.csv')) {
      finalFilename += '.csv';
    }
    
    uploading = true;
    uploadSuccess = false;
    uploadedFileLink = "";
    error = "";
    
    try {
      const fileInfo = await uploadCSVToDrive(finalFilename, csv, token.access_token);
      uploadSuccess = true;
      uploadedFileLink = fileInfo.webViewLink;
      
      // Reload files to show the new upload
      await loadFiles();
    } catch (e) {
      console.error('Error uploading file:', e);
      const errorMsg = e instanceof Error ? e.message : String(e);
      error = `Failed to upload file: ${errorMsg}`;
      
      // Token might be expired - check for 401 or unauthorized errors
      if (errorMsg.toLowerCase().includes('401') || 
          errorMsg.toLowerCase().includes('unauthorized') ||
          errorMsg.toLowerCase().includes('expired')) {
        clearToken();
        authenticated = false;
      }
    } finally {
      uploading = false;
    }
  }

  function formatFileSize(size?: string): string {
    if (!size) return 'Unknown';
    const bytes = parseInt(size, 10);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatDate(dateString: string): string {
    const date = new Date(dateString);
    return date.toLocaleString();
  }
</script>

<div class="csv-page">
  <h1>CSV Export</h1>
  
  {#if driveConfigured}
    <div class="drive-section">
      <h2>Google Drive Export</h2>
      
      {#if !authenticated}
        <div class="auth-prompt">
          <p>Connect to Google Drive to export your inventory data directly to the cloud.</p>
          <button on:click={handleConnect} class="connect-button">
            Connect to Google Drive
          </button>
        </div>
      {:else}
        <div class="authenticated">
          <div class="auth-status">
            <span class="status-indicator">✓</span>
            <span>Connected to Google Drive</span>
            <button on:click={handleDisconnect} class="disconnect-button">
              Disconnect
            </button>
          </div>
          
          <div class="export-form">
            <h3>Export Inventory</h3>
            <div class="form-row">
              <label for="filename">Filename:</label>
              <input 
                id="filename"
                type="text" 
                bind:value={filename} 
                placeholder="inventory-export.csv"
                disabled={uploading}
              />
            </div>
            <button 
              on:click={handleExport} 
              disabled={uploading || !csv}
              class="export-button"
            >
              {uploading ? 'Uploading...' : 'Export to Drive'}
            </button>
          </div>
          
          {#if error}
            <div class="error-message">{error}</div>
          {/if}
          
          {#if uploadSuccess && uploadedFileLink}
            <div class="success-message">
              File uploaded successfully! 
              <a href={uploadedFileLink} target="_blank" rel="noopener noreferrer">
                View in Drive
              </a>
            </div>
          {/if}
          
          <div class="drive-files">
            <h3>
              Recent Exports 
              {#if getFolderLink()}
                <a href={getFolderLink()} target="_blank" rel="noopener noreferrer" class="folder-link">
                  (View Folder)
                </a>
              {/if}
            </h3>
            
            {#if loadingFiles}
              <p class="loading">Loading files...</p>
            {:else if driveFiles.length === 0}
              <p class="no-files">No files in Drive folder yet.</p>
            {:else}
              <table class="files-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Modified</th>
                    <th>Size</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {#each driveFiles as file}
                    <tr>
                      <td>{file.name}</td>
                      <td>{formatDate(file.modifiedTime)}</td>
                      <td>{formatFileSize(file.size)}</td>
                      <td>
                        {#if file.webViewLink}
                          <a href={file.webViewLink} target="_blank" rel="noopener noreferrer">
                            View
                          </a>
                        {/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  {:else}
    <div class="not-configured">
      <p>Google Drive integration is not configured. Please set the required environment variables.</p>
    </div>
  {/if}
  
  <div class="csv-preview">
    <h2>CSV Preview</h2>
    <pre>{csv || 'No data to preview'}</pre>
  </div>
</div>

<style>
  .csv-page {
    padding: 20px;
    max-width: 1200px;
    margin: 0 auto;
  }
  
  h1 {
    margin-bottom: 30px;
  }
  
  h2 {
    margin-top: 0;
    margin-bottom: 20px;
  }
  
  h3 {
    margin-top: 0;
    margin-bottom: 15px;
  }
  
  .drive-section {
    background: #f5f5f5;
    padding: 20px;
    border-radius: 8px;
    margin-bottom: 30px;
  }
  
  .auth-prompt {
    text-align: center;
    padding: 20px;
  }
  
  .connect-button {
    background: #4285f4;
    color: white;
    border: none;
    padding: 12px 24px;
    font-size: 16px;
    border-radius: 4px;
    cursor: pointer;
    margin-top: 15px;
  }
  
  .connect-button:hover {
    background: #357ae8;
  }
  
  .authenticated {
    padding: 10px;
  }
  
  .auth-status {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 20px;
    padding: 10px;
    background: #e8f5e9;
    border-radius: 4px;
  }
  
  .status-indicator {
    color: #4caf50;
    font-size: 18px;
  }
  
  .disconnect-button {
    margin-left: auto;
    background: #f44336;
    color: white;
    border: none;
    padding: 6px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 14px;
  }
  
  .disconnect-button:hover {
    background: #d32f2f;
  }
  
  .export-form {
    background: white;
    padding: 20px;
    border-radius: 4px;
    margin-bottom: 20px;
  }
  
  .form-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 15px;
  }
  
  .form-row label {
    min-width: 80px;
  }
  
  .form-row input {
    flex: 1;
    padding: 8px;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 14px;
  }
  
  .export-button {
    background: #4caf50;
    color: white;
    border: none;
    padding: 10px 20px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 16px;
  }
  
  .export-button:hover:not(:disabled) {
    background: #45a049;
  }
  
  .export-button:disabled {
    background: #ccc;
    cursor: not-allowed;
  }
  
  .error-message {
    background: #ffebee;
    color: #c62828;
    padding: 12px;
    border-radius: 4px;
    margin-bottom: 15px;
  }
  
  .success-message {
    background: #e8f5e9;
    color: #2e7d32;
    padding: 12px;
    border-radius: 4px;
    margin-bottom: 15px;
  }
  
  .success-message a {
    color: #1976d2;
    text-decoration: underline;
  }
  
  .drive-files {
    background: white;
    padding: 20px;
    border-radius: 4px;
  }
  
  .folder-link {
    font-size: 14px;
    color: #1976d2;
    text-decoration: none;
  }
  
  .folder-link:hover {
    text-decoration: underline;
  }
  
  .loading,
  .no-files {
    color: #666;
    font-style: italic;
  }
  
  .files-table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 10px;
  }
  
  .files-table th,
  .files-table td {
    padding: 10px;
    text-align: left;
    border-bottom: 1px solid #ddd;
  }
  
  .files-table th {
    background: #f5f5f5;
    font-weight: 600;
  }
  
  .files-table a {
    color: #1976d2;
    text-decoration: none;
  }
  
  .files-table a:hover {
    text-decoration: underline;
  }
  
  .not-configured {
    background: #fff3cd;
    color: #856404;
    padding: 20px;
    border-radius: 4px;
    margin-bottom: 20px;
  }
  
  .csv-preview {
    background: white;
    padding: 20px;
    border-radius: 8px;
  }
  
  .csv-preview pre {
    background: #f5f5f5;
    padding: 15px;
    border-radius: 4px;
    overflow-x: auto;
    max-height: 500px;
    font-size: 12px;
  }
</style>
