<script lang="ts">
  export let current: number;
  export let total: number;
  export let message: string = "";
  /**
   * Optional color theme: 'teal' (default), 'indigo', 'blue', 'orange'
   */
  export let color: "teal" | "indigo" | "blue" | "orange" | string = "teal";

  // Map legacy Tailwind classes to our semantic colors if needed,
  // but prefer using the simplified 'color' prop.
  $: theme = color.includes("teal")
    ? "teal"
    : color.includes("indigo")
      ? "indigo"
      : color.includes("blue")
        ? "blue"
        : color.includes("orange")
          ? "orange"
          : "teal";
</script>

<div class="progress-wrapper">
  <div class="progress-info">
    <span class="message">{message}</span>
    <span class="stats">{current} / {total}</span>
  </div>
  <div class="progress-track">
    <div
      class="progress-fill theme-{theme}"
      style="width: {(total > 0 ? current / total : 0) * 100}%"
    ></div>
  </div>
</div>

<style>
  .progress-wrapper {
    padding: 0.5rem 1rem; /* px-4 py-2 */
  }

  .progress-info {
    display: flex;
    justify-content: space-between;
    font-size: 0.875rem; /* text-sm */
    color: #4b5563; /* text-gray-600 */
    margin-bottom: 0.25rem; /* mb-1 */
  }

  .progress-track {
    width: 100%;
    background-color: #e5e7eb; /* bg-gray-200 */
    border-radius: 9999px; /* rounded-full */
    height: 0.5rem; /* h-2 */
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    border-radius: 9999px;
    transition: width 0.3s ease-in-out;
  }

  .theme-teal {
    background-color: #14b8a6;
  }
  .theme-indigo {
    background-color: #6366f1;
  }
  .theme-blue {
    background-color: #3b82f6;
  }
  .theme-orange {
    background-color: #f97316;
  }
</style>
