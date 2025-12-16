<script lang="ts">
  import { removeBackground } from "$lib/background-removal";

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

<div class="p-8 max-w-4xl mx-auto">
  <h1 class="text-2xl font-bold mb-4">Gemini Image Edit Testbed</h1>

  <div class="space-y-4">
    <!-- Controls -->
    <div class="bg-white p-4 rounded shadow space-y-4">
      <div>
        <label class="block font-semibold mb-1">Image</label>
        <input
          type="file"
          accept="image/*"
          bind:files
          class="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
        />
      </div>

      <button
        on:click={handleRun}
        disabled={loading}
        class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
      >
        {loading
          ? "Processing (Downloading model on first run)..."
          : "Run Background Removal (Local)"}
      </button>

      {#if error}
        <div class="p-2 bg-red-100 text-red-700 rounded">{error}</div>
      {/if}
    </div>

    <!-- Results -->
    <div class="grid grid-cols-2 gap-4">
      <!-- Log Output -->
      <div
        class="bg-gray-900 text-green-400 p-4 rounded font-mono text-xs h-[500px] overflow-auto whitespace-pre-wrap"
      >
        {logs.join("\n")}
      </div>

      <!-- Image Preview -->
      <div
        class="bg-gray-100 p-4 rounded flex items-center justify-center min-h-[500px] border-2 border-dashed border-gray-300"
      >
        {#if resultImage}
          <img
            src={resultImage}
            alt="Result"
            class="max-w-full max-h-full object-contain shadow-lg"
          />
        {:else if loading}
          <div
            class="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-400"
          ></div>
        {:else}
          <span class="text-gray-400">Result will appear here</span>
        {/if}
      </div>
    </div>
  </div>
</div>
