<script lang="ts">
  export let value: unknown;
  export let blank = "(blank)";

  $: text = String(value ?? "").trim() || blank;
  $: href = /^\d{8,}/.test(text)
    ? `/itemhistory?itemKey=${encodeURIComponent(text)}`
    : "";
</script>

{#if href}
  <a class="item-history-value" {href}>{text}</a>
{:else}
  <span>{text}</span>
{/if}

<style>
  .item-history-value {
    color: #0b57d0;
    font-weight: 650;
    text-decoration: none;
  }

  .item-history-value:hover {
    text-decoration: underline;
  }
</style>
