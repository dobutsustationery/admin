<script lang="ts">
  import { onMount } from "svelte";
  import { user } from "$lib/user-store";
  import { auth, firestore } from "$lib/firebase";
  import { signOut } from "firebase/auth";
  import {
    getStoredToken,
    clearToken,
    initiateOAuthFlow,
    getExpiryInfo,
    refreshTokensSilently,
    type GoogleAuthToken as GooglePhotosToken,
  } from "$lib/google-auth-unified";
  import { goto } from "$app/navigation";
  import AuthRefreshBanner from "$lib/components/AuthRefreshBanner.svelte";

  let token: GooglePhotosToken | null = null;
  let expiryInfo: any = null;
  let isRefreshing = false;
  let refreshRequired = false;
  const TEST_THRESHOLD = 3480;

  let scopes: string[] = [];
  let testResult = "";
  let loading = false;

  const CONFIG_FOLDER_ID = import.meta.env.VITE_GOOGLE_DRIVE_FOLDER_ID;
  const APP_VERSION = import.meta.env.VITE_APP_VERSION || "unknown";
  const APP_GIT_HASH = import.meta.env.VITE_APP_GIT_HASH || "";
  const APP_GIT_SHORT_HASH = import.meta.env.VITE_APP_GIT_SHORT_HASH || "";
  const APP_GIT_BRANCH = import.meta.env.VITE_APP_GIT_BRANCH || "";
  const APP_GIT_DIRTY =
    String(import.meta.env.VITE_APP_GIT_DIRTY || "false") === "true";
  const APP_BUILD_TIME_ISO = import.meta.env.VITE_APP_BUILD_TIME_ISO || "";
  const APP_BUILD_MODE = import.meta.env.VITE_APP_BUILD_MODE || "";

  $: buildTimeDisplay = APP_BUILD_TIME_ISO
    ? new Date(APP_BUILD_TIME_ISO).toLocaleString()
    : "Unknown";

  onMount(() => {
    loadTokenInfo();
    const interval = setInterval(loadTokenInfo, 1000);
    return () => clearInterval(interval);
  });

  function loadTokenInfo() {
    token = getStoredToken();
    expiryInfo = getExpiryInfo();

    if (token) {
      scopes = token.scope.split(" ");
    } else {
      scopes = [];
    }

    // Auto-refresh logic: if token is valid but expires in less than 58 mins, refresh.
    const TEST_THRESHOLD = 3480;
    if (
      !isRefreshing &&
      expiryInfo &&
      !expiryInfo.expired &&
      expiryInfo.expiresInSeconds < TEST_THRESHOLD
    ) {
      handleRefresh();
    }
  }

  function formatExpiry(expiry: any) {
    if (!expiry) return "Not Authenticated";
    if (expiry.expired) return "Expired";
    const mins = Math.floor(expiry.expiresInSeconds / 60);
    const secs = expiry.expiresInSeconds % 60;
    return `${mins}m ${secs}s remaining`;
  }

  async function handleRefresh() {
    if (isRefreshing) return;
    isRefreshing = true;
    try {
      const success = await refreshTokensSilently();
      if (success) {
        console.log("[Account] Manual refresh successful.");
      } else {
        // Fallback to disruptive flow if silent fails
        initiateOAuthFlow(true);
      }
    } catch (e) {
      console.error("Refresh failed", e);
      initiateOAuthFlow(true);
    } finally {
      // Keep banner for a moment so user sees it
      setTimeout(() => {
        isRefreshing = false;
      }, 2000);
    }
  }

  async function handleSignOut() {
    clearToken();
    await signOut(auth);
    goto("/");
  }

  function handleReauthorize() {
    initiateOAuthFlow(true);
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
      const folderId = CONFIG_FOLDER_ID || "root";
      const query = `'${folderId}' in parents and trashed = false`;
      const params = new URLSearchParams({
        q: query,
        pageSize: "1",
        fields: "files(id, name)",
      });

      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
        {
          headers: { Authorization: `Bearer ${token.access_token}` },
        },
      );

      if (res.ok) {
        const data = await res.json();
        testResult = `Success! Access to '${folderId}' OK. Found ${data.files?.length ?? 0} files.`;
      } else {
        const text = await res.text();
        testResult = `Error ${res.status}: ${res.statusText}\n${text}`;

        if (res.status === 403 && CONFIG_FOLDER_ID) {
          testResult += `\n\nNOTE: You are using the 'drive.file' scope. Unles you created folder '${CONFIG_FOLDER_ID}' with this app, you cannot see it.`;
        }
      }
    } catch (e: any) {
      testResult = `Exception: ${e.message}`;
    } finally {
      loading = false;
    }
  }
</script>

