<script lang="ts">
  import { page } from "$app/stores";
  import { store } from "$lib/store";
  import { user } from "$lib/user-store";
  import { firestore } from "$lib/firebase";
  import { broadcast } from "$lib/redux-firestore";
  import {
    receiptStart,
    receiptOrderId,
    receiptLine,
    receiptConfirm,
    receiptFacts,
    receiptRefresh,
    receiptComplete,
    type OrderReceipt,
    type ReceiptDecision,
    type ReceiptFacts,
    type ReceiptRow,
  } from "$lib/order-receipts";
  import type { CustomsReport } from "$lib/customs-summary-model";

  let busy = false,
    error = "",
    message = "",
    search = "";
  let showConfirmed = false;
  let selected: string[] = [];
  let editJan = "";
  let editRevision = -1;
  let factsEditRevision = -1;
  let draft: ReceiptDecision;
  let facts: ReceiptFacts;
  let factsKey = "";
  $: receipts = Object.values(
    $store.orderReceipts?.orders || {},
  ) as OrderReceipt[];
  $: reports = Object.values(
    $store.customsSummary?.reports || {},
  ) as CustomsReport[];
  $: report = reports.find(
    (r) => r.id === $page.url.searchParams.get("reportId"),
  );
  $: id =
    $page.url.searchParams.get("orderId") ||
    (report ? receiptOrderId(report) : "");
  $: receipt = receipts.find((r) => r.id === id);
  $: currentReport = receipt
    ? report && receiptOrderId(report) === receipt.id
      ? report
      : reports.find((r) => r.id === receipt.reportId)
    : undefined;
  $: projection = receipt?.projection;
  $: if (
    receipt &&
    factsEditRevision < 0 &&
    factsKey !== JSON.stringify([receipt.id, receipt.facts])
  ) {
    facts = structuredClone(receipt.facts);
    factsKey = JSON.stringify([receipt.id, receipt.facts]);
  }
  $: unsavedFacts =
    receipt && facts && JSON.stringify(facts) !== JSON.stringify(receipt.facts);
  $: rows = (projection?.rows || []).filter(
    (r) =>
      (showConfirmed || !r.confirmed) &&
      (r.jan + " " + r.description)
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()),
  );
  $: selected = selected.filter((jan) => rows.some((r) => r.jan === jan));
  $: eligible = rows.filter((r) => !r.confirmed && r.matches.length <= 1);
  $: editedRow = projection?.rows.find((r) => r.jan === editJan);
  const money = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "—");
  async function send(action: any) {
    if (!$user?.uid) throw Error("Sign in first.");
    const ref = await broadcast(firestore, $user.uid, action);
    if (!ref) throw Error("Could not save the receipt.");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(
          Error(
            "Saved, but still waiting for receipt replay. Wait before retrying.",
          ),
        );
      }, 20000);
      const unsubscribe = store.subscribe(() => {
        const results = store.getState().orderReceipts?.results || {};
        if (Object.prototype.hasOwnProperty.call(results, ref.id)) {
          clearTimeout(timer);
          queueMicrotask(() => unsubscribe());
          results[ref.id] ? reject(Error(results[ref.id])) : resolve();
        }
      });
    });
  }
  async function work(fn: () => Promise<void>) {
    busy = true;
    error = "";
    message = "";
    try {
      await fn();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
  function edit(row: ReceiptRow) {
    editJan = row.jan;
    editRevision = receipt!.revision;
    draft = structuredClone(receipt!.decisions[row.jan] || row.defaultDecision);
  }
  async function saveLine() {
    if (!receipt || !draft) return;
    await work(async () => {
      await send(
        receiptLine({
          orderId: receipt!.id,
          revision: editRevision,
          jan: editJan,
          decision: draft,
        }),
      );
      editJan = "";
      message = "Count and destination saved.";
    });
  }
  async function confirm(jans: string[]) {
    if (!receipt) return;
    await work(async () => {
      await send(
        receiptConfirm({
          orderId: receipt!.id,
          revision: receipt!.revision,
          jans,
        }),
      );
      selected = [];
      message = "Selected counts and quality confirmed.";
    });
  }
  async function saveFacts() {
    if (!receipt) return;
    await work(async () => {
      await send(
        receiptFacts({
          orderId: receipt!.id,
          revision:
            factsEditRevision < 0 ? receipt!.revision : factsEditRevision,
          facts,
        }),
      );
      factsEditRevision = -1;
      message = "Receipt and payment details saved.";
    });
  }
  async function complete() {
    if (!receipt) return;
    await work(async () => {
      await send(
        receiptComplete({ orderId: receipt!.id, revision: receipt!.revision }),
      );
      message =
        "Receipt completed. Accepted inventory and company-use goods have been recorded.";
    });
  }
</script>

<svelte:head><title>Receive order · Dobutsu</title></svelte:head>
<main>
  <h1>Receive order</h1>
  <p>
    Confirm what arrived and passed inspection. Stock changes only when you
    complete the receipt.
  </p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  {#if !$store.inventory.initialized}<p role="status">
      Loading saved orders…
    </p>{/if}
  {#if !receipt}
    {#if report?.input && !report.abandoned}
      <section>
        <h2>{report.name} — {report.projection.invoice}</h2>
        <p>
          {report.projection.totals.pieces} expected pieces. Start a saved receipt
          from these customs sources.
        </p>
        <button
          class="primary"
          disabled={busy || !$store.inventory.initialized}
          on:click={() =>
            work(() =>
              send(
                receiptStart({
                  reportId: report.id,
                  reportRevision: report.revision,
                }),
              ),
            )}>Start receiving</button
        >
      </section>
    {:else}
      <section>
        <h2>Choose a customs order</h2>
        {#each reports.filter((r) => r.input && !r.abandoned) as r}
          <p>
            <a href={"/order-receipt?reportId=" + encodeURIComponent(r.id)}
              >{r.name} — {r.projection.invoice}</a
            >
          </p>
        {/each}
        <a href="/customs-summary">Prepare or open customs reports</a>
      </section>
    {/if}
    {#if receipts.length}<section>
        <h2>Saved receipts</h2>
        {#each receipts as r}<p>
            <a href={"/order-receipt?orderId=" + encodeURIComponent(r.id)}
              >{r.source.name} — {r.source.projection.invoice} — {r.completed
                ? "Completed"
                : "In progress"}</a
            >
          </p>{/each}
      </section>{/if}
  {:else if projection}
    <h2>{receipt.source.name} — {receipt.source.projection.invoice}</h2>
    <p>
      <a href="/customs-summary">Customs reports</a> ·
      <a href="/order-receipt">All receipts</a>
    </p>
    {#if receipt.completed}
      <section class="complete">
        <h2>Receipt completed</h2>
        <p>
          {new Date(receipt.completed.at).toLocaleString()} · {projection.inventoryQty}
          units added to inventory · {projection.assetQty} company-use units recorded.
        </p>
        <p>
          Accepted value: ¥{money(projection.acceptedJpy)} / €{money(
            projection.acceptedEur,
          )}. Receipt date: {receipt.facts.date}.
        </p>
        <p>
          This receipt cannot be posted again. Corrections or later deliveries
          require a reviewed adjustment; do not re-import the original order.
        </p>
        <p>
          <a href="/shopify-listings"
            >Review Shopify quantities and publish resale stock</a
          >
          · <a href="/inventory-value">Inventory valuation</a>
        </p>
      </section>
    {:else if currentReport && (currentReport.id !== receipt.reportId || currentReport.revision !== receipt.sourceRevision || currentReport.abandoned)}
      <section>
        <p class="error">
          The customs source changed. Refreshing clears the saved line review.
        </p>
        <button
          disabled={busy || currentReport.abandoned}
          on:click={() =>
            work(async () => {
              await send(
                receiptRefresh({
                  orderId: receipt.id,
                  revision: receipt.revision,
                  reportId: currentReport.id,
                  reportRevision: currentReport.revision,
                }),
              );
              editJan = "";
            })}>Refresh source and clear line review</button
        >
      </section>
    {/if}
    <section>
      <h2>Count and inspect</h2>
      <p>
        Counts are in supplier units matching the packs you sell. Items with an
        old loose-piece setting switch to whole packs on completion when their
        available stock is zero.
      </p>
      <label
        >Filter products <input
          type="search"
          bind:value={search}
          placeholder="Name or JAN"
        /></label
      >
      <label class="check">
        <input type="checkbox" bind:checked={showConfirmed} />
        Show confirmed rows
      </label>
      {#if !receipt.completed}
        <button
          disabled={busy || !!editJan}
          on:click={() => (selected = eligible.map((r) => r.jan))}
          >Select all {eligible.length} unreviewed, unambiguous rows shown</button
        >
        <button
          disabled={busy || !!editJan || !selected.length}
          on:click={() => confirm(selected)}
          >Confirm {selected.length} selected counts and quality correct</button
        >
      {/if}
      <div class="scroll">
        <table>
          <thead
            ><tr
              ><th>Select</th><th>Product</th><th>Expected</th><th
                >Received / rejected</th
              ><th>Accepted</th><th>Unit ¥</th><th>Review</th></tr
            ></thead
          ><tbody>
            {#each rows as row (row.jan)}
              <tr>
                <td
                  >{#if !receipt.completed && !row.confirmed && row.matches.length <= 1}<input
                      aria-label={"Select " + row.jan}
                      type="checkbox"
                      value={row.jan}
                      bind:group={selected}
                      disabled={busy || !!editJan}
                    />{/if}</td
                >
                <td
                  ><strong>{row.description}</strong><br /><small
                    >{row.jan}</small
                  ></td
                >
                <td>{row.expected}</td><td
                  >{row.confirmed
                    ? row.received + " / " + row.rejected
                    : "—"}</td
                ><td>{row.confirmed ? row.accepted : "—"}</td><td
                  >{money(row.unitJpy)}</td
                >
                <td
                  >{#if receipt.completed}Recorded{:else}
                    {row.confirmed ? "Confirmed" : "Unreviewed"}
                    <button
                      disabled={busy || (!!editJan && editJan !== row.jan)}
                      on:click={() => edit(row)}>Review {row.jan}</button
                    >
                    {#if !row.confirmed && row.matches.length <= 1}<button
                        disabled={busy || !!editJan}
                        on:click={() => confirm([row.jan])}
                        >Correct {row.jan}</button
                      >{/if}
                  {/if}
                  {#if receipt.decisions[row.jan]?.note}<p>
                      {receipt.decisions[row.jan].note}
                    </p>{/if}
                </td>
              </tr>
            {:else}
              <tr
                ><td colspan="7"
                  >No rows to review with these filters. Show confirmed rows to
                  review saved counts.</td
                ></tr
              >
            {/each}
          </tbody>
        </table>
      </div>
      {#if editedRow && draft && !receipt.completed}
        <fieldset disabled={busy}>
          <legend>Inspect {editedRow.description} ({editedRow.jan})</legend>
          <label
            >Actual received <input
              inputmode="numeric"
              bind:value={draft.received}
            /></label
          >
          <label
            >Rejected or damaged <input
              inputmode="numeric"
              bind:value={draft.rejected}
            /></label
          >
          <label
            >Discrepancy / destination note <input
              bind:value={draft.note}
            /></label
          >
          <p>
            Allocate received minus rejected units below. Use more than one
            allocation for different variants or mixed company use.
          </p>
          {#each draft.allocations as allocation, i}
            <div class="allocation">
              <label
                >Destination <select bind:value={allocation.destination}
                  ><option value="inventory">Resale inventory</option><option
                    value="asset">Company use / asset</option
                  ></select
                ></label
              >
              <label
                >Allocated units <input
                  inputmode="numeric"
                  bind:value={allocation.qty}
                /></label
              >
              {#if allocation.destination === "inventory"}
                <label
                  >Inventory variant <select bind:value={allocation.itemKey}
                    ><option value="">Create new inventory identity</option
                    >{#each editedRow.matches as match}<option value={match.id}
                        >{match.subtype || "Default"} — {match.id} ({match.available}
                        available)</option
                      >{/each}</select
                  ></label
                >
                {#if !allocation.itemKey}<label
                    >New subtype (blank only for a new JAN) <input
                      bind:value={allocation.subtype}
                    /></label
                  >{/if}
              {/if}
              <button
                on:click={() =>
                  (draft.allocations = draft.allocations.filter(
                    (_, n) => n !== i,
                  ))}>Remove allocation</button
              >
            </div>
          {/each}
          <button
            on:click={() =>
              (draft.allocations = [
                ...draft.allocations,
                {
                  destination: "inventory",
                  itemKey: "",
                  subtype: "",
                  qty: "0",
                },
              ])}>Add allocation</button
          >
          <button class="primary" on:click={saveLine}
            >Save inspected line</button
          ><button on:click={() => (editJan = "")}>Cancel line edit</button>
        </fieldset>
      {/if}
    </section>
    <section>
      <h2>Receipt, invoice and payment</h2>
      <p>
        Original source: {projection.expected} pieces. Keep the invoice values unchanged
        if goods are missing or rejected; accepted value is calculated separately.
      </p>
      <fieldset
        disabled={busy || !!receipt.completed}
        on:input={() => {
          if (factsEditRevision < 0) factsEditRevision = receipt.revision;
        }}
        on:change={() => {
          if (factsEditRevision < 0) factsEditRevision = receipt.revision;
        }}
      >
        <label>Receipt date <input type="date" bind:value={facts.date} /></label
        >
        <label
          >Goods value JPY <input
            inputmode="decimal"
            bind:value={facts.goodsJpy}
          /></label
        >
        <label
          >Invoice total JPY <input
            inputmode="decimal"
            bind:value={facts.invoiceJpy}
          /></label
        >
        <label
          >Expected invoice pieces <input
            inputmode="numeric"
            bind:value={facts.expectedPieces}
          /></label
        >
        <label
          >Actual paid amount <input
            inputmode="decimal"
            bind:value={facts.paidAmount}
          /></label
        >
        <label
          >Payment currency <select bind:value={facts.paidCurrency}
            ><option>EUR</option><option>BGN</option></select
          ></label
        >
        <label
          >Shipping date (optional) <input
            type="date"
            bind:value={facts.shippedDate}
          /></label
        >
        <label
          >Shipping cost (zero if none) <input
            inputmode="decimal"
            bind:value={facts.shippingAmount}
          /></label
        >
        <label
          >Shipping currency <select bind:value={facts.shippingCurrency}
            ><option>JPY</option><option>EUR</option><option>BGN</option
            ></select
          ></label
        >
        <label class="check"
          ><input type="checkbox" bind:checked={facts.shippingIncluded} /> Shipping
          is included in the invoice total</label
        >
        <p>
          Shipping is recorded separately. This version keeps the existing
          supplier unit-cost/exchange calculation and does not allocate extra
          freight to unit costs.
        </p>
        <details>
          <summary>Optional invoice cost TSV</summary>
          <p>
            Source unit costs are used by default. Paste original JAN, piece
            quantity and JPY unit/line-cost columns only to supply corrected
            costs; they must reconcile to the invoice.
          </p>
          <label class="wide"
            >Invoice cost rows <textarea
              rows="5"
              bind:value={facts.costTsv}
            /></label
          >
          <label class="check"
            ><input
              type="checkbox"
              checked={!!facts.costInterpretation}
              on:change={(e) =>
                (facts.costInterpretation = e.currentTarget.checked
                  ? { kind: "unit", costColumnIndex: 2, qtyColumnIndex: 1 }
                  : undefined)}
            /> Specify cost columns manually</label
          >
          {#if facts.costInterpretation}<p>
              Column numbers start at 0 (A = 0, B = 1).
            </p>
            <label
              >Cost interpretation <select
                bind:value={facts.costInterpretation.kind}
                ><option value="unit">Unit cost</option><option value="total"
                  >Line total</option
                ></select
              ></label
            >
            <label
              >Cost column <select
                bind:value={facts.costInterpretation.costColumnIndex}
                >{#each projection.costColumns as column}<option
                    value={column.index}>{column.label}</option
                  >{/each}</select
              ></label
            >
            <label
              >Quantity column <select
                bind:value={facts.costInterpretation.qtyColumnIndex}
                >{#each projection.costColumns as column}<option
                    value={column.index}>{column.label}</option
                  >{/each}</select
              ></label
            >
          {/if}
        </details>
        <label class="check"
          ><input type="checkbox" bind:checked={facts.unitsConfirmed} /> I checked
          that source pieces match the inventory selling units.</label
        >
        <label class="check"
          ><input type="checkbox" bind:checked={facts.stockNotEntered} /> I checked
          the history: this delivery has not already been added to inventory.</label
        >
        {#if !receipt.completed}<button class="primary" on:click={saveFacts}
            >Save receipt and payment details</button
          ><button
            on:click={() => {
              factsEditRevision = -1;
              facts = structuredClone(receipt.facts);
              factsKey = JSON.stringify([receipt.id, receipt.facts]);
            }}>Reload saved payment details</button
          >{/if}
      </fieldset>
    </section>
    <section>
      <h2>Acceptance preview</h2>
      {#if projection.packResets?.length}
        <p>
          These out-of-stock items will switch from the old loose-piece setting
          to whole packs when this receipt is completed (one received unit = one
          sellable pack): {projection.packResets.join(", ")}.
        </p>
      {/if}
      <p>
        {projection.received} received · {projection.rejected} rejected · {projection.accepted}
        accepted
      </p>
      <p>
        {projection.inventoryQty} resale inventory units · {projection.assetQty} company-use
        units
      </p>
      <p>
        Accepted value: ¥{money(projection.acceptedJpy)} / €{money(
          projection.acceptedEur,
        )} · € per ¥: {projection.fx.toFixed(6)}
      </p>
      {#if projection.stock.length}<div class="scroll">
          <table>
            <thead
              ><tr
                ><th>Inventory item</th><th>Add units</th><th
                  >{receipt.completed
                    ? "Posted"
                    : "Available after receipt"}</th
                ></tr
              ></thead
            ><tbody
              >{#each projection.stock as u}<tr
                  ><td>{u.key}</td><td>{u.added}</td><td
                    >{receipt.completed ? "Recorded" : u.after}</td
                  ></tr
                >{/each}</tbody
            >
          </table>
        </div>{/if}
      {#if projection.assets.length}<h3>Company-use acceptance register</h3>
        <div class="scroll">
          <table>
            <thead
              ><tr
                ><th>Product</th><th>Units</th><th>Unit ¥ / €</th><th
                  >Receipt date</th
                ></tr
              ></thead
            ><tbody
              >{#each projection.assets as asset}<tr
                  ><td>{asset.description} ({asset.jan})</td><td>{asset.qty}</td
                  ><td>{money(asset.unitJpy)} / {money(asset.unitEur)}</td><td
                    >{asset.date}</td
                  ></tr
                >{/each}</tbody
            >
          </table>
        </div>{/if}
      {#if !receipt.completed}
        {#if unsavedFacts}<p class="error">
            Save your changed receipt/payment details before completing.
          </p>{/if}
        {#if projection.issues.length}<details open>
            <summary>{projection.issues.length} checks to resolve</summary>
            <ul>
              {#each projection.issues as issue}<li>{issue}</li>{/each}
            </ul>
          </details>{/if}
        <button
          class="primary"
          disabled={busy ||
            !$store.inventory.initialized ||
            !!editJan ||
            unsavedFacts ||
            projection.issues.length > 0}
          on:click={complete}>Complete receipt and post accepted goods</button
        >
      {/if}
    </section>
  {/if}
  {#if busy}<p role="status">Saving and checking the receipt…</p>{/if}
</main>

<style>
  main {
    max-width: 1500px;
    margin: auto;
    padding: 1.5rem;
    background: #f8fafc;
    color: #1e293b;
    line-height: 1.5;
  }
  h1 {
    margin-top: 0;
  }
  h2 {
    font-size: 1.25rem;
  }
  h3 {
    font-size: 1.05rem;
  }
  section {
    background: white;
    border: 1px solid #e2e8f0;
    border-radius: 12px;
    padding: 1.25rem;
    margin: 1rem 0;
  }
  fieldset {
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    padding: 1rem;
    min-width: 0;
  }
  label {
    display: inline-flex;
    flex-direction: column;
    gap: 0.35rem;
    margin: 0.5rem;
    max-width: 100%;
    font-size: 0.9rem;
  }
  input,
  select,
  textarea {
    font: inherit;
    padding: 0.55rem;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    background: white;
    color: inherit;
    max-width: 100%;
    box-sizing: border-box;
  }
  input[type="checkbox"] {
    width: 1.1rem;
    height: 1.1rem;
  }
  .check {
    display: flex;
    flex-direction: row;
    align-items: center;
  }
  .wide {
    display: flex;
  }
  button {
    font: inherit;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    padding: 0.55rem 0.8rem;
    margin: 0.3rem;
    background: white;
    color: #334155;
    cursor: pointer;
  }
  button.primary {
    background: var(--primary-color, #0056b3);
    color: white;
    border-color: transparent;
  }
  button:disabled,
  fieldset:disabled {
    opacity: 0.55;
    cursor: default;
  }
  input:focus-visible,
  select:focus-visible,
  textarea:focus-visible,
  button:focus-visible,
  a:focus-visible {
    outline: 2px solid #0056b3;
    outline-offset: 2px;
  }
  .scroll {
    overflow: auto;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.9rem;
  }
  th,
  td {
    text-align: left;
    border-bottom: 1px solid #e2e8f0;
    padding: 0.65rem;
    vertical-align: top;
  }
  th {
    background: #f1f5f9;
  }
  small {
    color: #64748b;
  }
  .error {
    color: #b91c1c;
    white-space: pre-line;
  }
  .complete {
    border-color: #86efac;
    background: #f0fdf4;
  }
  .allocation {
    border-bottom: 1px solid #e2e8f0;
    padding: 0.5rem 0;
  }
</style>
