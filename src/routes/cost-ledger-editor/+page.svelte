<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { firestore } from "$lib/firebase";
  import {
    set_cost_ledger_entry_qty,
    set_cost_ledger_entries_ignored,
    type CostLedgerEntryRef,
    type Item,
  } from "$lib/inventory";
  import { broadcast } from "$lib/redux-firestore";
  import { store } from "$lib/store";
  import { user } from "$lib/user-store";
  import { walkLedger, type LedgerEntry } from "$lib/cost-engine";

  type LedgerRow = {
    entry: LedgerEntry;
    index: number;
    running: ReturnType<typeof walkLedger>;
  };

  let search = "";
  let selectedKey = "";
  let reason = "";
  let status = "";
  let pending: Record<string, true> = {};
  let editingQtyKey = "";
  let qtyDraft = "";
  let qtyNote = "";
  let appliedSearchParam = "";

  $: paramKey = $page.url.searchParams.get("itemKey") || "";
  $: if (paramKey && paramKey !== selectedKey) selectedKey = paramKey;
  $: paramSearch = $page.url.searchParams.get("search") || "";
  $: if (paramSearch && paramSearch !== appliedSearchParam) {
    selectedKey = "";
    search = paramSearch;
    appliedSearchParam = paramSearch;
  }

  $: inventory = $store.inventory;
  $: idToItem = inventory?.idToItem || {};
  $: costLedger = inventory?.costLedger || {};
  $: selectedItem = selectedKey ? (idToItem[selectedKey] as Item) : null;
  $: selectedLedger = selectedKey
    ? sortedLedger(costLedger[selectedKey] || [])
    : [];
  $: ledgerRows = selectedLedger.map((entry, index, ledger) => ({
    entry,
    index,
    running: walkLedger(ledger.slice(0, index + 1)),
  }));
  $: current = walkLedger(selectedLedger);
  $: unignored = walkLedger(
    selectedLedger.map((entry) => ({ ...entry, ignored: false })),
  );
  $: query = search.trim().toLowerCase();
  $: matches = (
    query.length > 1
      ? Object.entries(idToItem)
          .filter(([key, item]: [string, any]) => {
            return (
              key.toLowerCase().includes(query) ||
              String(item?.janCode || "").includes(query) ||
              String(item?.description || "")
                .toLowerCase()
                .includes(query) ||
              String(item?.subtype || "")
                .toLowerCase()
                .includes(query)
            );
          })
          .slice(0, 50)
      : []
  ) as [string, Item][];

  function sortedLedger(ledger: readonly LedgerEntry[]): LedgerEntry[] {
    return [...ledger].sort((a, b) => a.at - b.at || a.seq - b.seq);
  }

  function fmtDate(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return "-";
    return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  }

  function fmtYen(n: number): string {
    return Number.isFinite(n) ? `¥${Math.round(n).toLocaleString()}` : "-";
  }

  function fmtEur(n: number): string {
    return Number.isFinite(n) && n > 0 ? `€${n.toFixed(2)}` : "-";
  }

  function rowKey(row: LedgerRow): string {
    return `${selectedKey}:${row.entry.kind}:${row.entry.at}:${row.entry.seq}:${row.index}`;
  }

  function entryRef(entry: LedgerEntry): CostLedgerEntryRef {
    if (entry.kind === "receipt") {
      return {
        kind: "receipt",
        at: entry.at,
        seq: entry.seq,
        qty: entry.qty,
        unitCostJpy: entry.unitCostJpy,
        unitCostEur: entry.unitCostEur,
        source: entry.source || "",
        costOrderId: entry.costOrderId || "",
      };
    }
    return {
      kind: "sale",
      at: entry.at,
      seq: entry.seq,
      qty: entry.qty,
      isArchive: Boolean(entry.isArchive),
    };
  }

  function selectKey(key: string) {
    selectedKey = key;
    search = "";
    status = "";
    editingQtyKey = "";
    goto(`/cost-ledger-editor?itemKey=${encodeURIComponent(key)}`);
  }

  async function toggleIgnored(row: LedgerRow, event: Event) {
    const ignored = (event.currentTarget as HTMLInputElement).checked;
    if (!$user.uid) {
      status = "Sign in before editing the cost ledger.";
      return;
    }
    const key = rowKey(row);
    pending = { ...pending, [key]: true };
    status = "";
    try {
      await broadcast(
        firestore,
        $user.uid,
        set_cost_ledger_entries_ignored({
          itemKey: selectedKey,
          refs: [entryRef(row.entry)],
          ignored,
          reason: reason.trim() || undefined,
        }),
      );
      status = `${ignored ? "Ignored" : "Restored"} row ${row.index + 1}.`;
    } catch (error) {
      status = error instanceof Error ? error.message : "Failed to save.";
    } finally {
      const next = { ...pending };
      delete next[key];
      pending = next;
    }
  }

  function startQtyEdit(row: LedgerRow) {
    editingQtyKey = rowKey(row);
    qtyDraft = String(row.entry.qty);
    qtyNote = "";
    status = "";
  }

  function cancelQtyEdit() {
    editingQtyKey = "";
    qtyDraft = "";
    qtyNote = "";
  }

  async function saveQtyEdit(row: LedgerRow) {
    if (!$user.uid) {
      status = "Sign in before editing the cost ledger.";
      return;
    }
    const qty = Number(qtyDraft);
    const note = qtyNote.trim();
    if (!Number.isFinite(qty) || qty < 0) {
      status = "Enter a non-negative quantity.";
      return;
    }
    if (!note) {
      status = "Enter an audit note for the quantity change.";
      return;
    }

    const key = rowKey(row);
    pending = { ...pending, [key]: true };
    status = "";
    try {
      await broadcast(
        firestore,
        $user.uid,
        set_cost_ledger_entry_qty({
          itemKey: selectedKey,
          ref: entryRef(row.entry),
          qty,
          note,
        }),
      );
      status = `Adjusted row ${row.index + 1} quantity.`;
      cancelQtyEdit();
    } catch (error) {
      status = error instanceof Error ? error.message : "Failed to save.";
    } finally {
      const next = { ...pending };
      delete next[key];
      pending = next;
    }
  }

  function entryLabel(entry: LedgerEntry): string {
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

  function sourceLabel(entry: LedgerEntry): string {
    if (entry.kind !== "receipt") return "-";
    return entry.costOrderId || entry.source || "-";
  }

  function fmtQty(n: number): string {
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
  }

  function noteLabel(entry: LedgerEntry): string {
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
    return notes.length ? notes.join("; ") : "-";
  }
</script>

<svelte:head><title>Cost Ledger Editor</title></svelte:head>

<main>
  <header>
    <div>
      <h1>Cost Ledger Editor</h1>
      <p class="sub">
        Hidden route for logged corrections to historical ledger rows.
      </p>
    </div>
    <div class="auth">
      {#if $user.uid}
        <span>{$user.email || $user.uid}</span>
      {:else}
        <span class="warn">Not signed in</span>
      {/if}
    </div>
  </header>

  <section class="toolbar">
    <label>
      Search item
      <input
        bind:value={search}
        placeholder="JAN, key, subtype, or description"
      />
    </label>
    <label>
      Reason
      <input bind:value={reason} placeholder="Optional audit note" />
    </label>
  </section>

  {#if matches.length > 0}
    <div class="matches">
      {#each matches as [key, item]}
        <button type="button" on:click={() => selectKey(key)}>
          <strong>{key}</strong>
          <span>{item.description}</span>
        </button>
      {/each}
    </div>
  {/if}

  {#if selectedKey && selectedItem}
    <section class="item-summary">
      <div>
        <h2>{selectedKey}</h2>
        <p>{selectedItem.description}</p>
      </div>
      <dl>
        <div>
          <dt>Qty</dt>
          <dd>{selectedItem.qty}</dd>
        </div>
        <div>
          <dt>Shipped</dt>
          <dd>{selectedItem.shipped || 0}</dd>
        </div>
        <div>
          <dt>Current Avg</dt>
          <dd>{fmtYen(current.avgJpy)}</dd>
        </div>
        <div>
          <dt>Unignored Avg</dt>
          <dd>{fmtYen(unignored.avgJpy)}</dd>
        </div>
      </dl>
    </section>

    <table>
      <thead>
        <tr>
          <th>Ignore</th>
          <th>Date</th>
          <th>Kind</th>
          <th class="num">Qty</th>
          <th>Adjust</th>
          <th class="num">Unit JPY</th>
          <th class="num">Unit EUR</th>
          <th>Source</th>
          <th>Notes</th>
          <th class="num">Running Qty</th>
          <th class="num">Running Avg</th>
        </tr>
      </thead>
      <tbody>
        {#each ledgerRows as row (rowKey(row))}
          <tr
            class:ignored={row.entry.ignored}
            class:audit-warning={row.entry.auditSeverity === "warning"}
            class:audit-danger={row.entry.auditSeverity === "danger"}
          >
            <td>
              <input
                type="checkbox"
                checked={Boolean(row.entry.ignored)}
                disabled={!$user.uid || pending[rowKey(row)]}
                on:change={(event) => toggleIgnored(row, event)}
                aria-label={`Ignore ledger row ${row.index + 1}`}
              />
            </td>
            <td class="date">{fmtDate(row.entry.at)}</td>
            <td>{entryLabel(row.entry)}</td>
            <td class="num">{row.entry.qty}</td>
            <td>
              <button
                type="button"
                class="small"
                disabled={!$user.uid || pending[rowKey(row)]}
                on:click={() => startQtyEdit(row)}
              >
                Adjust qty
              </button>
            </td>
            <td class="num">
              {#if row.entry.kind === "receipt"}{fmtYen(
                  row.entry.unitCostJpy,
                )}{:else}-{/if}
            </td>
            <td class="num">
              {#if row.entry.kind === "receipt"}{fmtEur(
                  row.entry.unitCostEur,
                )}{:else}-{/if}
            </td>
            <td>{sourceLabel(row.entry)}</td>
            <td>{noteLabel(row.entry)}</td>
            <td class="num">{row.running.onHand}</td>
            <td class="num">{fmtYen(row.running.avgJpy)}</td>
          </tr>
          {#if editingQtyKey === rowKey(row)}
            <tr class="qty-editor">
              <td colspan="11">
                <div class="qty-editor-controls">
                  <label>
                    Quantity
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      bind:value={qtyDraft}
                    />
                  </label>
                  <label class="note-input">
                    Audit note
                    <input
                      bind:value={qtyNote}
                      placeholder="Required note for this adjustment"
                    />
                  </label>
                  <div class="qty-editor-actions">
                    <button
                      type="button"
                      class="small primary"
                      disabled={pending[rowKey(row)]}
                      on:click={() => saveQtyEdit(row)}
                    >
                      Save qty
                    </button>
                    <button
                      type="button"
                      class="small"
                      disabled={pending[rowKey(row)]}
                      on:click={cancelQtyEdit}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  {:else if selectedKey}
    <p class="empty">No item found for {selectedKey}.</p>
  {:else}
    <p class="empty">Search for an item to edit its cost ledger.</p>
  {/if}

  {#if status}
    <p class="status">{status}</p>
  {/if}
</main>

<style>
  main {
    padding: 1rem;
  }
  header,
  .toolbar,
  .item-summary,
  dl {
    display: flex;
    gap: 1rem;
  }
  header {
    align-items: flex-start;
    justify-content: space-between;
    margin-bottom: 1rem;
  }
  h1,
  h2,
  p {
    margin: 0;
  }
  h1 {
    font-size: 1.4rem;
  }
  h2 {
    font-size: 1rem;
  }
  .sub,
  .empty,
  .status,
  .auth {
    color: #666;
    font-size: 0.9rem;
  }
  .warn {
    color: #b42318;
    font-weight: 600;
  }
  .toolbar {
    flex-wrap: wrap;
    margin-bottom: 0.75rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.85rem;
    color: #444;
  }
  label input {
    min-width: 22rem;
    padding: 0.45rem 0.55rem;
    border: 1px solid #d0d7de;
    border-radius: 4px;
  }
  .matches {
    max-width: 56rem;
    border: 1px solid #d0d7de;
    border-radius: 4px;
    margin-bottom: 1rem;
    overflow: hidden;
  }
  .matches button {
    display: flex;
    gap: 0.75rem;
    width: 100%;
    padding: 0.45rem 0.6rem;
    border: 0;
    border-bottom: 1px solid #e5e7eb;
    background: #fff;
    text-align: left;
    cursor: pointer;
  }
  .matches button:hover {
    background: #f6f8fa;
  }
  .item-summary {
    align-items: flex-start;
    justify-content: space-between;
    margin: 1rem 0;
  }
  dl {
    flex-wrap: wrap;
    margin: 0;
  }
  dl > div {
    min-width: 6.5rem;
    border: 1px solid #d0d7de;
    border-radius: 4px;
    padding: 0.45rem 0.6rem;
  }
  dt {
    color: #666;
    font-size: 0.78rem;
  }
  dd {
    margin: 0;
    font-weight: 600;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th,
  td {
    border: 1px solid #d0d7de;
    padding: 0.45rem 0.55rem;
    text-align: left;
    vertical-align: top;
    font-size: 0.88rem;
  }
  th {
    background: #f6f8fa;
  }
  tr.ignored {
    color: #6b7280;
    text-decoration: line-through;
  }
  tr.audit-warning {
    background: #fff8db;
  }
  tr.audit-danger {
    background: #ffe8ee;
  }
  .small {
    padding: 0.25rem 0.45rem;
    border: 1px solid #d0d7de;
    border-radius: 4px;
    background: #fff;
    cursor: pointer;
    font-size: 0.8rem;
  }
  .small:hover:not(:disabled) {
    background: #f6f8fa;
  }
  .small.primary {
    border-color: #0969da;
    background: #0969da;
    color: #fff;
  }
  .small:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }
  tr.qty-editor {
    background: #f6f8fa;
  }
  .qty-editor-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 0.75rem;
  }
  .qty-editor-controls label input {
    min-width: 8rem;
  }
  .qty-editor-controls .note-input {
    flex: 1 1 24rem;
  }
  .qty-editor-controls .note-input input {
    width: 100%;
  }
  .qty-editor-actions {
    display: flex;
    gap: 0.5rem;
  }
  .date {
    white-space: nowrap;
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .status {
    margin-top: 0.75rem;
  }
</style>
