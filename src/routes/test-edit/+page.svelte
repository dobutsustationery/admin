<script lang="ts">
  import { removeBackground } from "$lib/background-removal";
  import SecureImage from "$lib/components/SecureImage.svelte";

  let files: FileList;
  let prompt =
    "Remove the background from this image. Then, crop the image tightly around the subject with a 15px margin. Return ONLY the raw Base64 encoded string of the resulting PNG image.";

  let loading = false;
  let error = "";
  let resultImage = "";
  let logs: string[] = [];

  function log(msg: string) {
    logs = [...logs, `[${new Date().toLocaleTimeString()}] ${msg}`];
    console.log(msg);
  }

  async function handleRun() {
    if (!files || files.length === 0) {
      error = "Please select a file first.";
      return;
    }

    loading = true;
    error = "";
    resultImage = "";
    logs = [];
    log("Starting...");

    const file = files[0];

    // For this test, we need to upload the file to a public URL or use base64 if the API supports it.
    // background-removal.ts assumes a URL for simplicity, but Bria/Remove.bg also accept file/base64 directly.
    // To strictly test the service as written, we need a URL.
    // BUT, since we are in dev, maybe we can hack the service to accept Base64 for testing?
    // Actually, let's update callService to use the FileReader result.

    const reader = new FileReader();

    reader.onload = async (e) => {
      const base64Data = e.target?.result as string; // includes data:image/...;base64,
      const mimeType = file.type;

      try {
        log(`Image loaded: ${mimeType}, ${base64Data.length} chars`);

        // We need to bypass the service's "URL only" type signature for this testbed
        // or temporarily support Base64 in the service (which is actually better for the app so we don't need to upload first).
        // Let's assume we will modify the service to accept Base64 or we just mock the URL part.
        // Wait, the "processMediaItems" flow ALREADY has URLs (from Google Photos).
        // So the service is correct to fetch from URL.
        // For this testbed, we are uploading a local file.
        // We can't easily get a public URL for a local file without uploading it somewhere.

        // WORKAROUND: We will modify `background-removal.ts` to accept Base64 as well?
        // OR we just use a known public image for testing?
        // Let's try to mock the service call here just to test connectivity if we provide a key?
        // No, that defeats the purpose.

        // BETTER PLAN: Since the actual app flow uses URLs, let's just make this testbed confirm we have the keys
        // and maybe try to run a "Test Connectivity" with a static dummy image URL?

        // Inject keys into env for the service (Not possible in client-side runtime easily without reloading)
        // We can pass keys to the service if we modified it to accept them.
        // I previously modified the service to take params: removeBackground(url, apiKey).
        // Use the Data URL from the FileReader (local file)
        log(`Processing uploaded image...`);
        // Provide the base64Data (which is a Data URL: data:image/png;base64,...)
        const resultBase64 = await removeBackground(base64Data);

        if (resultBase64) {
          log("Success! Received Base64.");
          resultImage = `data:image/png;base64,${resultBase64}`;
        } else {
          throw new Error("No result returned. Check console/logs.");
        }
      } catch (err: any) {
        error = err.message;
        log(`Error: ${err.message}`);
      } finally {
        loading = false;
      }
    };

    reader.readAsDataURL(file);
  }
</script>

<div class="testbed-container">
  <h1 class="testbed-title">Gemini Image Edit Testbed</h1>

  <div class="testbed-content">
    <!-- Controls -->
    <div class="controls-card">
      <div class="input-group">
        <label class="input-label" for="file-upload">Image</label>
        <input
          id="file-upload"
          type="file"
          accept="image/*"
          bind:files
          class="file-input"
        />
      </div>

      <button on:click={handleRun} disabled={loading} class="btn-run">
        {loading
          ? "Processing (Downloading model on first run)..."
          : "Run Background Removal (Local)"}
      </button>

      {#if error}
        <div class="error-box">{error}</div>
      {/if}
    </div>

    <!-- Results -->
    <div class="results-grid">
      <!-- Log Output -->
      <div class="log-panel">
        {logs.join("\n")}
      </div>

      <!-- Image Preview -->
      <div class="preview-panel">
        {#if resultImage}
          <SecureImage
            src={resultImage}
            alt="Result"
            className="result-image"
          />
        {:else if loading}
          <div class="loading-spinner"></div>
        {:else}
          <span class="placeholder-text">Result will appear here</span>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .testbed-container {
    padding: 2rem;
    max-width: 56rem;
    margin: 0 auto;
  }
  .testbed-title {
    font-size: 1.5rem;
    font-weight: 700;
    margin-bottom: 1rem;
  }
  .testbed-content {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .controls-card {
    background-color: white;
    padding: 1rem;
    border-radius: 0.5rem;
    box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1);
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .input-group {
    display: flex;
    flex-direction: column;
  }
  .input-label {
    display: block;
    font-weight: 600;
    margin-bottom: 0.25rem;
  }
  .file-input {
    display: block;
    width: 100%;
    font-size: 0.875rem;
    color: #6b7280;
  }
  .file-input::file-selector-button {
    margin-right: 1rem;
    padding: 0.5rem 1rem;
    border-radius: 9999px;
    border: 0;
    font-size: 0.875rem;
    font-weight: 600;
    background-color: #eff6ff;
    color: #1d4ed8;
    cursor: pointer;
  }
  .file-input::file-selector-button:hover {
    background-color: #dbeafe;
  }
  .btn-run {
    padding: 0.5rem 1rem;
    background-color: #2563eb;
    color: white;
    border-radius: 0.375rem;
    border: none;
    cursor: pointer;
    font-weight: 500;
  }
  .btn-run:hover:not(:disabled) {
    background-color: #1d4ed8;
  }
  .btn-run:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .error-box {
    padding: 0.5rem;
    background-color: #fee2e2;
    color: #b91c1c;
    border-radius: 0.25rem;
  }
  .results-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
  }
  .log-panel {
    background-color: #111827;
    color: #4ade80;
    padding: 1rem;
    border-radius: 0.5rem;
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.75rem;
    height: 500px;
    overflow: auto;
    white-space: pre-wrap;
  }
  .preview-panel {
    background-color: #f3f4f6;
    padding: 1rem;
    border-radius: 0.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 500px;
    border: 2px dashed #d1d5db;
  }
  :global(.result-image) {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
  }
  .loading-spinner {
    animation: spin 1s linear infinite;
    border-radius: 9999px;
    height: 3rem;
    width: 3rem;
    border-bottom: 2px solid #9ca3af;
  }
  .placeholder-text {
    color: #9ca3af;
  }
  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
</style>
