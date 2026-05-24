<script lang="ts">
  import { store } from "$lib/store";
  import {
    buildInventoryValueReport,
    inventoryValueTsv,
  } from "$lib/inventory-value";

  // Snapshot the clock once per mount so the report is stable while open.
  const nowMs = Date.now();

  $: rows = buildInventoryValueReport($store.inventory ?? {}, nowMs);

  const eur = (n: number) =>
    `€${n.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  const yen = (n: number) => `¥${Math.round(n).toLocaleString()}`;

  function valuePair(eurValue: number, jpyValue: number): string {
    return `${eur(eurValue)} / ${yen(jpyValue)}`;
  }

  let copyMsg = "";
  async function copyTsv() {
    try {
      await navigator.clipboard.writeText(inventoryValueTsv(rows));
      copyMsg = "Copied TSV to clipboard.";
    } catch {
      copyMsg = "Clipboard blocked — use Download instead.";
    }
  }

  function downloadTsv() {
    const blob = new Blob([inventoryValueTsv(rows)], {
      type: "text/tab-separated-values",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `inventory-value-${new Date(nowMs).toISOString().slice(0, 10)}.tsv`;
    a.click();
    URL.revokeObjectURL(url);
    copyMsg = "Downloaded TSV.";
  }
</script>

<div class="page">
  <header>
    <div>
      <h1>Inventory Value</h1>
      <p class="sub">
        Cost of inventory remaining, valued at each month/quarter end and
        whenever a stock order is received, since inception.
      </p>
    </div>
    <div class="actions">
      <button class="copy" on:click={copyTsv} disabled={rows.length === 0}>
        Copy as TSV
      </button>
      <button on:click={downloadTsv} disabled={rows.length === 0}>
        Download .tsv
      </button>
      {#if copyMsg}<span class="hint">{copyMsg}</span>{/if}
    </div>
  </header>

  {#if rows.length === 0}
    <p class="empty">No cost-ledger activity yet — nothing to value.</p>
  {:else}
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Type</th>
          <th>Event</th>
          <th class="num">Value (EUR)</th>
          <th class="num">Value (JPY)</th>
          <th class="num">Cumulative Inventory Value</th>
          <th class="num">Cumulative Sold Inventory Value</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as r (r.asOf + r.kind + r.label)}
          <tr class={r.kind}>
            <td class="date">{r.dateIso}</td>
            <td class="type">
              {#if r.kind === "quarter-end"}Quarter end
              {:else if r.kind === "month-end"}Month end
              {:else if r.kind === "stock-order"}Stock order
              {:else}Current{/if}
            </td>
            <td>{r.label}</td>
            <td class="num">{eur(r.valueEur)}</td>
            <td class="num jpy">{yen(r.valueJpy)}</td>
            <td class="num">
              {valuePair(
                r.cumulativeInventoryValueEur,
                r.cumulativeInventoryValueJpy,
              )}
            </td>
            <td class="num">
              {valuePair(r.cumulativeSoldValueEur, r.cumulativeSoldValueJpy)}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .page {
    max-width: 1000px;
    margin: 0 auto;
    padding: 2rem;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1.5rem;
    margin-bottom: 1.5rem;
  }
  h1 {
    margin: 0 0 0.25rem;
    font-size: 1.5rem;
    color: #111827;
  }
  .sub {
    margin: 0;
    color: #6b7280;
    font-size: 0.9rem;
    max-width: 48ch;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }
  button {
    padding: 0.45rem 0.9rem;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    background: #fff;
    cursor: pointer;
    font-size: 0.85rem;
  }
  button:hover:not(:disabled) {
    background: #f9fafb;
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button.copy {
    border-color: #047857;
    color: #047857;
  }
  .hint {
    font-size: 0.8rem;
    color: #6b7280;
  }
  .empty {
    color: #6b7280;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    border: 1px solid #e5e7eb;
    font-size: 0.88rem;
  }
  th,
  td {
    border: 1px solid #e5e7eb;
    padding: 0.5rem 0.75rem;
    text-align: left;
  }
  th {
    background: #f9fafb;
    font-weight: 600;
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .date {
    white-space: nowrap;
    font-family: ui-monospace, Menlo, monospace;
  }
  .jpy {
    color: #6b7280;
  }
  tr.quarter-end {
    background: #f0fdf4;
    font-weight: 600;
  }
  tr.stock-order {
    background: #eff6ff;
  }
  tr.current {
    background: #fffbeb;
    font-weight: 600;
  }
</style>
