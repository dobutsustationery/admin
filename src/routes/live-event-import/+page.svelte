<script lang="ts">
  import { store } from "$lib/store";
  import { user } from "$lib/user-store";
  import { firestore } from "$lib/firebase";
  import { broadcast } from "$lib/redux-firestore";
  import ImageThumbnail from "$lib/components/ImageThumbnail.svelte";
  import {
    set_paste,
    toggle_row_approval,
    set_all_approvals,
    clear_import,
    commit_import,
    type LiveEventRawRow,
    type LiveEventImportItem,
  } from "$lib/live-event-import-slice";
  import { makeInventoryItemKey } from "$lib/sku";

  let localPaste = "";
  let statusMessage = "";
  let rows: LiveEventRawRow[] = [];

  $: importState = $store.liveEventImport;
  $: rows = (importState.rows || []) as LiveEventRawRow[];
  $: localPaste = importState.rawPaste || localPaste;

  const trim = (value: unknown) =>
    typeof value === "string" ? value.trim() : "";

  function findInventoryMatch(item: LiveEventImportItem): {
    key: string;
    item: any;
    matchType: "exact" | "jan";
  } | null {
    const exactKey = makeInventoryItemKey(item.janCode, item.subtype);
    const exact = $store.inventory.idToItem[exactKey];
    if (exact) return { key: exactKey, item: exact, matchType: "exact" };

    const janMatches = Object.entries($store.inventory.idToItem)
      .filter(([, inventoryItem]: [string, any]) => {
        return trim(inventoryItem?.janCode) === item.janCode;
      })
      .map(([key, inventoryItem]) => ({ key, item: inventoryItem }));

    if (janMatches.length === 1) {
      return { ...janMatches[0], matchType: "jan" };
    }

    return null;
  }

  function available(item: any): number {
    return Number(item?.qty || 0) - Number(item?.shipped || 0);
  }

  function rowAnalysis(row: LiveEventRawRow) {
    if (row.processed) return { status: "Done", className: "done" };
    if (row.error || !row.parsed) {
      return { status: row.error || "Skipped", className: "error" };
    }

    const match = findInventoryMatch(row.parsed);
    if (!match) return { status: "Missing item", className: "error" };

    const currentAvailable = available(match.item);
    const projected = currentAvailable - row.parsed.sold;
    if (projected < 0) {
      return {
        status: "Oversold",
        className: "warning",
        match,
        currentAvailable,
        projected,
      };
    }

    return {
      status: row.parsed.sold > 0 ? "Ready" : "No sale",
      className: row.parsed.sold > 0 ? "ready" : "muted",
      match,
      currentAvailable,
      projected,
    };
  }

  $: readyRows = rows.filter((row: LiveEventRawRow) => {
    if (!row.approved || row.processed || row.error || !row.parsed)
      return false;
    return !!findInventoryMatch(row.parsed);
  });
  $: approvedSoldCount = readyRows.reduce(
    (sum: number, row: LiveEventRawRow) => sum + Number(row.parsed?.sold || 0),
    0,
  );
  $: totalSoldCount = rows.reduce(
    (sum: number, row: LiveEventRawRow) => sum + Number(row.parsed?.sold || 0),
    0,
  );
  $: approvedRowCount = readyRows.length;
  $: errorCount = rows.filter((row: LiveEventRawRow) => {
    const analysis = rowAnalysis(row);
    return analysis.className === "error";
  }).length;
  $: doneCount = rows.filter((row: LiveEventRawRow) => row.processed).length;

  function broadcastAction(action: any) {
    if (!$user?.uid) {
      statusMessage = "Sign in before saving changes.";
      return;
    }
    broadcast(firestore, $user.uid, action);
  }

  function applyPaste(rawPaste = localPaste) {
    statusMessage = "";
    broadcastAction(set_paste({ rawPaste }));
  }

  function handlePaste(event: ClipboardEvent) {
    const text = event.clipboardData?.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    localPaste = text;
    applyPaste(text);
  }

  function toggleApproval(index: number, approved: boolean) {
    broadcastAction(toggle_row_approval({ index, approved }));
  }

  function approveAll(approved: boolean) {
    broadcastAction(set_all_approvals({ approved }));
  }

  function clearImport() {
    localPaste = "";
    statusMessage = "";
    broadcastAction(clear_import());
  }

  function commitSales() {
    statusMessage = "";
    broadcastAction(commit_import());
    statusMessage = "Approved sales committed.";
  }
</script>

<svelte:head>
  <title>Live Event Import</title>
</svelte:head>

