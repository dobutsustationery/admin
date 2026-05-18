<script lang="ts">
  import { page } from "$app/stores";
  import { store } from "$lib/store";
  import { user } from "$lib/user-store";
  import { firestore } from "$lib/firebase";
  import { broadcast } from "$lib/redux-firestore";
  import { fix_stock_order, type StockOrderMeta } from "$lib/inventory";
  import {
    selectOrderExceptions,
    previewStockOrderFix,
    type OrderExceptionRow,
  } from "$lib/order-exceptions";

  $: orderId = $page.url.searchParams.get("orderId");
  $: rows = selectOrderExceptions($store.inventory);
  $: exceptions = rows.filter((r) => r.isException);
  $: current = orderId ? rows.find((r) => r.orderId === orderId) : undefined;

  let statusMessage = "";

  // One atomic edit: all fields feed a single proposed fix.
  let dateStr = "";
  let goodsJpy = "";
  let orderJpy = "";
  let paidAmount = "";
  let paidCurrency: "EUR" | "BGN" = "EUR";
  let costPaste = "";
  let overrideExisting = false;
  let approveDiscrepancy = false;

  let lastLoadedOrder = "";
  $: if (current && current.orderId !== lastLoadedOrder) {
    lastLoadedOrder = current.orderId;
    dateStr =
      current.receivedAt && current.receivedAt > 0
        ? new Date(current.receivedAt).toISOString().slice(0, 10)
        : "";
    goodsJpy = current.valueOfGoodsJpy?.toString() ?? "";
    orderJpy = current.valueOfOrderJpy?.toString() ?? "";
    paidAmount = current.paidAmount?.toString() ?? "";
    paidCurrency = current.paidCurrency ?? "EUR";
    costPaste = "";
    overrideExisting = false;
    approveDiscrepancy = false;
  }

  function num(s: string): number | undefined {
    const n = Number(String(s).replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) && s.trim() !== "" ? n : undefined;
  }

  $: proposedMeta = (() => {
    const m: StockOrderMeta = {};
    if (dateStr) {
      const ms = Date.parse(dateStr + "T00:00:00Z");
      if (Number.isFinite(ms)) m.receivedAt = ms;
    }
    const g = num(goodsJpy);
    const o = num(orderJpy);
    const p = num(paidAmount);
    if (g != null) m.valueOfGoodsJpy = g;
    if (o != null) m.valueOfOrderJpy = o;
    if (p != null) {
      m.paidAmount = p;
      m.paidCurrency = paidCurrency;
    }
    return m;
  })();

  $: hasMeta = Object.values(proposedMeta).some((v) => v !== undefined);
  $: fixPreview = current
    ? previewStockOrderFix($store.inventory, current.orderId, {
        meta: proposedMeta,
        rawPaste: costPaste,
        overrideExisting,
        approveDiscrepancy,
      })
    : null;
  $: nothingToDo = !hasMeta && !costPaste.trim();
  $: commitDisabled = !fixPreview || nothingToDo || fixPreview.blocked;

  function broadcastAction(action: any): boolean {
    if (!$user?.uid) {
      statusMessage = "Sign in before saving changes.";
      return false;
    }
    broadcast(firestore, $user.uid, action);
    return true;
  }

  function commitFix() {
    if (!current || commitDisabled) return;
    if (
      broadcastAction(
        fix_stock_order({
          orderId: current.orderId,
          meta: proposedMeta,
          costTsv: costPaste.trim() ? costPaste : undefined,
          overrideExisting,
          approveDiscrepancy,
        }),
      )
    )
      statusMessage = "Order fix committed.";
  }

  function fmt(n: number | undefined, digits = 2): string {
    return n == null ? "—" : Number(n).toFixed(digits);
  }
  function dateLabel(r: OrderExceptionRow): string {
    return r.flags.dateUnknown
      ? "⚠ unknown"
      : new Date(r.receivedAt as number).toISOString().slice(0, 10);
  }
</script>

<svelte:head><title>Order Exceptions</title></svelte:head>

