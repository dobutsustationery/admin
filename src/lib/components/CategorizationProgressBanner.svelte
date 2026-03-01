<script lang="ts">
  export let progress: {
    current: number;
    total: number;
    message: string;
  };
</script>

<div class="categorization-progress-banner">
  <div class="banner-content">
    <div class="spinner"></div>
    <div class="text-wrap">
      <h3>Categorizing Photos</h3>
      <div class="progress-row">
        <p class="status-text">{progress.message}</p>
        {#if progress.total > 0}
          <div class="progress-track">
            <div
              class="progress-fill"
              style="width: {(progress.current / progress.total) * 100}%"
            ></div>
          </div>
          <span class="percent-text">
            {Math.round((progress.current / progress.total) * 100)}%
          </span>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .categorization-progress-banner {
    background-color: #0d9488; /* teal-600 */
    color: white;
    border-radius: 0.75rem;
    padding: 0.75rem 1.25rem;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
  }

  .banner-content {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .spinner {
    width: 1.25rem;
    height: 1.25rem;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: white;
    border-radius: 9999px;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .text-wrap {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    flex-grow: 1;
  }

  h3 {
    font-size: 0.875rem;
    font-weight: 700;
    margin: 0;
    text-transform: uppercase;
    letter-spacing: 0.025em;
  }

  .progress-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .status-text {
    font-size: 0.75rem;
    opacity: 0.9;
    margin: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 200px;
  }

  .progress-track {
    flex-grow: 1;
    max-width: 150px;
    height: 0.375rem;
    background-color: rgba(255, 255, 255, 0.2);
    border-radius: 9999px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background-color: white;
    transition: width 0.3s ease-out;
  }

  .percent-text {
    font-size: 0.75rem;
    font-weight: 600;
    font-family: ui-monospace, monospace;
  }
</style>