<section class="page">
  <header class="toolbar">
    <div>
      <h1>Live Event Import</h1>
      <div class="meta">
        {#if importState.eventName}
          {importState.eventName}
        {:else}
          Manual event
        {/if}
        · {rows.length} rows · {totalSoldCount} sold
      </div>
    </div>

    <div class="actions">
      <button type="button" on:click={() => approveAll(true)}>
        Approve all
      </button>
      <button type="button" on:click={() => approveAll(false)}>
        Unapprove all
      </button>
      <button type="button" class="secondary" on:click={clearImport}>
        Clear
      </button>
      <button
        type="button"
        class="primary"
        disabled={approvedRowCount === 0}
        on:click={commitSales}
      >
        Commit {approvedSoldCount} sales
      </button>
    </div>
  </header>

  <div class="summary">
    <div>
      <strong>{approvedRowCount}</strong>
      <span>approved rows</span>
    </div>
    <div>
      <strong>{doneCount}</strong>
      <span>committed rows</span>
    </div>
    <div class:error={errorCount > 0}>
      <strong>{errorCount}</strong>
      <span>needs attention</span>
    </div>
  </div>

  <div class="paste-panel">
    <label for="live-event-paste">Paste TSV or CSV</label>
    <textarea
      id="live-event-paste"
      bind:value={localPaste}
      on:paste={handlePaste}
      on:change={() => applyPaste()}
      spellcheck="false"
      placeholder="janCode, subtype, description, taking, returned, sold"
    />
    <button type="button" on:click={() => applyPaste()}>Parse paste</button>
  </div>

  {#if statusMessage}
    <div class="status">{statusMessage}</div>
  {/if}

  {#if rows.length > 0}
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Approve</th>
            <th>Status</th>
            <th>Image</th>
            <th>JAN</th>
            <th>Subtype</th>
            <th>Description</th>
            <th class="number">System</th>
            <th class="number">Office</th>
            <th class="number">Taken</th>
            <th class="number">Returned</th>
            <th class="number">Sold</th>
            <th class="number">Available</th>
            <th class="number">After</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row, index}
            {@const analysis = rowAnalysis(row)}
            <tr class={analysis.className}>
              <td>
                <input
                  type="checkbox"
                  checked={row.approved}
                  disabled={!!row.error || row.processed}
                  on:change={(event) =>
                    toggleApproval(index, event.currentTarget.checked)}
                />
              </td>
              <td>
                <span class="pill">{analysis.status}</span>
                {#if row.warnings?.length}
                  <div class="warning-text">{row.warnings.join(" ")}</div>
                {/if}
              </td>
              <td>
                {#if row.parsed?.image}
                  <div class="thumb">
                    <ImageThumbnail
                      src={row.parsed.image}
                      alt={row.parsed.description}
                      width="48px"
                      height="48px"
                      fit="contain"
                    />
                  </div>
                {/if}
              </td>
              <td>{row.parsed?.janCode || ""}</td>
              <td>{row.parsed?.subtype || "Default"}</td>
              <td class="description">{row.parsed?.description || row.error}</td
              >
              <td class="number">{row.parsed?.systemCount ?? ""}</td>
              <td class="number">{row.parsed?.actualOfficeCount ?? ""}</td>
              <td class="number">{row.parsed?.taking ?? ""}</td>
              <td class="number">{row.parsed?.returned ?? ""}</td>
              <td class="number sold">{row.parsed?.sold ?? ""}</td>
              <td class="number">{analysis.currentAvailable ?? ""}</td>
              <td class="number">{analysis.projected ?? ""}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  .page {
    padding: 24px;
    max-width: 1600px;
    margin: 0 auto;
  }

  .toolbar {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    align-items: flex-start;
    margin-bottom: 16px;
  }

  h1 {
    margin: 0;
    font-size: 1.75rem;
  }

  .meta {
    color: #58606f;
    margin-top: 4px;
  }

  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  button {
    border: 1px solid #c8ced8;
    background: #fff;
    border-radius: 6px;
    padding: 8px 12px;
    cursor: pointer;
    font-weight: 600;
  }

  button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .primary {
    background: #1f6f52;
    color: white;
    border-color: #1f6f52;
  }

  .secondary {
    color: #6b2530;
  }

  .summary {
    display: grid;
    grid-template-columns: repeat(3, minmax(120px, 1fr));
    gap: 1px;
    border: 1px solid #d8dee8;
    border-radius: 8px;
    overflow: hidden;
    margin-bottom: 16px;
    max-width: 640px;
  }

  .summary > div {
    background: #f7f9fb;
    padding: 12px;
  }

  .summary strong {
    display: block;
    font-size: 1.4rem;
  }

  .summary span {
    color: #596273;
    font-size: 0.85rem;
  }

  .summary .error strong {
    color: #9a3412;
  }

  .paste-panel {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 8px;
    align-items: end;
    margin-bottom: 16px;
  }

  .paste-panel label {
    grid-column: 1 / -1;
    font-weight: 700;
  }

  textarea {
    min-height: 130px;
    resize: vertical;
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
      monospace;
    border: 1px solid #c8ced8;
    border-radius: 8px;
    padding: 12px;
    font-size: 0.9rem;
  }

  .status {
    margin-bottom: 12px;
    color: #1f6f52;
    font-weight: 600;
  }

  .table-wrap {
    overflow: auto;
    border: 1px solid #d8dee8;
    border-radius: 8px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    min-width: 1180px;
  }

  th,
  td {
    padding: 8px;
    border-bottom: 1px solid #e5e9f0;
    text-align: left;
    vertical-align: middle;
    font-size: 0.9rem;
  }

  th {
    position: sticky;
    top: 0;
    background: #f4f6f9;
    z-index: 1;
  }

  tr.done {
    color: #697386;
    background: #f8fafc;
  }

  tr.error {
    background: #fff7ed;
  }

  tr.warning {
    background: #fffbeb;
  }

  .number {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .sold {
    font-weight: 700;
  }

  .description {
    min-width: 260px;
    max-width: 420px;
  }

  .thumb {
    width: 48px;
    height: 48px;
  }

  .pill {
    display: inline-block;
    min-width: 72px;
    border-radius: 999px;
    background: #edf2f7;
    padding: 4px 8px;
    text-align: center;
    font-size: 0.8rem;
    font-weight: 700;
  }

  .warning-text {
    color: #9a3412;
    font-size: 0.78rem;
    margin-top: 4px;
    max-width: 280px;
  }

  @media (max-width: 820px) {
    .page {
      padding: 16px;
    }

    .toolbar {
      display: block;
    }

    .actions {
      justify-content: flex-start;
      margin-top: 12px;
    }

    .summary {
      grid-template-columns: 1fr;
    }

    .paste-panel {
      grid-template-columns: 1fr;
    }
  }
</style>
