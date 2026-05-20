<script lang="ts">
  import { store } from "$lib/store";
  import ImageThumbnail from "$lib/components/ImageThumbnail.svelte";
  import {
    walkLedger,
    type LedgerEntry,
    type ReceiptEntry,
  } from "$lib/cost-engine";
  import type { InventoryState, Item } from "$lib/inventory";

  type UnpricedScanLot = {
    key: string;
    jan: string;
    subtype: string;
    description: string;
    image: string;
    itemQty: number;
    shipped: number;
    lotQty: number;
    at: number;
    seq: number;
    source: string;
    unitCostJpy: number;
    unitCostEur: number;
    remainingLotQty: number;
    affectsAverage: boolean;
    currentAvgJpy: number;
    currentAvgEur: number;
    receiptCount: number;
    zeroScanDates: number[];
    ledger: LedgerEntry[];
    ledgerIndex: number;
  };

  let search = "";
  let hideZeroOnHand = false;
  let onlyAffectsAverage = false;

  function isUnpricedScanReceipt(entry: LedgerEntry): entry is ReceiptEntry {
    return (
      entry.kind === "receipt" &&
      entry.unitCostJpy <= 0 &&
      !entry.costOrderId &&
      !String(entry.source || "").startsWith("stockOrder:")
    );
  }

  function buildRows(inventory: InventoryState): UnpricedScanLot[] {
    const costLedger = inventory.costLedger || {};
    const idToItem = inventory.idToItem || {};
    const rows: UnpricedScanLot[] = [];

    for (const [key, ledger] of Object.entries(costLedger)) {
      const item = idToItem[key] as Item | undefined;
      if (!item) continue;

      const sorted = sortedLedger(ledger);
      const remainingByIndex = receiptRemainingByIndex(sorted);
      const current = walkLedger(sorted);
      const receiptCount = sorted.filter((e) => e.kind === "receipt").length;
      const zeroScanDates = sorted
        .filter(isUnpricedScanReceipt)
        .map((entry) => entry.at)
        .sort((a, b) => a - b);
      for (const [ledgerIndex, entry] of sorted.entries()) {
        if (!isUnpricedScanReceipt(entry)) continue;
        rows.push({
          key,
          jan: item.janCode || "",
          subtype: item.subtype || "",
          description: item.description || "",
          image: item.image || "",
          itemQty: Number(item.qty) || 0,
          shipped: Number(item.shipped) || 0,
          lotQty: entry.qty,
          at: entry.at,
          seq: entry.seq,
          source: entry.source || "",
          unitCostJpy: entry.unitCostJpy,
          unitCostEur: entry.unitCostEur,
          remainingLotQty: remainingByIndex.get(ledgerIndex) || 0,
          affectsAverage:
            (remainingByIndex.get(ledgerIndex) || 0) > 0 &&
            !isArchiveCarryReceipt(sorted, ledgerIndex),
          currentAvgJpy: current.avgJpy,
          currentAvgEur: current.avgEur,
          receiptCount,
          zeroScanDates,
          ledger: sorted,
          ledgerIndex,
        });
      }
    }

    return rows.sort(
      (a, b) => a.at - b.at || a.key.localeCompare(b.key) || a.seq - b.seq,
    );
  }

  $: rows = buildRows($store.inventory);
  $: query = search.trim().toLowerCase();
  $: filteredRows = rows.filter((row) => {
    if (hideZeroOnHand && row.itemQty - row.shipped <= 0) return false;
    if (onlyAffectsAverage && !row.affectsAverage) return false;
    if (!query) return true;
    return (
      row.key.toLowerCase().includes(query) ||
      row.jan.includes(query) ||
      row.description.toLowerCase().includes(query) ||
      row.subtype.toLowerCase().includes(query)
    );
  });
  $: totalLotQty = rows.reduce((sum, row) => sum + row.lotQty, 0);
  $: filteredLotQty = filteredRows.reduce((sum, row) => sum + row.lotQty, 0);
  $: itemCount = new Set(rows.map((row) => row.key)).size;
  $: affectingRows = rows.filter((row) => row.affectsAverage).length;

  function fmtDate(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return "-";
    return new Date(ms).toISOString().slice(0, 10);
  }

  function uniqueDateLabels(values: number[]): string {
    return Array.from(new Set(values.map(fmtDate))).join(", ");
  }

  function fmtYen(n: number): string {
    return Number.isFinite(n) ? `¥${Math.round(n).toLocaleString()}` : "-";
  }

  function fmtEur(n: number): string {
    return Number.isFinite(n) && n > 0 ? `€${n.toFixed(2)}` : "-";
  }

  function sortedLedger(ledger: readonly LedgerEntry[]): LedgerEntry[] {
    return [...ledger].sort((a, b) => a.at - b.at || a.seq - b.seq);
  }

  function receiptRemainingByIndex(
    ledger: readonly LedgerEntry[],
  ): Map<number, number> {
    const remaining = new Map<number, number>();
    const openLots: { index: number; remaining: number }[] = [];

    for (const [index, entry] of ledger.entries()) {
      if (entry.kind === "receipt") {
        const qty = Math.max(0, Number(entry.qty) || 0);
        remaining.set(index, qty);
        openLots.push({ index, remaining: qty });
        continue;
      }

      let saleQty = Math.max(0, Number(entry.qty) || 0);
      for (const lot of openLots) {
        if (saleQty <= 0) break;
        const consumed = Math.min(lot.remaining, saleQty);
        lot.remaining -= consumed;
        saleQty -= consumed;
        remaining.set(lot.index, lot.remaining);
      }
    }

    return remaining;
  }

  function isArchiveCarryReceipt(
    ledger: readonly LedgerEntry[],
    targetIndex: number,
  ): boolean {
    let onHand = 0;
    let avgJpy = 0;
    let avgEur = 0;
    let carry: { jpy: number; eur: number } | null = null;

    for (const [index, entry] of ledger.entries()) {
      if (entry.kind === "receipt") {
        if (index === targetIndex) {
          return entry.unitCostJpy <= 0 && onHand === 0 && carry !== null;
        }

        const next = onHand + entry.qty;
        if (next <= 0) {
          onHand = next > 0 ? next : 0;
          continue;
        }
        if (onHand === 0 && carry) {
          const jpyPriced = entry.unitCostJpy > 0;
          const eurPriced = entry.unitCostEur > 0;
          if (jpyPriced && eurPriced) {
            avgJpy = entry.unitCostJpy;
            avgEur = entry.unitCostEur;
          } else if (jpyPriced) {
            avgJpy = entry.unitCostJpy;
            avgEur =
              carry.jpy > 0
                ? (entry.unitCostJpy * carry.eur) / carry.jpy
                : carry.eur;
          } else if (eurPriced) {
            avgEur = entry.unitCostEur;
            avgJpy =
              carry.eur > 0
                ? (entry.unitCostEur * carry.jpy) / carry.eur
                : carry.jpy;
          } else {
            avgJpy = carry.jpy;
            avgEur = carry.eur;
          }
          carry = null;
        } else {
          avgJpy = (onHand * avgJpy + entry.qty * entry.unitCostJpy) / next;
          avgEur = (onHand * avgEur + entry.qty * entry.unitCostEur) / next;
        }
        onHand = next;
        continue;
      }

      const prev = onHand;
      onHand = Math.max(0, onHand - entry.qty);
      if (entry.isArchive && prev > 0 && onHand === 0) {
        carry = { jpy: avgJpy, eur: avgEur };
      }
    }

    return false;
  }

  function ledgerEntryLabel(entry: LedgerEntry): string {
    const base = `${fmtDate(entry.at)} ${entry.kind} ${entry.qty}`;
    if (entry.kind !== "receipt") {
      return entry.isArchive ? `${base} archive` : base;
    }
    const source = entry.costOrderId || entry.source || "";
    return `${base} @ ${fmtYen(entry.unitCostJpy)}${source ? ` ${source}` : ""}`;
  }
