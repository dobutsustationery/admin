<script lang="ts">
  import { fade } from "svelte/transition";
  import { initiateOAuthFlow } from "$lib/google-auth-unified";

  export let type: "refreshing" | "required" = "refreshing";

  function handleReconnect() {
    initiateOAuthFlow(true);
  }
</script>

<div class="refresh-banner" class:danger={type === "required"} transition:fade>
  {#if type === "refreshing"}
    <div class="spinner"></div>
    <span>Refreshing Google Access Tokens...</span>
  {:else}
    <div class="icon">⚠️</div>
    <div class="content">
      <span class="title">Google Authentication Required</span>
      <span class="desc"
        >Please reconnect to maintain access to Drive & Photos.</span
      >
    </div>
    <button on:click={handleReconnect} class="reconnect-btn">Reconnect</button>
  {/if}
</div>

<style>
  .refresh-banner {
    position: fixed;
    bottom: 2rem;
    right: 2rem;
    background: #1f2937;
    color: white;
    padding: 0.75rem 1.25rem;
    border-radius: 0.75rem;
    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.2);
    display: flex;
    align-items: center;
    gap: 0.75rem;
    z-index: 9999;
    font-size: 0.875rem;
    font-weight: 500;
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  .refresh-banner.danger {
    background: #7f1d1d;
    border-color: #f87171;
    padding: 1rem 1.5rem;
  }

  .spinner {
    width: 1rem;
    height: 1rem;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  .content {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .title {
    font-weight: 700;
    display: block;
  }

  .desc {
    font-size: 0.75rem;
    opacity: 0.9;
  }

  .reconnect-btn {
    background: white;
    color: #7f1d1d;
    border: none;
    padding: 0.4rem 0.75rem;
    border-radius: 0.375rem;
    font-weight: 700;
    font-size: 0.75rem;
    cursor: pointer;
    margin-left: 0.5rem;
    transition: background 0.2s;
  }

  .reconnect-btn:hover {
    background: #f3f4f6;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
