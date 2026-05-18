<script lang="ts">
  import { page } from "$app/stores";
  import { goto } from "$app/navigation";
  import { store } from "$lib/store";
  import { user } from "$lib/user-store";
  import { firestore } from "$lib/firebase";
  import { broadcast } from "$lib/redux-firestore";
  import { set_stock_order_meta } from "$lib/inventory";
  import {
    selectOrderExceptions,
    previewOrderMetaFix,
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

  <section class="todo">
    <h2>3. Missing costs (TSV paste)</h2>
    <p>Coming next (M3.4): paste the invoice TSV to fill unpriced lots.</p>
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
  section.todo {
    opacity: 0.6;
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
