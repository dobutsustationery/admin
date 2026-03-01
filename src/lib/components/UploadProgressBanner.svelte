<script lang="ts">
  export let progress: {
    loaded: number;
    total: number;
    percent: number;
  };

  function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  }
</script>

<div class="upload-progress-banner">
  <div class="banner-content">
    <div class="upload-info">
      <span class="upload-status">Uploading to Google Drive...</span>
      <span class="upload-stats">
        {formatBytes(progress.loaded)} of {formatBytes(progress.total)}
        ({progress.percent}%)
      </span>
    </div>
    <div class="progress-container">
      <div class="progress-bar" style="width: {progress.percent}%"></div>
    </div>
  </div>
</div>

<style>
  .upload-progress-banner {
    background-color: #eff6ff;
    border: 1px solid #bfdbfe;
    border-radius: 0.75rem;
    padding: 1rem 1.5rem;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
  }

  .banner-content {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .upload-info {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.875rem;
  }

  .upload-status {
    font-weight: 600;
    color: #1e40af;
  }

  .upload-stats {
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    color: #60a5fa;
  }

  .progress-container {
    height: 0.5rem;
    background-color: #dbeafe;
    border-radius: 9999px;
    overflow: hidden;
  }

  .progress-bar {
    height: 100%;
    background-color: #3b82f6;
    border-radius: 9999px;
    transition: width 0.3s ease-out;
  }
</style>
