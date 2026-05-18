<script lang="ts">
  import { page } from "$app/stores";
  import { store } from "$lib/store";
  import { user } from "$lib/user-store";
  import { firestore } from "$lib/firebase";
  import { broadcast } from "$lib/redux-firestore";
  import { set_stock_order_meta } from "$lib/inventory";
  import {
    set_stock_order_cost_paste,
    commit_stock_order_costs,
  } from "$lib/stock-order-cost-slice";
  import {
    selectOrderExceptions,
    previewOrderMetaFix,
    computeStockOrderCostCommit,
    type OrderExceptionRow,
  } from "$lib/order-exceptions";

  $: orderId = $page.url.searchParams.get("orderId");
  $: rows = selectOrderExceptions($store.inventory);
  $: exceptions = rows.filter((r) => r.isException);
  $: current = orderId ? rows.find((r) => r.orderId === orderId) : undefined;

  let statusMessage = "";

  // --- detail form state ---
  let dateStr = "";
  let goodsJpy = "";
  let orderJpy = "";
  let paidAmount = "";
  let paidCurrency: "EUR" | "BGN" = "EUR";

  let costPaste = "";
  let overrideExisting = false;
  let approveDiscrepancy = false;

  $: stagedPaste = current
    ? ($store.stockOrderCost?.byOrder?.[current.orderId]?.rawPaste ?? "")
    : "";
  $: costPreview =
    current && stagedPaste
      ? computeStockOrderCostCommit({
          rawPaste: stagedPaste,
          orderId: current.orderId,
          overrideExisting,
          inventory: $store.inventory,
        })
      : null;
  $: commitBlocked =
    !costPreview ||
    !costPreview.reconciliation.chosen ||
    costPreview.reconciliation.rows.length === 0 ||
    (!costPreview.reconciliation.reconciled &&
      costPreview.reconciliation.discrepancy != null &&
      !approveDiscrepancy) ||
    (costPreview.matched.some((m) => m.isOverride) && !overrideExisting);

  let lastLoadedOrder = "";
  $: if (current && current.orderId !== lastLoadedOrder) {
    lastLoadedOrder = current.orderId;
    costPaste = "";
    overrideExisting = false;
    approveDiscrepancy = false;
    dateStr =
      current.receivedAt && current.receivedAt > 0
        ? new Date(current.receivedAt).toISOString().slice(0, 10)
        : "";
    goodsJpy = current.valueOfGoodsJpy?.toString() ?? "";
    orderJpy = current.valueOfOrderJpy?.toString() ?? "";
    paidAmount = current.paidAmount?.toString() ?? "";
    paidCurrency = current.paidCurrency ?? "EUR";
  }

  function num(s: string): number | undefined {
    const n = Number(String(s).replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) && s.trim() !== "" ? n : undefined;
  }

  $: proposedDateMeta = (() => {
    if (!dateStr) return null;
    const ms = Date.parse(dateStr + "T00:00:00Z");
    return Number.isFinite(ms) ? { receivedAt: ms } : null;
  })();

  $: proposedMoneyMeta = (() => {
    const m: any = {};
    const g = num(goodsJpy);
    const o = num(orderJpy);
    const p = num(paidAmount);
    if (g != null) m.valueOfGoodsJpy = g;
    if (o != null) m.valueOfOrderJpy = o;
    if (p != null) {
      m.paidAmount = p;
      m.paidCurrency = paidCurrency;
    }
    return Object.keys(m).length ? m : null;
  })();

  $: datePreview =
    current && proposedDateMeta
      ? previewOrderMetaFix($store.inventory, current.orderId, proposedDateMeta)
      : null;
  $: moneyPreview =
    current && proposedMoneyMeta
      ? previewOrderMetaFix(
          $store.inventory,
          current.orderId,
          proposedMoneyMeta,
        )
      : null;

  function broadcastAction(action: any): boolean {
    if (!$user?.uid) {
      statusMessage = "Sign in before saving changes.";
      return false;
    }
    broadcast(firestore, $user.uid, action);
    return true;
  }

  function commitDate() {
    if (!current || !proposedDateMeta) return;
    if (
      broadcastAction(
        set_stock_order_meta({
          orderId: current.orderId,
          meta: proposedDateMeta,
        }),
      )
    )
      statusMessage = "Receipt date saved.";
  }

  function commitMoney() {
    if (!current || !proposedMoneyMeta) return;
    if (
      broadcastAction(
        set_stock_order_meta({
          orderId: current.orderId,
          meta: proposedMoneyMeta,
        }),
      )
    )
      statusMessage = "Order money facts saved.";
  }

  function stageCostPaste() {
    if (!current) return;
    broadcastAction(
      set_stock_order_cost_paste({
        orderId: current.orderId,
        rawPaste: costPaste,
      }),
    );
  }

  function commitCosts() {
    if (!current || commitBlocked) return;
    if (
      broadcastAction(
        commit_stock_order_costs({
          orderId: current.orderId,
          overrideExisting,
          approveDiscrepancy,
        }),
      )
    )
      statusMessage = "Costs applied from invoice TSV.";
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

  <section>
    <h2>1. Receipt date</h2>
    <input type="date" bind:value={dateStr} />
    {#if datePreview}
      <p class="preview">
        {datePreview.affectedLots} lot(s) from this order move to {dateStr};
        {datePreview.items.length} item(s) re-derive cost.
      </p>
      {#if datePreview.items.length}
        <table class="mini">
          <thead><tr><th>Item</th><th>Cost ¥ old→new</th></tr></thead>
          <tbody>
            {#each datePreview.items as it (it.key)}
              <tr
                ><td>{it.key}</td><td
                  >{fmt(it.oldCostJpy)} → {fmt(it.newCostJpy)}</td
                ></tr
              >
            {/each}
          </tbody>
        </table>
      {/if}
    {/if}
    <button on:click={commitDate} disabled={!proposedDateMeta}>
      Commit receipt date
    </button>
  </section>

  <section>
    <h2>2. Order money facts</h2>
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
    {#if moneyPreview}
      <p class="preview">
        fx = {fmt(moneyPreview.fx, 6)} €/¥ · {moneyPreview.affectedLots} lot(s) re-priced
        in EUR.
      </p>
      {#if moneyPreview.items.length}
        <table class="mini">
          <thead><tr><th>Item</th><th>EUR cost old→new</th></tr></thead>
          <tbody>
            {#each moneyPreview.items as it (it.key)}
              <tr
                ><td>{it.key}</td><td
                  >{fmt(it.oldCostEur, 4)} → {fmt(it.newCostEur, 4)}</td
                ></tr
              >
            {/each}
          </tbody>
        </table>
      {/if}
    {/if}
    <button on:click={commitMoney} disabled={!proposedMoneyMeta}>
      Commit money facts
    </button>
  </section>

  <section>
    <h2>3. Missing costs — paste invoice TSV (JPY)</h2>
    <p class="hint">
      Paste the supplier invoice (tab-separated). Value of goods ¥{fmt(
        current.valueOfGoodsJpy,
        0,
      )} is the reconciliation target — set it in section 2 first if unknown.
    </p>
    <textarea
      bind:value={costPaste}
      rows="6"
      placeholder="JAN code&#9;UNIT PRICE (YEN)&#9;Quantity&#9;TOTAL (YEN)"
    ></textarea>
    <button on:click={stageCostPaste} disabled={!costPaste.trim()}>
      Preview
    </button>

    {#if costPreview}
      {@const rc = costPreview.reconciliation}
      <div class="preview">
        {#if !rc.chosen}
          <p class="bad">
            Could not resolve the invoice columns (JAN + quantity + a
            cost/total). Check the paste.
          </p>
        {:else}
          <p>
            Interpretation: <strong>{rc.chosen.label}</strong> ({rc.chosen
              .kind}) · Σ {fmt(rc.chosen.sum, 0)} ¥ vs goods {fmt(
              current.valueOfGoodsJpy,
              0,
            )} ¥ ·
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
              <span class="bad">value of goods unknown</span>
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
            {costPreview.matched.length} lot(s) priced ·
            {costPreview.unmatchedJans.length} TSV row(s) with no lot in this order
            ·
            {costPreview.matched.filter((m) => m.isOverride).length} override existing
          </p>
          {#if costPreview.matched.length}
            <table class="mini">
              <thead
                ><tr><th>Item</th><th>Qty</th><th>¥ old→new</th><th></th></tr
                ></thead
              >
              <tbody>
                {#each costPreview.matched as m (m.key)}
                  <tr>
                    <td>{m.key}</td><td>{m.qty}</td>
                    <td>{fmt(m.oldUnitJpy, 0)} → {fmt(m.newUnitJpy, 0)}</td>
                    <td>{m.isOverride ? "override" : ""}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
          {#if costPreview.unmatchedJans.length}
            <p class="hint">
              Unmatched: {costPreview.unmatchedJans.join(", ")}
            </p>
          {/if}
        {/if}
      </div>

      <label class="chk">
        <input type="checkbox" bind:checked={overrideExisting} />
        Override lots that already have a cost
      </label>
      {#if !rc.reconciled && rc.discrepancy != null}
        <label class="chk">
          <input type="checkbox" bind:checked={approveDiscrepancy} />
          Approve despite {rc.discrepancy > 0 ? "+" : ""}{fmt(
            rc.discrepancy,
            0,
          )} ¥ discrepancy
        </label>
      {/if}
      <button on:click={commitCosts} disabled={commitBlocked}>
        Commit costs
      </button>
    {/if}
  </section>
{/if}

<style>
  h1 {
    font-size: 1.4rem;
    margin: 1rem 0;
  }
  h2 {
    font-size: 1.1rem;
    margin: 0.5rem 0;
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
