<script lang="ts">
  export let status: "initializing" | "loading" | "ready" = "initializing";
  export let progress = 0; // 0-100 placeholder if we track counts
  export let message = "Starting up...";
</script>

{#if status !== "ready"}
  <div class="loading-overlay">
    <div class="content">
      <div class="logo">Dobutsu Admin</div>
      <div class="spinner"></div>
      <div class="message">{message}</div>
      {#if progress > 0}
        <div class="progress-bar">
          <div class="progress-fill" style="width: {progress}%"></div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .loading-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background-color: #ffffff;
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
    transition: opacity 0.5s ease-out;
  }

  .content {
    text-align: center;
    width: 300px;
  }

  .logo {
    font-size: 1.5rem;
    font-weight: bold;
    margin-bottom: 2rem;
    color: #333;
  }

  .message {
    margin-top: 1rem;
    color: #666;
    font-size: 0.9rem;
  }

  .spinner {
    width: 40px;
    height: 40px;
    border: 4px solid #f3f3f3;
    border-top: 4px solid #0056b3;
    border-radius: 50%;
    margin: 0 auto;
    animation: spin 1s linear infinite;
  }

  .progress-bar {
    height: 4px;
    background-color: #eee;
    margin-top: 1rem;
    border-radius: 2px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background-color: #0056b3;
    transition: width 0.3s ease;
  }

  @keyframes spin {
    0% {
      transform: rotate(0deg);
    }
    100% {
      transform: rotate(360deg);
    }
  }
</style>
