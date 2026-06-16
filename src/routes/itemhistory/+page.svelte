<script lang="ts">
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { auth, firestore, googleAuthProvider } from "$lib/firebase";
  import { hide_archive, make_sales, type OrderInfo } from "$lib/inventory";
  import OrderRow from "$lib/OrderRow.svelte";
  import { broadcast } from "$lib/redux-firestore";
  import Signin, { type User } from "$lib/Signin.svelte";
  import { store } from "$lib/store";
  import ImageThumbnail from "$lib/components/ImageThumbnail.svelte";
  import ItemCard from "$lib/components/ItemCard.svelte";
  import {
    walkLedger,
    archiveSweepDivergences,
    zeroCostBlendWarnings,
    type ArchiveSweepDivergence,
    type ZeroCostBlend,
    type LedgerEntry,
  } from "$lib/cost-engine";

  let me: User = { signedIn: false };
  let searchQuery = "";

  $: itemKey = $page.url.searchParams.get("itemKey");
  $: normalizedItemKey = (itemKey || "").trim();
  $: currentItem =
    normalizedItemKey && $store.inventory?.idToItem
      ? $store.inventory.idToItem[normalizedItemKey]
      : null;
  $: currentLedger =
    normalizedItemKey && $store.inventory?.costLedger?.[normalizedItemKey]
      ? $store.inventory.costLedger[normalizedItemKey]
      : [];
  $: ledgerRows = sortedLedger(currentLedger).map((entry, index, ledger) => ({
    entry,
    running: walkLedger(ledger.slice(0, index + 1)),
  }));
  $: archiveDivergenceById = new Map<string, ArchiveSweepDivergence>(
    archiveSweepDivergences(currentLedger)
      .filter((d): d is ArchiveSweepDivergence & { id: string } =>
        Boolean(d.id),
      )
      .map((d) => [d.id, d]),
  );
  $: zeroCostBlendById = new Map<string, ZeroCostBlend>(
    zeroCostBlendWarnings(currentLedger)
      .filter((b): b is ZeroCostBlend & { id: string } => Boolean(b.id))
      .map((b) => [b.id, b]),
  );
  $: janMatches = findJanMatches(normalizedItemKey);
  $: subtypeMatches = currentItem ? [] : janMatches;
  $: relatedSubtypeMatches =
    currentItem?.janCode === normalizedItemKey
      ? janMatches.filter(([key]) => key !== normalizedItemKey)
      : [];

  $: allMatches = (
    searchQuery.length > 2 && $store.inventory?.idToItem
      ? Object.entries($store.inventory.idToItem).filter(
          ([key, item]: [string, any]) => {
            const q = searchQuery.toLowerCase();
            return (
              (item.janCode && item.janCode.includes(q)) ||
              (item.description &&
                item.description.toLowerCase().includes(q)) ||
              key.toLowerCase().includes(q)
            );
          },
        )
      : []
  ) as [string, any][];

  $: searchResults = allMatches.slice(0, 100);
  $: truncatedCount = Math.max(0, allMatches.length - 100);

  function user(e: CustomEvent) {
    me = e.detail;
  }

  function selectItem(key: string) {
    goto(`/itemhistory?itemKey=${encodeURIComponent(key)}`);
    searchQuery = ""; // Clear search or keep it? Clearing feels cleaner once selected.
  }

  function findJanMatches(key: string): [string, any][] {
    const idToItem = $store.inventory?.idToItem;
    if (!key || !idToItem) return [];
    return Object.entries(idToItem)
      .filter(([, item]: [string, any]) => item?.janCode === key)
      .sort(
        (
          [leftKey, leftItem]: [string, any],
          [rightKey, rightItem]: [string, any],
        ) => {
          const leftSubtype = String(leftItem.subtype || "");
          const rightSubtype = String(rightItem.subtype || "");
          return (
            leftSubtype.localeCompare(rightSubtype) ||
            leftKey.localeCompare(rightKey)
          );
        },
      );
  }

  function sortedLedger(ledger: readonly LedgerEntry[]): LedgerEntry[] {
    return [...ledger].sort((a, b) => a.at - b.at || a.seq - b.seq);
  }

  function fmtDate(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return "-";
    return new Date(ms).toISOString().slice(0, 10);
  }

  function fmtYen(n: number | undefined): string {
    return Number.isFinite(n)
      ? `¥${Math.round(n as number).toLocaleString()}`
      : "-";
  }

  function fmtEur(n: number | undefined): string {
    return Number.isFinite(n) && (n as number) > 0
      ? `€${(n as number).toFixed(2)}`
      : "-";
  }

  function ledgerKind(entry: LedgerEntry): string {
    if (entry.kind === "sale") {
      if (entry.auditComment) {
        return entry.isArchive ? "adjusted archive sale" : "adjusted sale";
      }
      return entry.isArchive ? "archive sale" : "sale";
    }
    if (entry.auditComment || entry.quantityCorrections?.length) {
      return "adjusted receipt";
    }
    return "receipt";
  }

  function archiveDivergenceFor(
    entry: LedgerEntry,
  ): ArchiveSweepDivergence | undefined {
    return entry.id ? archiveDivergenceById.get(entry.id) : undefined;
  }

  function zeroCostBlendFor(entry: LedgerEntry): ZeroCostBlend | undefined {
    return entry.id ? zeroCostBlendById.get(entry.id) : undefined;
  }

  function ledgerSource(entry: LedgerEntry): string {
    if (entry.kind !== "receipt") return "-";
    return entry.source || "-";
  }

  function fmtQty(n: number): string {
    if (!Number.isFinite(n)) return "-";
    const rounded = Math.round(n * 1000) / 1000;
    if (Math.abs(rounded) < 0.0005) return "0";
    return Number.isInteger(rounded)
      ? String(rounded)
      : rounded.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  }

  function ledgerNote(entry: LedgerEntry): string {
    const notes: string[] = [];
    if (entry.kind === "receipt" && entry.quantityCorrections?.length) {
      const reduced = entry.quantityCorrections.reduce(
        (sum, correction) => sum + correction.reducedBy,
        0,
      );
      notes.push(`qty correction -${fmtQty(reduced)}`);
      const requested = entry.quantityCorrections.find(
        (correction) => correction.requestedVisibleQty !== undefined,
      );
      if (requested?.requestedVisibleQty !== undefined) {
        notes.push(
          `requested visible ${fmtQty(requested.requestedVisibleQty)}`,
        );
      }
    }
    if (entry.originalQty !== undefined) {
      notes.push(`original qty ${fmtQty(entry.originalQty)}`);
    }
    if (entry.auditComment) notes.push(entry.auditComment);
    if (entry.ignoreReason) notes.push(entry.ignoreReason);
    if (entry.ignored && !entry.ignoreReason) notes.push("ignored");
    return notes.join("; ");
  }

  function subtypeLabel(item: any, key: string): string {
    return item?.subtype ? String(item.subtype) : key;
  }

  function onHand(item: any): number {
    return (Number(item?.qty) || 0) - (Number(item?.shipped) || 0);
  }
