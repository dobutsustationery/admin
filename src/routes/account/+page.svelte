<script lang="ts">
  import { onMount } from "svelte";
  import { user } from "$lib/user-store";
  import { auth } from "$lib/firebase";
  import { signOut } from "firebase/auth";
  import { 
    getStoredToken, 
    clearToken, 
    initiateOAuthFlow, 
    type GooglePhotosToken 
  } from "$lib/google-photos";
  import { goto } from "$app/navigation";
  
  let token: GooglePhotosToken | null = null;
  let scopes: string[] = [];
  let testResult = "";
  let loading = false;

  const CONFIG_FOLDER_ID = import.meta.env.VITE_GOOGLE_DRIVE_FOLDER_ID;

  onMount(() => {
    loadTokenInfo();
  });

  function loadTokenInfo() {
    token = getStoredToken();
    if (token) {
        // Token scope is a space-separated string
        scopes = token.scope.split(" ");
    } else {
        scopes = [];
    }
  }

  async function handleSignOut() {
    clearToken();
    await signOut(auth);
    goto("/");
  }

  function handleReauthorize() {
    initiateOAuthFlow();
  }

  async function testDriveAccess() {
    if (!token) {
        testResult = "No token available.";
        return;
    }
    loading = true;
    testResult = "Testing access...";
    
    try {
        // Test 1: List files in Root (or configured folder)
        // If 403 on specific folder, it means we lack access to it.
        const folderId = CONFIG_FOLDER_ID || 'root';
        const query = `'${folderId}' in parents and trashed = false`;
        const params = new URLSearchParams({
            q: query,
            pageSize: "1",
            fields: "files(id, name)"
        });

        const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`, {
            headers: { Authorization: `Bearer ${token.access_token}` }
        });

        if (res.ok) {
            const data = await res.json();
            testResult = `Success! Access to '${folderId}' OK. Found ${data.files?.length ?? 0} files.`;
        } else {
            const text = await res.text();
            testResult = `Error ${res.status}: ${res.statusText}\n${text}`;
            
            if (res.status === 403 && CONFIG_FOLDER_ID) {
                testResult += `\n\nNOTE: You are using the 'drive.file' scope. Unles you created folder '${CONFIG_FOLDER_ID}' with this app, you cannot see it.`;
                testResult += `\nTry creating a NEW folder using the app logic, or use a broader scope (not recommended).`;
            }
        }
    } catch (e: any) {
        testResult = `Exception: ${e.message}`;
    } finally {
        loading = false;
    }
  }
</script>

<div class="p-8 max-w-4xl mx-auto">
  <h1 class="text-3xl font-bold mb-8">Account & Settings</h1>

  <!-- User Section -->
  <div class="bg-white p-6 rounded-lg shadow-md mb-8">
    <h2 class="text-xl font-semibold mb-4">Firebase User</h2>
    {#if $user}
      <div class="grid grid-cols-[120px_1fr] gap-4 text-sm">
        <div class="font-medium text-gray-500">Name:</div>
        <div>{$user.displayName || "N/A"}</div>

        <div class="font-medium text-gray-500">Email:</div>
        <div>{$user.email || "N/A"}</div>
        
        <div class="font-medium text-gray-500">UID:</div>
        <div class="font-mono text-xs bg-gray-100 p-1 rounded">{$user.uid}</div>
      </div>
    {:else}
      <p class="text-gray-500 italic">Not signed in to Firebase.</p>
    {/if}
    
    <div class="mt-6">
      <button 
        on:click={handleSignOut}
        class="bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700 transition"
      >
        Sign Out Everywhere
      </button>
    </div>
  </div>

  <!-- Google Auth Section -->
  <div class="bg-white p-6 rounded-lg shadow-md mb-8">
    <div class="flex justify-between items-start mb-4">
        <h2 class="text-xl font-semibold">Google Drive & Photos Auth</h2>
        {#if token}
            <span class="bg-green-100 text-green-800 text-xs font-bold px-2 py-1 rounded">CONNECTED</span>
        {:else}
            <span class="bg-gray-100 text-gray-800 text-xs font-bold px-2 py-1 rounded">DISCONNECTED</span>
        {/if}
    </div>

    {#if token}
      <div class="mb-6 space-y-4">
        <div>
            <div class="font-medium text-gray-500 mb-1">Current Scopes:</div>
            <div class="flex flex-wrap gap-2">
                {#each scopes as scope}
                    <span class="bg-blue-50 text-blue-700 text-xs px-2 py-1 rounded border border-blue-200 break-all">
                        {scope.replace("https://www.googleapis.com/auth/", "")}
                    </span>
                {/each}
            </div>
        </div>
        
        <div>
           <div class="font-medium text-gray-500 mb-1">Target Folder ID:</div>
           <code class="bg-gray-100 px-2 py-1 rounded text-sm">{CONFIG_FOLDER_ID || "Not Set"}</code>
        </div>

        <div class="bg-gray-50 p-4 rounded border border-gray-200">
            <div class="font-medium mb-2">Diagnostic Tools</div>
            <div class="flex gap-4 items-center">
                 <button 
                    on:click={testDriveAccess}
                    disabled={loading}
                    class="bg-gray-700 text-white px-3 py-1.5 rounded text-sm hover:bg-gray-800 transition disabled:opacity-50"
                >
                    {loading ? "Testing..." : "Test Drive Access"}
                </button>
            </div>
            
            {#if testResult}
                <pre class="mt-4 text-xs bg-black text-green-400 p-3 rounded overflow-x-auto whitespace-pre-wrap">{testResult}</pre>
            {/if}
        </div>
      </div>
    {/if}

    <div class="flex gap-4">
        <button 
            on:click={handleReauthorize}
            class="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 transition"
        >
            {token ? "Re-Authorize & Grant Scopes" : "Connect Google Account"}
        </button>
    </div>
  </div>
</div>
