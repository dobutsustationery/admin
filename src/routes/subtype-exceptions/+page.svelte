<script lang="ts">
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { firestore } from "$lib/firebase";
  import {
    replace_subtype,
    resolve_subtype_exception,
    type Item,
  } from "$lib/inventory";
  import { broadcast } from "$lib/redux-firestore";
  import { store } from "$lib/store";
  import ImageThumbnail from "$lib/components/ImageThumbnail.svelte";
  import {
    previewMergeSubtypesToBare,
    previewReplaceSubtype,
    previewSplitBareToSubtypes,
    selectSubtypeExceptions,
    selectSubtypeRowsForJan,
    type SubtypeException,
  } from "$lib/subtype-exceptions";
  import { user } from "$lib/user-store";

  type AllocationDraft = { subtype: string; qty: string };

  let statusMessage = "";
  let lastJan = "";
  let allocations: AllocationDraft[] = [];
  let orderMoveTargets: Record<string, string> = {};
  let replaceSourceKey = "";
  let replaceTargetKey = "";
  let replaceReason = "";
  let search = "";

  $: exceptions = selectSubtypeExceptions($store.inventory);
  $: idToItem = $store.inventory?.idToItem || {};
  $: selectedJan = $page.url.searchParams.get("jan") || "";
  $: current = selectedJan
    ? exceptions.find((exception) => exception.janCode === selectedJan)
    : undefined;
  $: selectedJanRows = selectedJan
    ? selectSubtypeRowsForJan($store.inventory, selectedJan)
    : [];
  $: currentRows = current
    ? [current.bare, ...current.subtyped]
    : selectedJanRows;
  $: subtypeRows = currentRows.filter(
    (row) => row.key !== makeBareKey(selectedJan || current?.janCode || ""),
  );
  $: selectedItemKey = $page.url.searchParams.get("itemKey") || "";
  $: if (current && current.janCode !== lastJan) {
    resetDraft(current, selectedItemKey);
  } else if (!current && selectedJan && selectedJan !== lastJan) {
    resetReplacementDraft(selectedJanRows, selectedItemKey);
  }
  $: bareOrderLines = current
    ? current.orders.filter((line) => line.itemKey === current.bare.key)
    : [];
  $: splitAllocations = allocations
    .map((allocation) => ({
      subtype: allocation.subtype.trim(),
      qty: Number(allocation.qty) || 0,
    }))
    .filter((allocation) => allocation.subtype);
  $: splitOrderMoves = current
    ? bareOrderLines.map((line, index) => ({
        orderID: line.orderID,
        subtype:
          orderMoveTargets[orderLineKey(line.orderID, index)] ||
          splitAllocations[0]?.subtype ||
          "",
        qty: line.qty,
      }))
    : [];
  $: splitPreview = current
    ? previewSplitBareToSubtypes(current, splitAllocations, splitOrderMoves)
    : null;
  $: mergePreview = current ? previewMergeSubtypesToBare(current) : null;
  $: replacePreview =
    replaceSourceKey && replaceTargetKey
      ? previewReplaceSubtype(
          $store.inventory,
          replaceSourceKey,
          replaceTargetKey,
        )
      : null;
  $: summary = {
    total: exceptions.length,
    active: exceptions.filter((e) => e.status === "active-conflict").length,
    bareOnly: exceptions.filter((e) => e.status === "bare-only-active").length,
    subtypeOnly: exceptions.filter((e) => e.status === "subtypes-only-active")
      .length,
    residue: exceptions.filter((e) => e.status === "zero-residue").length,
  };
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

  function resetDraft(exception: SubtypeException, preferredTargetKey = "") {
    lastJan = exception.janCode;
    statusMessage = "";
    const subtypeNames = exception.subtyped.map(
      (row) => row.item.subtype || "",
    );
    allocations = subtypeNames.map((subtype, index) => ({
      subtype,
      qty: index === 0 ? String(exception.bare.qty) : "0",
    }));
    orderMoveTargets = {};
    exception.orders
      .filter((line) => line.itemKey === exception.bare.key)
      .forEach((line, index) => {
        orderMoveTargets[orderLineKey(line.orderID, index)] =
          subtypeNames[0] || "";
      });
    resetReplacementDraft(
      [exception.bare, ...exception.subtyped],
      preferredTargetKey,
      false,
    );
  }

  function makeBareKey(janCode: string): string {
    return janCode.trim();
  }

  function resetReplacementDraft(
    rows: { key: string; qty: number; shipped: number; onHand: number }[],
    preferredTargetKey = "",
    clearStatus = true,
  ) {
    lastJan = selectedJan;
    if (clearStatus) statusMessage = "";
    const candidates = rows.filter(
      (row) => row.key !== makeBareKey(selectedJan),
    );
    const target =
      candidates.find((row) => row.key === preferredTargetKey) ||
      candidates.find((row) => row.onHand > 0) ||
      candidates[0];
    const source =
      candidates.find(
        (row) =>
          row.key !== target?.key &&
          Math.abs(row.qty) <= 0.000001 &&
          Math.abs(row.shipped) <= 0.000001,
      ) || candidates.find((row) => row.key !== target?.key);
    replaceTargetKey = target?.key || "";
    replaceSourceKey = source?.key || "";
    replaceReason = "";
  }

  function orderLineKey(orderID: string, index: number): string {
    return `${orderID}:${index}`;
  }

  function fmtDate(ms: number): string {
    return ms > 0 ? new Date(ms).toLocaleString() : "Unknown";
  }

  function statusLabel(status: SubtypeException["status"]): string {
    if (status === "active-conflict") return "Active conflict";
    if (status === "bare-only-active") return "Bare active";
    if (status === "subtypes-only-active") return "Subtype active";
    return "Zero residue";
  }

  function selectException(janCode: string) {
    goto(`/subtype-exceptions?jan=${encodeURIComponent(janCode)}`);
  }

  function selectItemJan(item: Item) {
    const janCode = String(item?.janCode || "").trim();
    if (!janCode) return;
    search = "";
    selectException(janCode);
  }

  function openSearchJan() {
    const janCode = search.trim();
    if (!janCode) return;
    search = "";
    selectException(janCode);
  }

  function onSearchKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      openSearchJan();
    }
  }

  function addAllocation() {
    allocations = [...allocations, { subtype: "", qty: "0" }];
  }

  function removeAllocation(index: number) {
    allocations = allocations.filter((_, i) => i !== index);
  }

  function updateOrderTarget(key: string, subtype: string) {
    orderMoveTargets = { ...orderMoveTargets, [key]: subtype };
  }

  function broadcastAction(action: any): boolean {
    if (!$user?.uid) {
      statusMessage = "Sign in before saving changes.";
      return false;
    }
    broadcast(firestore, $user.uid, action);
    return true;
  }

  function commitSplit() {
    if (!current || !splitPreview || splitPreview.blocked) return;
    if (
      broadcastAction(
        resolve_subtype_exception({
          janCode: current.janCode,
          mode: "split_bare_to_subtypes",
          allocations: splitAllocations,
          orderMoves: splitOrderMoves,
          reason: "Subtype exception screen split bare JAN into subtype rows",
        }),
      )
    ) {
      statusMessage = "Split remediation committed.";
    }
  }

  function commitMerge() {
    if (!current) return;
    if (
      broadcastAction(
        resolve_subtype_exception({
          janCode: current.janCode,
          mode: "merge_subtypes_to_bare",
          reason: "Subtype exception screen merged subtype rows into bare JAN",
        }),
      )
    ) {
      statusMessage = "Merge remediation committed.";
    }
  }

  function commitReplaceSubtype() {
    if (!replacePreview || replacePreview.blocked) return;
    if (
      broadcastAction(
        replace_subtype({
          sourceKey: replaceSourceKey as any,
          targetKey: replaceTargetKey as any,
          reason:
            replaceReason.trim() ||
            "Subtype exception screen replaced one subtype with another",
        }),
      )
    ) {
      statusMessage = "Subtype replacement committed.";
    }
  }