</script>

<div class="page-container">
  <div class="search-section">
    <input
      type="text"
      placeholder="Search JAN or Title..."
      bind:value={searchQuery}
      class="search-input"
    />
    {#if searchResults.length > 0}
      <div class="search-results">
        {#each searchResults as [key, item]}
          <button class="result-item" on:click={() => selectItem(key)}>
            <div class="result-thumb">
              {#if item.image}
                <ImageThumbnail
                  src={item.image}
                  alt={item.description}
                  width="30px"
                  height="30px"
                />
              {/if}
            </div>
            <div class="result-info">
              <span class="result-jan">{item.janCode}</span>
              <span class="result-desc">{item.description}</span>
            </div>
          </button>
        {/each}
        {#if truncatedCount > 0}
          <div class="result-truncated">
            +{truncatedCount} more...
          </div>
        {/if}
      </div>
    {/if}
  </div>

  {#if itemKey}
    <h1 class="page-title">Item History</h1>
    {#if subtypeMatches.length > 0}
      <section class="subtype-section">
        <h2 class="history-title">Choose a subtype for {normalizedItemKey}</h2>
        <p class="muted">
          This JAN has multiple inventory entries. Open a specific subtype to
          view its item history and cost ledger.
        </p>
        <div class="subtype-list">
          {#each subtypeMatches as [key, item]}
            <button class="subtype-row" on:click={() => selectItem(key)}>
              <div class="subtype-thumb">
                {#if item.image}
                  <ImageThumbnail
                    src={item.image}
                    alt={item.description}
                    width="48px"
                    height="48px"
                  />
                {/if}
              </div>
              <div class="subtype-main">
                <span class="subtype-name">{subtypeLabel(item, key)}</span>
                <span class="subtype-desc">{item.description || key}</span>
                <span class="muted">{key}</span>
              </div>
              <div class="subtype-counts">
                <span>Qty {fmtQty(item.qty || 0)}</span>
                <span>Shipped {fmtQty(item.shipped || 0)}</span>
                <span>On hand {fmtQty(onHand(item))}</span>
              </div>
            </button>
          {/each}
        </div>
      </section>
    {:else}
      <ItemCard
        item={currentItem}
        itemKey={normalizedItemKey}
        ledger={currentLedger}
      />
      {#if relatedSubtypeMatches.length > 0}
        <section class="subtype-section">
          <h2 class="history-title">Other entries for {normalizedItemKey}</h2>
          <div class="subtype-list">
            {#each relatedSubtypeMatches as [key, item]}
              <button class="subtype-row" on:click={() => selectItem(key)}>
                <div class="subtype-thumb">
                  {#if item.image}
                    <ImageThumbnail
                      src={item.image}
                      alt={item.description}
                      width="48px"
                      height="48px"
                    />
                  {/if}
                </div>
                <div class="subtype-main">
                  <span class="subtype-name">{subtypeLabel(item, key)}</span>
                  <span class="subtype-desc">{item.description || key}</span>
                  <span class="muted">{key}</span>
                </div>
                <div class="subtype-counts">
                  <span>Qty {fmtQty(item.qty || 0)}</span>
                  <span>Shipped {fmtQty(item.shipped || 0)}</span>
                  <span>On hand {fmtQty(onHand(item))}</span>
                </div>
              </button>
            {/each}
          </div>
        </section>
      {/if}

      <h2 class="history-title">Cost Ledger</h2>
      {#if ledgerRows.length > 0}
        <table class="ledger-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Kind</th>
              <th>Qty</th>
              <th>Unit Cost</th>
              <th>Source</th>
              <th>Running On Hand</th>
              <th>Running Avg</th>
            </tr>
          </thead>
          <tbody>
            {#each ledgerRows as row}
              {@const divergence = archiveDivergenceFor(row.entry)}
              {@const zeroBlend = zeroCostBlendFor(row.entry)}
              <tr
                class:ignored={row.entry.ignored}
                class:audit-warning={row.entry.auditSeverity === "warning" ||
                  Boolean(divergence) ||
                  Boolean(zeroBlend)}
                class:audit-danger={row.entry.auditSeverity === "danger"}
              >
                <td class="date-col">{fmtDate(row.entry.at)}</td>
                <td>{ledgerKind(row.entry)}</td>
                <td>{fmtQty(row.entry.qty)}</td>
                <td>
                  {#if row.entry.kind === "receipt"}
                    <div>{fmtYen(row.entry.unitCostJpy)}</div>
                    <span class="muted">{fmtEur(row.entry.unitCostEur)}</span>
                  {:else}
                    <span class="muted">-</span>
                  {/if}
                </td>
                <td>
                  <div>{ledgerSource(row.entry)}</div>
                  {#if row.entry.kind === "receipt" && row.entry.costOrderId}
                    <span class="muted">{row.entry.costOrderId}</span>
                  {/if}
                  {#if ledgerNote(row.entry)}
                    <div class="audit-note">{ledgerNote(row.entry)}</div>
                  {/if}
                  {#if divergence}
                    <div class="audit-note">
                      Swept {fmtQty(divergence.sweptQty)} unit(s); {fmtQty(
                        divergence.recordedQty,
                      )} recorded at archive time. The swept quantity changed because
                      of a later audit action.
                    </div>
                  {/if}
                  {#if zeroBlend}
                    <div class="audit-note">
                      Zero-cost blend: {fmtQty(zeroBlend.existingQty)} unit(s) @ {fmtYen(
                        zeroBlend.existingAvgJpy,
                      )} averaged with {fmtQty(zeroBlend.receiptQty)} @ {fmtYen(
                        zeroBlend.receiptUnitJpy,
                      )} — a ¥0 lot dilutes the cost basis. Set a cost for the uncosted
                      lot.
                    </div>
                  {/if}
                </td>
                <td>{fmtQty(row.running.onHand)}</td>
                <td>
                  <div>{fmtYen(row.running.avgJpy)}</div>
                  <span class="muted">{fmtEur(row.running.avgEur)}</span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="muted">No cost ledger entries.</p>
      {/if}

      <h2 class="history-title">History</h2>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {#each [...($store.inventory?.idToHistory?.[normalizedItemKey] || [])].reverse() as history}
            <tr>
              <td class="date-col">{history.date}</td>
              <td>{history.desc}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {:else}
    <div class="empty-state">
      <h1>Item History</h1>
      <p>Search for an item to view its history.</p>
    </div>
  {/if}

  <div class="auth-wrapper">
    <Signin {auth} {googleAuthProvider} on:user_changed={user} />
  </div>
</div>

<style>
  .page-container {
    max-width: 800px;
    margin: 0 auto;
    padding: 2rem;
  }

  .search-section {
    position: relative;
    margin-bottom: 2rem;
  }

  .search-input {
    width: 100%;
    padding: 0.75rem;
    font-size: 1rem;
    border: 1px solid #ccc;
    border-radius: 4px;
  }

  .search-results {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    background: white;
    border: 1px solid #ccc;
    border-top: none;
    border-radius: 0 0 4px 4px;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    z-index: 10;
    max-height: 300px;
    overflow-y: auto;
  }

  .result-item {
    display: flex;
    align-items: center;
    gap: 1rem;
    width: 100%;
    padding: 0.5rem 1rem;
    border: none;
    background: none;
    text-align: left;
    cursor: pointer;
    border-bottom: 1px solid #eee;
  }

  .result-item:hover {
    background: #f9f9f9;
  }

  .result-thumb {
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #eee;
  }
  .result-info {
    display: flex;
    flex-direction: column;
  }
  .result-jan {
    font-weight: bold;
    font-size: 0.85rem;
  }
  .result-desc {
    font-size: 0.8rem;
    color: #666;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 300px;
  }

  .page-title {
    margin: 0 0 1rem;
    font-size: 1.5rem;
    color: #111827;
  }
  .history-title {
    margin: 2rem 0 0.75rem;
    font-size: 1.25rem;
    color: #111827;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    border: 1px solid #eee;
  }

  .ledger-table {
    font-size: 0.9rem;
  }

  .muted {
    color: #666;
    font-size: 0.85rem;
  }

  th,
  td {
    border: 1px solid #eee;
    padding: 0.75rem;
    text-align: left;
    vertical-align: top;
  }

  th {
    background-color: #f9fafb;
    font-weight: 600;
  }

  tr.audit-warning {
    background: #fff8db;
  }

  tr.audit-danger {
    background: #ffe8ee;
  }

  tr.ignored {
    color: #6b7280;
    text-decoration: line-through;
  }

  tr.ignored .audit-note {
    text-decoration: none;
  }

  .audit-note {
    margin-top: 0.35rem;
    color: #7a4d00;
    font-size: 0.8rem;
    line-height: 1.35;
  }

  .subtype-section {
    margin-top: 1rem;
  }

  .subtype-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 1rem;
  }

  .subtype-row {
    display: grid;
    grid-template-columns: 56px minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.75rem;
    border: 1px solid #e5e7eb;
    border-radius: 4px;
    background: #fff;
    cursor: pointer;
    text-align: left;
  }

  .subtype-row:hover {
    background: #f9fafb;
    border-color: #d1d5db;
  }

  .subtype-thumb {
    width: 48px;
    height: 48px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #f3f4f6;
    border: 1px solid #e5e7eb;
  }

  .subtype-main,
  .subtype-counts {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .subtype-name {
    font-weight: 700;
    color: #111827;
  }

  .subtype-desc {
    color: #374151;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .subtype-counts {
    color: #374151;
    font-size: 0.85rem;
    gap: 0.1rem;
    white-space: nowrap;
  }

  .date-col {
    white-space: nowrap;
    color: #666;
    font-size: 0.9rem;
  }

  .result-truncated {
    padding: 0.5rem 1rem;
    text-align: center;
    color: #666;
    font-size: 0.85rem;
    background: #f9f9f9;
    border-top: 1px solid #eee;
  }

  .empty-state {
    text-align: center;
    color: #666;
    margin-top: 4rem;
  }
  .auth-wrapper {
    margin-top: 2rem;
    text-align: right;
  }

  @media (max-width: 640px) {
    .subtype-row {
      grid-template-columns: 48px minmax(0, 1fr);
    }

    .subtype-counts {
      grid-column: 2;
      flex-direction: row;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
  }
</style>