</script>

<svelte:head><title>Unpriced Scan Lots</title></svelte:head>

<main>
  <h1>Unpriced Scan Lots</h1>

  <div class="summary">
    <div>
      <strong>{rows.length}</strong>
      <span>lot(s)</span>
    </div>
    <div>
      <strong>{itemCount}</strong>
      <span>item(s)</span>
    </div>
    <div>
      <strong>{totalLotQty}</strong>
      <span>unit(s)</span>
    </div>
  </div>

  <div class="controls">
    <label>
      Search
      <input bind:value={search} placeholder="JAN, key, or description" />
    </label>
    <label class="chk">
      <input type="checkbox" bind:checked={hideZeroOnHand} />
      Hide zero on-hand items
    </label>
    <label class="chk">
      <input type="checkbox" bind:checked={onlyAffectsAverage} />
      Only lots still affecting avg
    </label>
  </div>

  <p class="hint">
    Showing {filteredRows.length} lot(s), {filteredLotQty} unit(s). These are receipt
    lots with zero JPY cost, non-stock-order source, and no cost order attached.
    {affectingRows} still affect the moving average.
  </p>

  <table>
    <thead>
      <tr>
        <th>Image</th>
        <th>Item</th>
        <th>Zero-scan dates</th>
        <th>Current lot</th>
        <th>Qty</th>
        <th>On hand</th>
        <th>Current avg</th>
        <th>Cost ledger</th>
        <th>Raw cost</th>
      </tr>
    </thead>
    <tbody>
      {#each filteredRows as row (`${row.key}:${row.at}:${row.seq}:${row.lotQty}`)}
        <tr>
          <td class="thumb-cell">
            {#if row.image}
              <ImageThumbnail
                src={row.image}
                alt={row.description}
                width="56px"
                height="56px"
              />
            {:else}
              <span class="no-thumb">-</span>
            {/if}
          </td>
          <td>
            <a href={`/itemhistory?itemKey=${encodeURIComponent(row.key)}`}>
              <strong>{row.key}</strong>
            </a>
            <div>{row.description}</div>
            {#if row.subtype}
              <span class="hint">{row.subtype}</span>
            {/if}
          </td>
          <td>
            <div>{uniqueDateLabels(row.zeroScanDates)}</div>
            <span class="hint"
              >{row.zeroScanDates.length} zero-cost scan lot(s)</span
            >
          </td>
          <td>
            <div>{fmtDate(row.at)}</div>
            <span class="hint">seq {row.seq} · {row.source || "-"}</span>
            <div class="hint">
              remaining from lot: {row.remainingLotQty} / {row.lotQty}
            </div>
            <div class="hint">
              avg impact: {row.affectsAverage ? "yes" : "no"}
            </div>
          </td>
          <td>{row.lotQty}</td>
          <td>{Math.max(0, row.itemQty - row.shipped)} / {row.itemQty}</td>
          <td>
            <div>{fmtYen(row.currentAvgJpy)}</div>
            <span class="hint">{fmtEur(row.currentAvgEur)}</span>
          </td>
          <td class="ledger-cell">
            {#each row.ledger as entry, index}
              <div class:target-entry={index === row.ledgerIndex}>
                {ledgerEntryLabel(entry)}
              </div>
            {/each}
          </td>
          <td>
            <div>{fmtYen(row.unitCostJpy)}</div>
            <span class="hint">{fmtEur(row.unitCostEur)}</span>
            <div class="hint">{row.receiptCount} receipt lot(s)</div>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</main>

<style>
  main {
    padding: 1rem;
  }
  h1 {
    font-size: 1.4rem;
    margin: 0 0 1rem;
  }
  .summary {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin: 0 0 1rem;
  }
  .summary > div {
    border: 1px solid #dee2e6;
    border-radius: 6px;
    padding: 0.55rem 0.75rem;
    min-width: 8rem;
  }
  .summary strong {
    display: block;
    font-size: 1.15rem;
  }
  .summary span,
  .hint {
    color: #666;
    font-size: 0.85rem;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 1rem;
    margin: 0 0 0.5rem;
  }
  label input:not([type]) {
    margin-left: 0.5rem;
    min-width: 20rem;
  }
  .chk input {
    margin-right: 0.35rem;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    margin-top: 1rem;
  }
  th,
  td {
    border: 1px solid #dee2e6;
    padding: 0.45rem 0.6rem;
    text-align: left;
    vertical-align: top;
    font-size: 0.9rem;
  }
  th {
    background: #f8f9fa;
  }
  .thumb-cell {
    width: 72px;
  }
  .ledger-cell {
    min-width: 18rem;
    max-width: 28rem;
    font-family:
      ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono",
      monospace;
    font-size: 0.78rem;
    line-height: 1.35;
  }
  .target-entry {
    color: #b42318;
    font-weight: 600;
  }
  .no-thumb {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 56px;
    height: 56px;
    color: #adb5bd;
    background: #f8f9fa;
    border: 1px solid #dee2e6;
    border-radius: 4px;
  }
  a {
    color: #0066cc;
  }
</style>
