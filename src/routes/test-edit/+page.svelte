<script lang="ts">
  import { onMount } from 'svelte';
  import { getStoredToken } from '$lib/google-photos';
  
  let files: FileList;
  let prompt = "Remove the background from this image. Then, crop the image tightly around the subject with a 15px margin. Return ONLY the raw Base64 encoded string of the resulting PNG image.";
  let apiKey = import.meta.env.VITE_GOOGLE_API_KEY;
  let accessToken = "";
  
  let loading = false;
  let error = "";
  let resultImage = "";
  let logs: string[] = [];
  
  // Config options
  let responseMimeType = "text/plain"; // or application/json or image/png
  let maxTokens = 65536;
  
  onMount(async () => {
    const token = getStoredToken();
    if (token) accessToken = token.access_token;
    log("Ready. Select an image to start.");
  });

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
      const reader = new FileReader();
      
      reader.onload = async (e) => {
          const base64Data = (e.target?.result as string).split(',')[1];
          const mimeType = file.type;
          
          try {
              log(`Image loaded: ${mimeType}, ${base64Data.length} chars`);
              await callGemini(base64Data, mimeType);
          } catch (err: any) {
              error = err.message;
              log(`Error: ${err.message}`);
          } finally {
              loading = false;
          }
      };
      
      reader.readAsDataURL(file);
  }

  async function callGemini(base64Image: string, mimeType: string) {
      const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";
      const topP = 0.95;
      const topK = 40;
      const temp = 1.0;

      const url = `${GEMINI_API_URL}?key=${apiKey}`;
      
      const contents = [{
        parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: base64Image } }
        ]
      }];

      const generationConfig: any = {
          temperature: temp,
          topP: topP,
          topK: topK,
          maxOutputTokens: maxTokens
      };
      
      if (responseMimeType !== 'default') {
          generationConfig.responseMimeType = responseMimeType;
      }

      log(`Sending request to ${url}...`);
      log(`Config: ${JSON.stringify(generationConfig)}`);

      const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ 
            contents,
            generationConfig
        })
      });

      if (!response.ok) {
          const txt = await response.text();
          throw new Error(`${response.status} ${response.statusText}: ${txt}`);
      }
      
      const data = await response.json();
      log("Response received.");
      log("Raw Response: " + JSON.stringify(data, null, 2));

      // Parse logic (same as gemini-client but simplified for debug)
      const candidate = data.candidates?.[0];
      if (!candidate) return; // Error handled by raw dump

      // 1. Check inline_data
      const inlinePart = candidate.content?.parts?.find((p: any) => p.inline_data);
      if (inlinePart) {
          log("Found inline_data!");
          resultImage = `data:${inlinePart.inline_data.mime_type};base64,${inlinePart.inline_data.data}`;
          return;
      }

      // 2. Check text
      const textPart = candidate.content?.parts?.find((p: any) => p.text);
      if (textPart) {
          let text = textPart.text.trim();
          log(`Found text part: ${text.substring(0, 100)}...`);
          
          // Cleanup markdown
          text = text.replace(/```\w*/g, '').replace(/```/g, '').trim();

          // Try parsing as JSON
          if (text.startsWith('{')) {
              try {
                  const json = JSON.parse(text);
                  const img = json.edited_image || json.image || json.data || json.image_data;
                  if (img) {
                      log("Extracted image from JSON.");
                      resultImage = img.startsWith('data:') ? img : `data:image/png;base64,${img}`;
                      return;
                  }
              } catch(e) { log("JSON parse failed"); }
          }
          
          // Try raw base64
          if (text.length > 200 && !text.includes(' ')) {
               log("Text looks like raw Base64.");
               resultImage = `data:image/png;base64,${text}`;
               return;
          }
      }
  }
</script>

<div class="p-8 max-w-4xl mx-auto">
  <h1 class="text-2xl font-bold mb-4">Gemini Image Edit Testbed</h1>
  
  <div class="space-y-4">
      <!-- Controls -->
      <div class="bg-white p-4 rounded shadow space-y-4">
          <div>
            <label class="block font-semibold mb-1">Image</label>
            <input type="file" accept="image/*" bind:files={files} class="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100" />
          </div>

          <div>
             <label class="block font-semibold mb-1">Prompt</label>
             <textarea bind:value={prompt} class="w-full p-2 border rounded h-24 font-mono text-sm" />
          </div>
          
          <div class="flex gap-4">
             <div>
                <label class="block font-semibold mb-1">Response MimeType</label>
                <select bind:value={responseMimeType} class="p-2 border rounded">
                    <option value="text/plain">text/plain</option>
                    <option value="application/json">application/json</option>
                    <option value="image/png">image/png</option>
                    <option value="default">default (none)</option>
                </select>
             </div>
             <div>
                <label class="block font-semibold mb-1">Max Tokens</label>
                <input type="number" bind:value={maxTokens} class="p-2 border rounded" />
             </div>
          </div>

          <button on:click={handleRun} disabled={loading} class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
              {loading ? 'Processing...' : 'Run Test'}
          </button>
          
          {#if error}
            <div class="p-2 bg-red-100 text-red-700 rounded">{error}</div>
          {/if}
      </div>

      <!-- Results -->
      <div class="grid grid-cols-2 gap-4">
          <!-- Log Output -->
          <div class="bg-gray-900 text-green-400 p-4 rounded font-mono text-xs h-[500px] overflow-auto whitespace-pre-wrap">
              {logs.join('\n')}
          </div>

          <!-- Image Preview -->
          <div class="bg-gray-100 p-4 rounded flex items-center justify-center min-h-[500px] border-2 border-dashed border-gray-300">
              {#if resultImage}
                  <img src={resultImage} alt="Result" class="max-w-full max-h-full object-contain shadow-lg" />
              {:else if loading}
                  <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-gray-400"></div>
              {:else}
                  <span class="text-gray-400">Result will appear here</span>
              {/if}
          </div>
      </div>
  </div>
</div>
