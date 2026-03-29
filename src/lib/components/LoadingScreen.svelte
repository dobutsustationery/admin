<script lang="ts">
  export let status: "initializing" | "loading" | "ready" = "initializing";
  export let progress = 0;
  export let message = "Starting up...";
  export let detail = "";
</script>

{#if status !== "ready"}
  <div class="loading-overlay">
    <div class="content">
      <div class="logo">Dobutsu Admin</div>
      <div
        class="progress-track"
        class:indeterminate={status === "initializing" && progress <= 0}
      >
        <div
          class="progress-fill"
          style="width: {Math.max(progress, 2)}%"
        ></div>
      </div>
      {#if status === "loading"}
        <div class="progress-label">{progress.toFixed(1)}%</div>
      {/if}
      <div class="message">{message}</div>
      {#if detail}
        <div class="detail">{detail}</div>
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
    width: 320px;
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

  .detail {
    margin-top: 0.5rem;
    color: #888;
    font-size: 0.8rem;
  }

  .progress-track {
    position: relative;
    height: 12px;
    background-color: #e9eef5;
    border-radius: 999px;
    margin: 0 auto;
    overflow: hidden;
  }

  .progress-label {
    margin-top: 0.75rem;
    color: #333;
    font-size: 1.2rem;
    font-variant-numeric: tabular-nums;
  }

  .progress-track.indeterminate .progress-fill {
    width: 35% !important;
    animation: indeterminate-slide 1.2s ease-in-out infinite;
  }

  .progress-fill {
    height: 100%;
    border-radius: 999px;
    background: linear-gradient(90deg, #0056b3 0%, #2b8cff 100%);
    transition: width 0.3s ease;
  }

  @keyframes indeterminate-slide {
    0% {
      transform: translateX(-120%);
    }
    100% {
      transform: translateX(320%);
    }
  }
</style>