</script>

<svelte:head>
  <title>Subtype Exceptions</title>
</svelte:head>

<section class="page">
  <header class="page-header">
    <div>
      <h1>Subtype Exceptions</h1>
      <p>JANs where a bare inventory key and subtype keys both exist.</p>
    </div>
    <div class="metrics">
      <div><strong>{summary.total}</strong><span>Total</span></div>
      <div><strong>{summary.active}</strong><span>Active</span></div>
      <div><strong>{summary.residue}</strong><span>Residue</span></div>
    </div>
  </header>

  <section class="toolbar">
    <label>
      Search item
      <input
        bind:value={search}
        placeholder="JAN, key, subtype, or description"
        on:keydown={onSearchKeydown}
      />
    </label>
    <button type="button" class="secondary" on:click={openSearchJan}>
      Open JAN
    </button>
  </section>

  {#if matches.length > 0}
    <div class="matches">
      {#each matches as [key, item]}
        <button type="button" on:click={() => selectItemJan(item)}>
          <strong>{key}</strong>
          <span>{item.description}</span>
        </button>
      {/each}
    </div>
  {/if}

  <div class="layout">
    <section class="list-panel" aria-label="Subtype exception list">
      <table>
        <thead>
          <tr>
            <th>JAN</th>
            <th>Status</th>
            <th>Bare</th>
            <th>Subtypes</th>
          </tr>
        </thead>
        <tbody>
          {#each exceptions as exception}
            <tr
              class:selected={current?.janCode === exception.janCode}
              on:click={() => selectException(exception.janCode)}
            >
              <td class="mono">{exception.janCode}</td>
              <td>
                <span class:danger={exception.status === "active-conflict"}>
                  {statusLabel(exception.status)}
                </span>
              </td>
              <td>{exception.bare.qty} / {exception.bare.shipped}</td>
              <td>
                {exception.subtyped
                  .map((row) => row.item.subtype || "(blank)")
                  .join(", ")}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>

    {#if selectedJan && currentRows.length > 0}
      <section class="detail-panel" aria-label="Subtype exception detail">
        <header class="detail-header">
          <div>
            <h2>{selectedJan}</h2>
            <p>
              {current ? statusLabel(current.status) : "Subtype replacement"}
            </p>
          </div>
          {#if current}
            <a href={`/itemhistory?itemKey=${current.bare.key}`}>Item history</a
            >
          {/if}
        </header>

        {#if statusMessage}
          <div class="status">{statusMessage}</div>
        {/if}

        <section class="block">
          <h3>Current Rows</h3>
          <table>
            <thead>
              <tr>
                <th>Image</th>
                <th>Key</th>
                <th>Subtype</th>
                <th>Qty</th>
                <th>Shipped</th>
                <th>On hand</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {#if current}
                <tr>
                  <td>
                    <div class="row-image">
                      {#if current.bare.item.image}
                        <ImageThumbnail
                          src={current.bare.item.image}
                          alt={current.bare.item.description ||
                            current.bare.key}
                          width="64px"
                          height="64px"
                          fit="contain"
                        />
                      {:else}
                        <span class="image-empty">No image</span>
                      {/if}
                    </div>
                  </td>
                  <td class="mono">{current.bare.key}</td>
                  <td>Bare</td>
                  <td>{current.bare.qty}</td>
                  <td>{current.bare.shipped}</td>
                  <td>{current.bare.onHand}</td>
                  <td>{current.bare.item.description}</td>
                </tr>
              {/if}
              {#each current ? current.subtyped : selectedJanRows as row}
                <tr>
                  <td>
                    <div class="row-image">
                      {#if row.item.image}
                        <ImageThumbnail
                          src={row.item.image}
                          alt={row.item.description || row.key}
                          width="64px"
                          height="64px"
                          fit="contain"
                        />
                      {:else}
                        <span class="image-empty">No image</span>
                      {/if}
                    </div>
                  </td>
                  <td class="mono">{row.key}</td>
                  <td>{row.item.subtype}</td>
                  <td>{row.qty}</td>
                  <td>{row.shipped}</td>
                  <td>{row.onHand}</td>
                  <td>{row.item.description}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </section>

        <section class="block">
          <h3>History</h3>
          <div class="history">
            {#each currentRows
              .flatMap( (row) => row.history.map( (entry) => ({ ...entry, key: row.key }), ), )
              .sort((a, b) => (a.val || 0) - (b.val || 0)) as entry}
              <div class="history-row">
                <span>{entry.date}</span>
                <span class="mono">{entry.key}</span>
                <span>{entry.desc}</span>
              </div>
            {/each}
          </div>
        </section>

        {#if current}
          <section class="block">
            <h3>Bare Order Lines</h3>
            {#if bareOrderLines.length === 0}
              <p>No order lines currently point at the bare JAN.</p>
            {:else}
              <table>
                <thead>
                  <tr>
                    <th>Order</th>
                    <th>Date</th>
                    <th>Qty</th>
                    <th>Move to subtype</th>
                  </tr>
                </thead>
                <tbody>
                  {#each bareOrderLines as line, index}
                    {@const key = orderLineKey(line.orderID, index)}
                    <tr>
                      <td class="mono">{line.orderID}</td>
                      <td>{fmtDate(line.date)}</td>
                      <td>{line.qty}</td>
                      <td>
                        <select
                          value={orderMoveTargets[key] ||
                            splitAllocations[0]?.subtype ||
                            ""}
                          on:change={(event) =>
                            updateOrderTarget(key, event.currentTarget.value)}
                        >
                          {#each splitAllocations as allocation}
                            <option value={allocation.subtype}>
                              {allocation.subtype || "(blank)"}
                            </option>
                          {/each}
                        </select>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {/if}
          </section>
        {/if}

        <section class="decision-grid">
          {#if current}
            <div class="decision">
              <h3>Split Bare Into Subtypes</h3>
              <div class="allocations">
                {#each allocations as allocation, index}
                  <div class="allocation">
                    <input
                      aria-label="Subtype"
                      placeholder="Subtype"
                      bind:value={allocation.subtype}
                    />
                    <input
                      aria-label="Quantity"
                      type="number"
                      step="1"
                      bind:value={allocation.qty}
                    />
                    <button
                      type="button"
                      on:click={() => removeAllocation(index)}
                    >
                      Remove
                    </button>
                  </div>
                {/each}
                <button type="button" on:click={addAllocation}
                  >Add subtype</button
                >
              </div>

              {#if splitPreview}
                {#if splitPreview.warnings.length}
                  <div class="warnings">
                    {#each splitPreview.warnings as warning}
                      <div>{warning}</div>
                    {/each}
                  </div>
                {/if}
                <table>
                  <thead>
                    <tr>
                      <th>Target</th>
                      <th>Add qty</th>
                      <th>Add shipped</th>
                      <th>Final</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each splitPreview.targets as target}
                      <tr>
                        <td class="mono">{target.key}</td>
                        <td>{target.addQty}</td>
                        <td>{target.addShipped}</td>
                        <td>{target.finalQty} / {target.finalShipped}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
                <button
                  class="primary"
                  type="button"
                  disabled={splitPreview.blocked}
                  on:click={commitSplit}
                >
                  Commit split
                </button>
              {/if}
            </div>

            <div class="decision">
              <h3>Merge Subtypes Back To Bare JAN</h3>
              {#if mergePreview}
                <p>
                  Final bare row: {mergePreview.finalQty} qty,
                  {mergePreview.finalShipped} shipped,
                  {mergePreview.finalOnHand} on hand.
                </p>
                <p>
                  Deletes {mergePreview.deletedKeys.length} subtype row(s) and moves
                  {mergePreview.movedOrderQty} ordered unit(s) to the bare JAN.
                </p>
                <ul>
                  {#each mergePreview.deletedKeys as key}
                    <li class="mono">{key}</li>
                  {/each}
                </ul>
                <button class="secondary" type="button" on:click={commitMerge}>
                  Commit merge
                </button>
              {/if}
            </div>
          {/if}

          {#if subtypeRows.length >= 2}
            <div class="decision">
              <h3>Replace One Subtype With Another</h3>
              <div class="replacement-controls">
                <label>
                  Source subtype
                  <select bind:value={replaceSourceKey}>
                    {#each subtypeRows as row}
                      <option value={row.key}
                        >{row.item.subtype || row.key}</option
                      >
                    {/each}
                  </select>
                </label>
                <label>
                  Replacement subtype
                  <select bind:value={replaceTargetKey}>
                    {#each subtypeRows as row}
                      <option value={row.key}
                        >{row.item.subtype || row.key}</option
                      >
                    {/each}
                  </select>
                </label>
                <label>
                  Reason
                  <input
                    value={replaceReason}
                    placeholder="e.g. Beige replaces Brown"
                    on:input={(event) =>
                      (replaceReason = event.currentTarget.value)}
                  />
                </label>
              </div>

              {#if replacePreview}
                {#if replacePreview.warnings.length}
                  <div class="warnings">
                    {#each replacePreview.warnings as warning}
                      <div>{warning}</div>
                    {/each}
                  </div>
                {/if}
                <p>
                  Retires {replacePreview.source?.key || "source"} and keeps
                  {replacePreview.target?.key || "target"} as the active row.
                </p>
                <p>
                  Ignores {replacePreview.sourceArchiveSaleQty} archived sale unit(s)
                  on the source and {replacePreview.targetUnpricedReceiptQty}
                  zero-cost recount unit(s) on the replacement.
                </p>
                <button
                  class="secondary"
                  type="button"
                  disabled={replacePreview.blocked}
                  on:click={commitReplaceSubtype}
                >
                  Commit replacement
                </button>
              {/if}
            </div>
          {/if}
        </section>
      </section>
    {:else}
      <section class="empty">
        Select an exception to inspect its history and remediation previews.
      </section>
    {/if}
  </div>
</section>

<style>
  .page {
    padding: 1.5rem;
  }

  .page-header,
  .detail-header,
  .toolbar,
  .layout,
  .decision-grid,
  .allocation,
  .metrics {
    display: flex;
    gap: 1rem;
  }

  .page-header,
  .detail-header {
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 1rem;
  }

  .toolbar {
    flex-wrap: wrap;
    align-items: flex-end;
    margin-bottom: 0.75rem;
  }

  .toolbar label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    color: #334155;
    font-size: 0.85rem;
  }

  .toolbar input {
    min-width: 22rem;
  }

  .matches {
    max-width: 56rem;
    border: 1px solid #d7dde5;
    border-radius: 6px;
    margin-bottom: 1rem;
    overflow: hidden;
  }

  .matches button {
    display: flex;
    gap: 0.75rem;
    width: 100%;
    padding: 0.45rem 0.6rem;
    border: 0;
    border-bottom: 1px solid #e4e8ee;
    border-radius: 0;
    background: #fff;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }

  .matches button:hover {
    background: #f6f8fa;
  }

  h1,
  h2,
  h3,
  p {
    margin-top: 0;
  }

  .metrics > div {
    min-width: 88px;
    padding: 0.75rem;
    border: 1px solid #d7dde5;
    border-radius: 6px;
    background: #f8fafc;
  }

  .metrics strong,
  .metrics span {
    display: block;
  }

  .layout {
    align-items: flex-start;
  }

  .list-panel {
    flex: 0 0 38%;
    max-height: calc(100vh - 170px);
    overflow: auto;
  }

  .detail-panel,
  .empty {
    flex: 1;
    min-width: 0;
  }

  .block,
  .decision,
  .empty {
    margin-bottom: 1rem;
    padding: 1rem;
    border: 1px solid #d7dde5;
    border-radius: 6px;
    background: #fff;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.9rem;
  }

  th,
  td {
    border-bottom: 1px solid #e4e8ee;
    padding: 0.5rem;
    text-align: left;
    vertical-align: top;
  }

  tbody tr {
    cursor: pointer;
  }

  tbody tr:hover,
  tr.selected {
    background: #eef6ff;
  }

  .mono {
    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
      "Courier New", monospace;
    font-size: 0.85em;
  }

  .row-image {
    width: 64px;
    height: 64px;
  }

  .image-empty {
    display: grid;
    place-items: center;
    width: 64px;
    height: 64px;
    border: 1px dashed #cbd5e1;
    border-radius: 6px;
    color: #64748b;
    font-size: 0.75rem;
    text-align: center;
  }

  .danger {
    color: #b42318;
    font-weight: 700;
  }

  .history {
    max-height: 260px;
    overflow: auto;
    border: 1px solid #e4e8ee;
    border-radius: 6px;
  }

  .history-row {
    display: grid;
    grid-template-columns: 150px minmax(160px, 0.7fr) 1fr;
    gap: 0.75rem;
    padding: 0.45rem 0.6rem;
    border-bottom: 1px solid #eef1f5;
    font-size: 0.85rem;
  }

  .decision-grid {
    align-items: stretch;
  }

  .decision {
    flex: 1;
  }

  .allocations {
    display: grid;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .replacement-controls {
    display: grid;
    gap: 0.65rem;
    margin-bottom: 0.75rem;
  }

  .replacement-controls label {
    display: grid;
    gap: 0.25rem;
    color: #334155;
    font-size: 0.85rem;
  }

  .allocation {
    align-items: center;
  }

  input,
  select,
  button {
    min-height: 34px;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    padding: 0.35rem 0.55rem;
    font: inherit;
  }

  input[type="number"] {
    width: 90px;
  }

  button {
    cursor: pointer;
    background: #f8fafc;
  }

  button.primary {
    background: #14532d;
    color: white;
    border-color: #14532d;
  }

  button.secondary {
    background: #334155;
    color: white;
    border-color: #334155;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .warnings,
  .status {
    margin: 0.75rem 0;
    padding: 0.75rem;
    border: 1px solid #facc15;
    border-radius: 6px;
    background: #fefce8;
  }

  @media (max-width: 1100px) {
    .layout,
    .decision-grid,
    .page-header {
      flex-direction: column;
    }

    .list-panel {
      flex-basis: auto;
      width: 100%;
      max-height: none;
    }
  }
</style>