<div class="account-page">
  <h1 class="page-title">Account & Settings</h1>

  <div class="panel">
    <div class="panel-header">
      <h2 class="section-title">Version Info</h2>
      <span
        class={`status-pill ${APP_GIT_DIRTY ? "status-dirty" : "status-clean"}`}
      >
        {APP_GIT_DIRTY ? "DIRTY" : "CLEAN"}
      </span>
    </div>
    <div class="kv-grid kv-grid-wide">
      <div class="kv-label">Version:</div>
      <div class="mono">{APP_VERSION}</div>

      <div class="kv-label">Commit:</div>
      <div class="mono wrap-anywhere">
        {APP_GIT_SHORT_HASH || APP_GIT_HASH || "Unknown"}
      </div>

      <div class="kv-label">Full Hash:</div>
      <div class="mono small wrap-anywhere">{APP_GIT_HASH || "Unknown"}</div>

      <div class="kv-label">Branch:</div>
      <div class="mono">{APP_GIT_BRANCH || "Unknown"}</div>

      <div class="kv-label">Build Time:</div>
      <div title={APP_BUILD_TIME_ISO}>{buildTimeDisplay}</div>

      <div class="kv-label">Mode:</div>
      <div class="mono">{APP_BUILD_MODE || "Unknown"}</div>
    </div>
  </div>

  <!-- User Section -->
  <div class="panel">
    <h2 class="section-title section-title-spaced">Firebase User</h2>
    {#if $user}
      <div class="kv-grid">
        <div class="kv-label">Name:</div>
        <div>{$user.name || "N/A"}</div>

        <div class="kv-label">Email:</div>
        <div>{$user.email || "N/A"}</div>

        <div class="kv-label">UID:</div>
        <div class="inline-code">{$user.uid}</div>
      </div>
    {:else}
      <p class="muted italic">Not signed in to Firebase.</p>
    {/if}

    <div class="actions-top">
      <button on:click={handleSignOut} class="btn btn-danger">
        Sign Out Everywhere
      </button>
    </div>
  </div>

  <!-- Google Auth Section -->
  <div class="panel">
    <div class="panel-header">
      <h2 class="section-title">Unified Google Access</h2>
      {#if token}
        <span class="status-pill status-connected">CONNECTED</span>
      {:else}
        <span class="status-pill status-disconnected">DISCONNECTED</span>
      {/if}
    </div>

    {#if token}
      <div class="stack">
        <div class="stack-item">
          <div class="kv-label label-inline">Expiry Status:</div>
          <div class="expiry-row">
            <span
              class="mono"
              class:text-danger={expiryInfo?.expired ||
                expiryInfo?.expiresInSeconds < TEST_THRESHOLD}
            >
              {formatExpiry(expiryInfo)}
            </span>
            <button
              on:click={handleRefresh}
              disabled={isRefreshing}
              class="btn btn-neutral btn-small"
            >
              {isRefreshing ? "Refreshing..." : "Refresh Access"}
            </button>
          </div>
        </div>

        <div class="stack-item">
          <div class="kv-label label-inline">Current Scopes:</div>
          <div class="pill-wrap">
            {#each scopes as scope}
              <span class="scope-pill">
                {scope.replace("https://www.googleapis.com/auth/", "")}
              </span>
            {/each}
          </div>
        </div>

        <div class="stack-item">
          <div class="kv-label label-inline">Target Folder ID:</div>
          <code class="inline-code">{CONFIG_FOLDER_ID || "Not Set"}</code>
        </div>

        <div class="diagnostic-box">
          <div class="diagnostic-title">Diagnostic Tools</div>
          <div class="action-row">
            <button
              on:click={testDriveAccess}
              disabled={loading}
              class="btn btn-neutral btn-small"
            >
              {loading ? "Testing..." : "Test Drive Access"}
            </button>
          </div>

          {#if testResult}
            <pre class="terminal-output">{testResult}</pre>
          {/if}
        </div>
      </div>
    {/if}

    <div class="action-row">
      <button on:click={handleReauthorize} class="btn btn-primary">
        {token ? "Re-Authorize & Grant Scopes" : "Connect Google Account"}
      </button>
    </div>
  </div>

  <!-- Advanced Section -->
  <div class="panel panel-danger">
    <h2 class="section-title section-title-spaced danger-title">
      Advanced / Danger Zone
    </h2>
    <p class="muted">
      If you are experiencing state synchronization issues (e.g. items appearing
      as "New" when they should be matches), you can clear the local cache and
      force a full re-download of all history.
    </p>
    <button
      on:click={async () => {
        if (
          confirm(
            "Are you sure? This will clear your local cache and reload the page. It may take a few moments to rebuild.",
          )
        ) {
          const { clearActionCache } = await import("$lib/action-cache");
          await clearActionCache();
          window.location.reload();
        }
      }}
      class="btn btn-outline-danger"
    >
      Refresh Cached State
    </button>
  </div>
</div>

{#if isRefreshing}
  <AuthRefreshBanner type={refreshRequired ? "required" : "refreshing"} />
{/if}

<style>
  .expiry-row {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .text-danger {
    color: #dc2626;
    font-weight: 600;
  }

  .account-page {
    max-width: 64rem;
    margin: 0 auto;
    padding: 2rem;
  }

  .page-title {
    margin: 0 0 2rem 0;
    font-size: 1.875rem;
    line-height: 1.2;
    font-weight: 700;
    color: #111827;
  }

  .panel {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 0.75rem;
    box-shadow: 0 6px 18px rgba(17, 24, 39, 0.06);
    padding: 1.5rem;
    margin-bottom: 2rem;
  }

  .panel-danger {
    border-top: 4px solid #fecaca;
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .section-title {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
    color: #111827;
  }

  .section-title-spaced {
    margin-bottom: 1rem;
  }

  .danger-title {
    color: #991b1b;
  }

  .status-pill {
    display: inline-block;
    padding: 0.25rem 0.5rem;
    border-radius: 0.375rem;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.02em;
  }

  .status-clean {
    background: #dbeafe;
    color: #1e40af;
  }

  .status-dirty {
    background: #fef3c7;
    color: #92400e;
  }

  .status-connected {
    background: #dcfce7;
    color: #166534;
  }

  .status-disconnected {
    background: #f3f4f6;
    color: #374151;
  }

  .kv-grid {
    display: grid;
    grid-template-columns: 120px 1fr;
    gap: 0.75rem 1rem;
    font-size: 0.875rem;
    align-items: start;
  }

  .kv-grid-wide {
    grid-template-columns: 140px 1fr;
  }

  .kv-label {
    color: #6b7280;
    font-weight: 600;
  }

  .label-inline {
    margin-bottom: 0.375rem;
    display: block;
  }

  .mono {
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
      monospace;
  }

  .small {
    font-size: 0.75rem;
  }

  .wrap-anywhere {
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .inline-code {
    display: inline-block;
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
      monospace;
    font-size: 0.8125rem;
    background: #f3f4f6;
    border-radius: 0.375rem;
    padding: 0.25rem 0.5rem;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .muted {
    color: #4b5563;
    font-size: 0.875rem;
    margin: 0 0 1rem 0;
  }

  .italic {
    font-style: italic;
  }

  .actions-top {
    margin-top: 1.5rem;
  }

  .stack {
    display: grid;
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  .stack-item {
    min-width: 0;
  }

  .pill-wrap {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .scope-pill {
    display: inline-block;
    background: #eff6ff;
    color: #1d4ed8;
    border: 1px solid #bfdbfe;
    border-radius: 0.375rem;
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .diagnostic-box {
    border: 1px solid #e5e7eb;
    background: #f9fafb;
    border-radius: 0.5rem;
    padding: 1rem;
  }

  .diagnostic-title {
    font-weight: 600;
    margin-bottom: 0.75rem;
    color: #111827;
  }

  .action-row {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    flex-wrap: wrap;
  }

  .btn {
    border: 1px solid transparent;
    border-radius: 0.5rem;
    padding: 0.55rem 0.9rem;
    font-weight: 600;
    font-size: 0.9rem;
    cursor: pointer;
    transition:
      background-color 0.15s ease,
      border-color 0.15s ease,
      color 0.15s ease,
      opacity 0.15s ease;
  }

  .btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .btn-primary {
    background: #2563eb;
    color: #fff;
  }

  .btn-primary:hover:not(:disabled) {
    background: #1d4ed8;
  }

  .btn-danger {
    background: #dc2626;
    color: #fff;
  }

  .btn-danger:hover:not(:disabled) {
    background: #b91c1c;
  }

  .btn-neutral {
    background: #374151;
    color: #fff;
  }

  .btn-neutral:hover:not(:disabled) {
    background: #1f2937;
  }

  .btn-small {
    padding: 0.45rem 0.75rem;
    font-size: 0.8rem;
  }

  .btn-outline-danger {
    background: #fff;
    color: #dc2626;
    border-color: #ef4444;
  }

  .btn-outline-danger:hover:not(:disabled) {
    background: #fef2f2;
  }

  .terminal-output {
    margin: 1rem 0 0 0;
    padding: 0.75rem;
    border-radius: 0.5rem;
    background: #000;
    color: #4ade80;
    font-size: 0.75rem;
    line-height: 1.35;
    white-space: pre-wrap;
    overflow-x: auto;
  }

  @media (max-width: 700px) {
    .account-page {
      padding: 1rem;
    }

    .kv-grid,
    .kv-grid-wide {
      grid-template-columns: 1fr;
      gap: 0.35rem 0;
    }

    .kv-label {
      margin-top: 0.25rem;
    }

    .panel {
      padding: 1rem;
    }

    .panel-header {
      flex-direction: column;
      align-items: flex-start;
    }
  }
</style>
