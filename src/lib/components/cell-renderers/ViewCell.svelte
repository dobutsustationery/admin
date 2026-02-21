<script lang="ts">
  import { goto } from "$app/navigation";

  export let item: any;
  export let index: number = 0;
  export let col: any = null; // Column Config

  $: colKey =
    col?.field || col?.key || col?.header || col?.id || col?.title || "";

  function navigate() {
    // Prioritize Create Mode if context flag is set (Drafts/Proposals)
    if (item._viewMode === "create" && item.janCode) {
      goto(`/listing-detail?mode=create&jan=${item.janCode}`);
      return;
    }

    // Use computedHandle if available, else handle? item.id?
    // Legacy used computedHandle
    const handle = item.computedHandle || item.handle;
    if (handle) {
      goto(`/listing-detail?handle=${handle}`);
    } else if (item.janCode) {
      // Fallback for drafts
      goto(`/listing-detail?mode=create&jan=${item.janCode}`);
    }
  }
</script>

<div class="cell-container" data-col={colKey} data-row={index}>
  <button class="view-btn" title="View Listing" on:click={navigate}>
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  </button>
</div>

<style>
  .cell-container {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    width: 100%;
  }

  .view-btn {
    padding: 4px;
    color: #6b7280; /* gray-500 */
    background: none;
    border: none;
    cursor: pointer;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition:
      color 0.2s,
      background-color 0.2s;
  }

  .view-btn:hover {
    color: #2563eb; /* blue-600 */
    background-color: #eff6ff; /* blue-50 */
  }

  .view-btn:focus {
    outline: none;
    box-shadow: 0 0 0 2px #bfdbfe; /* blue-200 ring */
  }
</style>
