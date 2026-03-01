<script lang="ts">
  import ImageThumbnail from "./ImageThumbnail.svelte";

  export let batchProgress: {
    current: number;
    total: number;
    operation: string;
    completedIds: string[];
  };
  export let registry: Record<string, any> = {};
  export let photos: any[] = [];
  export let janCodeToPhotos: Record<string, any[]> = {};

  function findItem(id: string) {
    return (
      registry[id] ||
      photos.find((p) => p.id === id) ||
      Object.values(janCodeToPhotos)
        .flat()
        .find((p) => p.id === id)
    );
  }
</script>

<div class="batch-progress-banner">
  <div class="banner-content">
    <div class="status-section">
      <div class="spinner-wrap">
        <span class="ping-pulse"></span>
        <span class="dot"></span>
      </div>
      <div class="text-wrap">
        <h3>
          {batchProgress.operation || "Processing Images"}
          {#if batchProgress.total > 0}
            <span class="percent-badge">
              {Math.round((batchProgress.current / batchProgress.total) * 100)}%
            </span>
          {/if}
        </h3>
        <div class="progress-row">
          <p class="status-text">
            {batchProgress.current} / {batchProgress.total} completed
          </p>
          {#if batchProgress.total > 0}
            <div class="progress-track">
              <div
                class="progress-fill"
                style="width: {(batchProgress.current / batchProgress.total) *
                  100}%"
              ></div>
            </div>
          {/if}
        </div>
      </div>
    </div>

    {#if batchProgress.completedIds.length > 0}
      <div class="thumbnails-section">
        {#each batchProgress.completedIds.slice(-6).reverse() as id}
          {@const item = findItem(id)}
          {#if item}
            <div class="mini-thumb">
              <ImageThumbnail
                src={item.baseUrl}
                alt="Done"
                width="32px"
                height="32px"
                fit="cover"
              />
            </div>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .batch-progress-banner {
    background-color: #312e81; /* indigo-900 */
    color: white;
    border-radius: 1rem;
    padding: 0.75rem 1.25rem;
    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
    border: 1px solid #4338ca; /* indigo-700 */
  }

  .banner-content {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
  }

  .status-section {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-grow: 1;
  }

  .spinner-wrap {
    position: relative;
    display: flex;
    height: 0.75rem;
    width: 0.75rem;
    flex-shrink: 0;
  }

  .ping-pulse {
    animation: ping 1s cubic-bezier(0, 0, 0.2, 1) infinite;
    position: absolute;
    display: inline-flex;
    height: 100%;
    width: 100%;
    border-radius: 9999px;
    background-color: #818cf8; /* indigo-400 */
    opacity: 0.75;
  }

  @keyframes ping {
    75%,
    100% {
      transform: scale(2);
      opacity: 0;
    }
  }

  .dot {
    position: relative;
    display: inline-flex;
    border-radius: 9999px;
    height: 0.75rem;
    width: 0.75rem;
    background-color: #6366f1; /* indigo-500 */
  }

  .text-wrap {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    flex-grow: 1;
  }

  h3 {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
    font-weight: 600;
    margin: 0;
  }

  .percent-badge {
    font-size: 0.7rem;
    background-color: rgba(99, 102, 241, 0.5);
    padding: 0.05rem 0.4rem;
    border-radius: 9999px;
  }

  .progress-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .status-text {
    font-size: 0.7rem;
    opacity: 0.8;
    white-space: nowrap;
    margin: 0;
  }

  .progress-track {
    width: 6rem;
    height: 0.25rem;
    background-color: #334155;
    border-radius: 9999px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background-color: #6366f1;
    transition: width 0.3s ease-out;
  }

  .thumbnails-section {
    display: flex;
    gap: 0.25rem;
    align-items: center;
    padding-left: 1rem;
    border-left: 1px solid #334155;
  }

  .mini-thumb {
    width: 32px;
    height: 32px;
    border-radius: 0.25rem;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.1);
  }
</style>