{#if !current}
  <h1>Order Exceptions</h1>
  {#if statusMessage}<p class="status">{statusMessage}</p>{/if}
  {#if exceptions.length === 0}
    <p class="all-clear">✓ All stock orders are complete — no exceptions.</p>
  {:else}
    <table>
      <thead>
        <tr>
          <th>Order</th><th>Receipt date</th><th>Goods ¥</th>
          <th>Order ¥</th><th>Paid €</th><th>Lots</th><th>Needs cost</th>
          <th>Gaps</th><th></th>
        </tr>
      </thead>
      <tbody>
        {#each exceptions as r (r.orderId)}
          <tr>
            <td>{r.name}</td>
            <td class:warn={r.flags.dateUnknown}>{dateLabel(r)}</td>
            <td class:warn={r.flags.goodsValueUnknown}
              >{fmt(r.valueOfGoodsJpy, 0)}</td
            >
            <td class:warn={r.flags.orderValueUnknown}
              >{fmt(r.valueOfOrderJpy, 0)}</td
            >
            <td class:warn={r.flags.paidUnknown}>{fmt(r.totalOrderEur)}</td>
            <td>{r.lotCount}</td>
            <td class:warn={r.flags.needsCost}>{r.unpricedCount}</td>
            <td>
              {[
                r.flags.dateUnknown && "date",
                r.flags.goodsValueUnknown && "goods",
                r.flags.orderValueUnknown && "order",
                r.flags.paidUnknown && "paid",
                r.flags.needsCost && "cost",
              ]
                .filter(Boolean)
                .join(", ")}
            </td>
            <td>
              <a
                href={`/order-exceptions?orderId=${encodeURIComponent(r.orderId)}`}
                >Fix Order →</a
              >
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
{:else}
  <a class="back" href="/order-exceptions">← All exceptions</a>
  <h1>Fix Order: {current.name}</h1>
  {#if statusMessage}<p class="status">{statusMessage}</p>{/if}
  <p class="hint">
    Fill any of the fields below — receipt date, the money facts, and/or the
    invoice cost TSV — then commit once. They apply together as a single atomic
    change; order does not matter (the TSV reconciles against the value of goods
    you enter here).
  </p>

  <section>
    <h2>Receipt date</h2>
    <input type="date" bind:value={dateStr} />

    <h2>Money facts (JPY) + paid amount</h2>
    <label>Value of goods (¥)<input bind:value={goodsJpy} /></label>
    <label
      >Value of order (¥, incl. shipping/tax)<input
        bind:value={orderJpy}
      /></label
    >
    <label>
      Order paid
      <input bind:value={paidAmount} />
      <select bind:value={paidCurrency}>
        <option value="EUR">EUR</option>
        <option value="BGN">BGN (lev)</option>
      </select>
    </label>

    <h2>Missing costs — paste invoice TSV (JPY)</h2>
    <textarea
      bind:value={costPaste}
      rows="6"
      placeholder="JAN code&#9;UNIT PRICE (YEN)&#9;Quantity&#9;TOTAL (YEN)"
    ></textarea>
  </section>

  {#if fixPreview}
    {@const rc = fixPreview.reconciliation}
    <section>
      <h2>Preview — net effect of this one commit</h2>
      <p class="preview">
        {#if fixPreview.fx > 0}
          exchange = {fmt(fixPreview.fx, 6)} €/¥
        {:else}
          exchange not set (EUR pending)
        {/if}
        · {fixPreview.affectedLots} lot(s) in this order ·
        {fixPreview.items.length} item(s) re-derive cost.
      </p>

      {#if rc}
        {#if !rc.chosen}
          <p class="bad">
            Could not resolve the invoice columns (JAN + quantity + a
            cost/total). Check the paste.
          </p>
        {:else}
          <p>
            Invoice interpretation: <strong>{rc.chosen.label}</strong> ({rc
              .chosen.kind}) · Σ {fmt(rc.chosen.sum, 0)} ¥ vs goods {goodsJpy ||
              fmt(current.valueOfGoodsJpy, 0)} ¥ ·
            {#if rc.reconciled}
              <span class="ok">reconciled ✓</span>
            {:else if rc.discrepancy != null}
              <span class="bad"
                >discrepancy {rc.discrepancy > 0 ? "+" : ""}{fmt(
                  rc.discrepancy,
                  0,
                )} ¥</span
              >
            {:else}
              <span class="bad">enter value of goods to reconcile</span>
            {/if}
          </p>
          {#if rc.candidates.length > 1}
            <p class="hint">
              Candidates: {rc.candidates
                .map((c) => `${c.label}=${fmt(c.sum, 0)}`)
                .join(" · ")}
            </p>
          {/if}
          <p>
            {fixPreview.matched.length} lot(s) priced from TSV ·
            {fixPreview.unmatchedJans.length} TSV row(s) with no lot in this order
            ·
            {fixPreview.matched.filter((m) => m.isOverride).length} override existing
          </p>
          {#if fixPreview.unmatchedJans.length}
            <p class="hint">
              Unmatched: {fixPreview.unmatchedJans.join(", ")}
            </p>
          {/if}
          {#if fixPreview.matched.some((m) => m.isOverride)}
            <label class="chk">
              <input type="checkbox" bind:checked={overrideExisting} />
              Override lots that already have a cost
            </label>
          {/if}
          {#if !rc.reconciled && rc.discrepancy != null}
            <label class="chk">
              <input type="checkbox" bind:checked={approveDiscrepancy} />
              Approve despite {rc.discrepancy > 0 ? "+" : ""}{fmt(
                rc.discrepancy,
                0,
              )} ¥ discrepancy
            </label>
          {/if}
        {/if}
      {/if}

      {#if fixPreview.items.length}
        {@const eurKnown = fixPreview.fx > 0}
        {#if !eurKnown}
          <p class="hint">
            EUR cost is pending — it is computed only once <em
              >Value of order</em
            >
            and <em>Order paid</em> are entered (exchange = paid ÷ value of order).
            The JPY repricing below is final.
          </p>
        {/if}
        <table class="mini">
          <thead>
            <tr>
              <th>Item</th><th>cost ¥ old→new</th>
              <th>cost € old→new</th>
            </tr>
          </thead>
          <tbody>
            {#each fixPreview.items as it (it.key)}
              <tr>
                <td>{it.key}</td>
                <td>{fmt(it.oldCostJpy)} → {fmt(it.newCostJpy)}</td>
                <td>
                  {#if eurKnown}
                    {fmt(it.oldCostEur, 4)} → {fmt(it.newCostEur, 4)}
                  {:else}
                    <span class="hint">pending exchange</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}

      <button on:click={commitFix} disabled={commitDisabled}>
        Commit all fixes
      </button>
      {#if nothingToDo}
        <p class="hint">Enter at least one field above.</p>
      {/if}
    </section>
  {/if}
{/if}

<style>
  h1 {
    font-size: 1.4rem;
    margin: 1rem 0;
  }
  h2 {
    font-size: 1.1rem;
    margin: 0.8rem 0 0.3rem;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 1rem 0;
  }
  th,
  td {
    border: 1px solid #dee2e6;
    padding: 0.4rem 0.6rem;
    text-align: left;
    font-size: 0.9rem;
  }
  .mini {
    width: auto;
  }
  .warn {
    background: #fff3cd;
    color: #856404;
    font-weight: 600;
  }
  .all-clear {
    color: #155724;
    background: #d4edda;
    padding: 1rem;
    border-radius: 4px;
  }
  .status {
    color: #155724;
  }
  .preview {
    background: #e7f3ff;
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
  }
  section {
    border: 1px solid #dee2e6;
    border-radius: 6px;
    padding: 1rem;
    margin: 1rem 0;
  }
  textarea {
    width: 100%;
    font-family: monospace;
    font-size: 0.85rem;
  }
  .hint {
    color: #666;
    font-size: 0.85rem;
  }
  .ok {
    color: #155724;
    font-weight: 600;
  }
  .bad {
    color: #842029;
    font-weight: 600;
  }
  .chk {
    display: block;
    margin: 0.3rem 0;
  }
  .chk input {
    margin-right: 0.4rem;
  }
  label {
    display: block;
    margin: 0.4rem 0;
  }
  label input,
  label select {
    margin-left: 0.5rem;
  }
  button {
    margin-top: 0.5rem;
    padding: 0.4rem 0.9rem;
  }
  .back {
    font-size: 0.85rem;
  }
  a {
    color: #0066cc;
  }
</style>
