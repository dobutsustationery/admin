<script lang="ts">
  import { fade } from "svelte/transition";
</script>

<div class="refresh-banner" transition:fade>
  <div class="spinner"></div>
  <span>Refreshing Google Access Tokens...</span>
</div>

<style>
  .refresh-banner {
    position: fixed;
    bottom: 2rem;
    right: 2rem;
    background: #1f2937;
    color: white;
    padding: 0.75rem 1.25rem;
    border-radius: 0.5rem;
    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
    display: flex;
    align-items: center;
    gap: 0.75rem;
    z-index: 9999;
    font-size: 0.875rem;
    font-weight: 500;
    pointer-events: none;
  }

  .spinner {
    width: 1rem;
    height: 1rem;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
